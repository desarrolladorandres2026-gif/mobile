import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { normalizeCenter, requireCostCenters } from '../core/dims.js';
import { vatRatesFor } from '../countries/index.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { TaxError, computeLine, computeTotals } from '../invoicing/tax.js';

export const MAX_LINES = 200;
export const MAX_PAGE = 50;
export const MAX_CATCH_UP = 12;
export const MAX_TEMPLATES_PER_RUN = 200;
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
export const PAYMENT_METHODS = ['cash', 'credit'];

export class CommercialError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'CommercialError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new CommercialError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const text = (value, label, { required = false, max = 500 } = {}) => {
  const clean = String(value ?? '').trim();
  if (required && !clean) fail(`falta ${label}`);
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean || undefined;
};
const objectId = (value, label) => (/^[a-f0-9]{24}$/.test(String(value ?? '')) ? new ObjectId(String(value)) : fail(`${label} inválido`));
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

/**
 * La fecha siguiente de una plantilla recurrente. Mensual, trimestral y anual conservan el día de inicio (`anchorDay`):
 * una plantilla que empezó un 31 sigue el 30 de abril, el 28 o 29 de febrero, y vuelve al 31 en mayo.
 */
export function nextOccurrence(date, frequency, anchorDay) {
  if (frequency === 'weekly') return addDays(date, 7);
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  if (!months) throw new CommercialError('la frecuencia no es válida');
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay), 12));
}

/*
 * Documentos comerciales que todavía no son contabilidad: cotizaciones de venta, órdenes de compra y facturas recurrentes.
 * Ninguno asienta nada por sí mismo; lo hacen la factura o la compra a las que se convierten, con sus controles de siempre.
 *
 *  - Cotización: oferta a un cliente con vigencia. Se acepta, se rechaza, se anula o se convierte en factura. Vencida no se
 *    convierte. Una cotización nunca reserva existencias ni precio: al facturar valen las reglas de la factura.
 *  - Orden de compra: pedido a un proveedor. Se anula o se recibe, que la convierte en la factura de compra con el número
 *    de la factura del proveedor. Recibirla no es recibir mercancía parcial: es todo el pedido.
 *  - Factura recurrente: una plantilla con frecuencia y próxima fecha. «Generar» emite las facturas vencidas (hasta 12
 *    períodos por plantilla), cada una con una clave de idempotencia derivada de la plantilla y la fecha: repetir la
 *    generación, o dos personas a la vez, no emite dos veces el mismo período. Si una factura falla, la plantilla se detiene
 *    en ese período y dice por qué; se corrige o se salta.
 *  - La conversión de cotización y de orden es idempotente por documento: la factura o la compra se emiten con una clave
 *    derivada del id, y el documento pasa por un estado intermedio mientras se emite, de modo que un fallo se puede reintentar.
 */
export function createCommercialService({ db, invoicing, purchases, parties, now = () => new Date() }) {
  const quotesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.quotes), tenantId);
  const ordersOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.purchaseOrders), tenantId);
  const recurringOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.recurringInvoices), tenantId);
  const countersOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.docCounters), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const todayStart = () => parseCalendarDay(dayOf(now()), 'hoy', fail);

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1, currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  async function nextNumber(tenantId, kind) {
    const counter = await countersOf(tenantId).findOneAndUpdate({ kind }, { $inc: { last: 1 } }, { upsert: true, returnDocument: 'after' });
    return counter.last;
  }

  async function requireParty(tenantId, id, role, label) {
    const party = await parties.get(tenantId, id);
    if (!party) fail(`el ${label} no existe`, 'NOT_FOUND');
    if (!party.active) fail(`el ${label} está inactivo`);
    if (!party.roles.includes(role)) fail(`el tercero elegido no está registrado como ${label}`);
    return party;
  }

  const snapshot = (party) => ({ partyId: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId });

  /**
   * Líneas de un documento comercial: se calculan con las mismas reglas de la factura. Cada línea trae descripción,
   * cantidad (milésimas), precio y, si se quiere, descuento, tarifa de IVA, artículo, cuenta y centro de costo.
   */
  async function prepareLines(tenantId, raw, { country, accountRequired }) {
    if (!Array.isArray(raw) || raw.length === 0) fail('agrega al menos una línea');
    if (raw.length > MAX_LINES) fail(`un documento admite como máximo ${MAX_LINES} líneas`);
    const rates = vatRatesFor(country);
    const lines = raw.map((l, i) => {
      const where = `línea ${i + 1}`;
      const description = text(l?.description, `la descripción de la ${where}`, { required: true, max: 200 });
      const vatBps = l.vatBps ?? 0;
      if (rates && !rates.includes(vatBps)) fail(`${where}: la tarifa de IVA ${vatBps / 100} % no existe en el país`);
      const accountId = String(l?.accountId ?? '').trim();
      if (accountId && !/^[0-9]{1,12}$/.test(accountId)) fail(`${where}: la cuenta debe ser numérica`);
      if (accountRequired && !accountId && !l?.itemId) fail(`${where}: indica la cuenta del gasto, costo o activo, o un artículo`);
      const costCenter = normalizeCenter(l?.costCenter);
      try {
        const computed = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBps: l.discountBps ?? 0, vatBps });
        return {
          description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountBps: l.discountBps ?? 0,
          vatBps,
          ...(accountId ? { accountId } : {}),
          ...(l.itemId ? { itemId: objectId(l.itemId, `${where}: el artículo`) } : {}),
          ...(l.itemId && l.warehouseId ? { warehouseId: objectId(l.warehouseId, `${where}: la bodega`) } : {}),
          ...(costCenter ? { costCenter } : {}),
          ...computed,
        };
      } catch (err) {
        if (err instanceof TaxError) fail(`${where}: ${err.message}`);
        throw err;
      }
    });
    await requireCostCenters(db, tenantId, lines.map((l) => l.costCenter), fail);
    const totals = computeTotals(lines);
    if (totals.total <= 0) fail('el total debe ser mayor que cero');
    return { lines, totals };
  }

  /** Las líneas tal como las pide la factura o la compra al convertir el documento. */
  const asDocumentLines = (lines) =>
    lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      ...(l.discountBps ? { discountBps: l.discountBps } : {}),
      vatBps: l.vatBps,
      ...(l.accountId ? { accountId: l.accountId } : {}),
      ...(l.itemId ? { itemId: String(l.itemId) } : {}),
      ...(l.warehouseId ? { warehouseId: String(l.warehouseId) } : {}),
      ...(l.costCenter ? { costCenter: l.costCenter } : {}),
    }));

  const pageOf = async (collection, tenantId, filter, { limit = 25, cursor } = {}, present = (d) => d) => {
    const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
    const rows = await collection(tenantId)
      .find({ ...filter, ...(cursor ? { _id: { $lt: objectId(cursor, 'el cursor') } } : {}) }, { sort: { _id: -1 }, limit: size + 1 })
      .toArray();
    const hasMore = rows.length > size;
    const items = hasMore ? rows.slice(0, size) : rows;
    return { items: items.map(present), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
  };

  /**
   * Pasa un documento a un estado intermedio mientras se emite lo que lo convierte, y lo deja en el final o lo devuelve a
   * como estaba si la emisión falla. Dos conversiones a la vez usan la misma clave de idempotencia de la factura o la compra.
   */
  async function convert(collection, tenantId, id, { from, during, to, label, run }) {
    const claimed = await collection(tenantId).findOneAndUpdate({ _id: id, status: { $in: [...from, during] } }, { $set: { status: during } }, { returnDocument: 'before' });
    if (!claimed) {
      const exists = await collection(tenantId).findOne({ _id: id });
      if (!exists) fail(`${label} no existe`, 'NOT_FOUND');
      fail(`${label} está ${exists.status === to ? 'convertida' : exists.status}: ya no se puede convertir`, 'INVALID_STATE');
    }
    const previous = claimed.status === during ? (claimed.statusBefore ?? from[0]) : claimed.status;
    if (claimed.status !== during) await collection(tenantId).updateOne({ _id: id }, { $set: { statusBefore: previous } });
    try {
      const result = await run(claimed);
      await collection(tenantId).updateOne({ _id: id }, { $set: { status: to, ...result.set }, $unset: { statusBefore: '' } });
      return result;
    } catch (err) {
      await collection(tenantId).updateOne({ _id: id, status: during }, { $set: { status: previous } });
      throw err;
    }
  }

  const presentQuote = (q) => (q ? { ...q, expired: q.status === 'open' && q.validUntil < todayStart() } : q);

  const api = {
    // ---- Cotizaciones ----

    async createQuote(tenantId, input, ctx = {}) {
      const tenant = await tenantInfo(tenantId);
      const customer = await requireParty(tenantId, input.customerId, 'customer', 'cliente');
      const issueDate = input.issueDate ? parseDay(input.issueDate, 'la fecha de la cotización') : todayStart();
      const validUntil = parseDay(input.validUntil, 'la fecha de vigencia');
      if (validUntil < issueDate) fail('la vigencia no puede ser anterior a la cotización');
      const { lines, totals } = await prepareLines(tenantId, input.lines, { country: tenant.country, accountRequired: false });
      const number = await nextNumber(tenantId, 'quote');
      const doc = {
        number,
        fullNumber: `COT-${number}`,
        status: 'open',
        customer: snapshot(customer),
        issueDate,
        validUntil,
        currency: tenant.currency,
        ...(text(input.notes, 'las notas') ? { notes: text(input.notes, 'las notas') } : {}),
        lines,
        totals,
        createdBy: ctx.userId ?? null,
        createdAt: now(),
      };
      const { insertedId } = await quotesOf(tenantId).insertOne({ ...doc });
      await ctx.auditTx?.(undefined, { action: 'quote.create', target: insertedId, details: { number: doc.fullNumber, total: totals.total } });
      return presentQuote({ ...doc, _id: insertedId, tenantId });
    },

    async getQuote(tenantId, id) {
      return presentQuote(await quotesOf(tenantId).findOne({ _id: objectId(id, 'la cotización') }));
    },

    async listQuotes(tenantId, { customerId, status, ...page } = {}) {
      const filter = { ...(customerId ? { 'customer.partyId': objectId(customerId, 'el cliente') } : {}), ...(status ? { status: String(status) } : {}) };
      return pageOf(quotesOf, tenantId, filter, page, presentQuote);
    },

    /** Acepta, rechaza o anula una cotización abierta (o acepta una rechazada si el cliente cambió de opinión). */
    async setQuoteStatus(tenantId, id, action, ctx = {}) {
      const next = { accept: 'accepted', reject: 'rejected', void: 'void' }[action];
      if (!next) fail('la acción no es válida');
      const from = { accepted: ['open', 'rejected'], rejected: ['open', 'accepted'], void: ['open', 'accepted', 'rejected'] }[next];
      const quote = await quotesOf(tenantId).findOne({ _id: objectId(id, 'la cotización') });
      if (!quote) fail('la cotización no existe', 'NOT_FOUND');
      if (next === 'accepted' && presentQuote(quote).expired) fail('la cotización venció', 'INVALID_STATE');
      const res = await quotesOf(tenantId).updateOne({ _id: quote._id, status: { $in: from } }, { $set: { status: next, statusAt: now(), statusBy: ctx.userId ?? null } });
      if (res.matchedCount === 0) fail(`la cotización está ${quote.status}: no se puede ${{ accept: 'aceptar', reject: 'rechazar', void: 'anular' }[action]}`, 'INVALID_STATE');
      await ctx.auditTx?.(undefined, { action: `quote.${action}`, target: quote._id, details: { number: quote.fullNumber } });
      return presentQuote(await quotesOf(tenantId).findOne({ _id: quote._id }));
    },

    /** Convierte la cotización en factura. `input`: paymentMethod, issueDate?, dueDate?. Repetirla devuelve la misma factura. */
    async invoiceQuote(tenantId, id, input, ctx = {}) {
      const _id = objectId(id, 'la cotización');
      const quote = await quotesOf(tenantId).findOne({ _id });
      if (!quote) fail('la cotización no existe', 'NOT_FOUND');
      if (presentQuote(quote).expired) fail('la cotización venció: crea una nueva', 'INVALID_STATE');
      if (!PAYMENT_METHODS.includes(input.paymentMethod)) fail('la forma de pago debe ser contado o crédito');
      const issueDate = input.issueDate ? parseDay(input.issueDate, 'la fecha de emisión') : todayStart();
      let outcome;
      await convert(quotesOf, tenantId, _id, {
        from: ['open', 'accepted'],
        during: 'invoicing',
        to: 'invoiced',
        label: 'la cotización',
        run: async () => {
          outcome = await invoicing.issueInvoice(
            tenantId,
            {
              customerId: String(quote.customer.partyId),
              issueDate: dayOf(issueDate),
              paymentMethod: input.paymentMethod,
              ...(input.dueDate ? { dueDate: input.dueDate } : {}),
              notes: `Según cotización ${quote.fullNumber}${quote.notes ? `. ${quote.notes}` : ''}`.slice(0, 500),
              lines: asDocumentLines(quote.lines),
            },
            { ...ctx, idempotencyKey: `quote-${_id}` },
          );
          if (outcome.rejected) fail('el proveedor de facturación rechazó la factura: revisa los datos y vuelve a intentarlo', 'INVALID_STATE');
          return { set: { invoiceId: outcome.invoice._id, invoiceNumber: outcome.invoice.fullNumber ?? null, invoicedAt: now() } };
        },
      });
      await ctx.auditTx?.(undefined, { action: 'quote.invoice', target: _id, details: { number: quote.fullNumber, invoice: outcome.invoice.fullNumber ?? null } });
      return { quote: presentQuote(await quotesOf(tenantId).findOne({ _id })), invoice: outcome.invoice, pending: Boolean(outcome.pending) };
    },

    // ---- Órdenes de compra ----

    async createOrder(tenantId, input, ctx = {}) {
      const tenant = await tenantInfo(tenantId);
      const supplier = await requireParty(tenantId, input.supplierId, 'supplier', 'proveedor');
      const issueDate = input.issueDate ? parseDay(input.issueDate, 'la fecha de la orden') : todayStart();
      const expectedDate = input.expectedDate ? parseDay(input.expectedDate, 'la fecha esperada') : undefined;
      if (expectedDate && expectedDate < issueDate) fail('la fecha esperada no puede ser anterior a la orden');
      const { lines, totals } = await prepareLines(tenantId, input.lines, { country: tenant.country, accountRequired: true });
      const number = await nextNumber(tenantId, 'order');
      const doc = {
        number,
        fullNumber: `OC-${number}`,
        status: 'open',
        supplier: snapshot(supplier),
        issueDate,
        ...(expectedDate ? { expectedDate } : {}),
        currency: tenant.currency,
        ...(text(input.notes, 'las notas') ? { notes: text(input.notes, 'las notas') } : {}),
        lines,
        totals,
        createdBy: ctx.userId ?? null,
        createdAt: now(),
      };
      const { insertedId } = await ordersOf(tenantId).insertOne({ ...doc });
      await ctx.auditTx?.(undefined, { action: 'purchase_order.create', target: insertedId, details: { number: doc.fullNumber, total: totals.total } });
      return { ...doc, _id: insertedId, tenantId };
    },

    async getOrder(tenantId, id) {
      return ordersOf(tenantId).findOne({ _id: objectId(id, 'la orden') });
    },

    async listOrders(tenantId, { supplierId, status, ...page } = {}) {
      const filter = { ...(supplierId ? { 'supplier.partyId': objectId(supplierId, 'el proveedor') } : {}), ...(status ? { status: String(status) } : {}) };
      return pageOf(ordersOf, tenantId, filter, page);
    },

    async voidOrder(tenantId, id, ctx = {}) {
      const order = await ordersOf(tenantId).findOne({ _id: objectId(id, 'la orden') });
      if (!order) fail('la orden no existe', 'NOT_FOUND');
      const res = await ordersOf(tenantId).updateOne({ _id: order._id, status: 'open' }, { $set: { status: 'void', statusAt: now(), statusBy: ctx.userId ?? null } });
      if (res.matchedCount === 0) fail(`la orden está ${order.status}: no se puede anular`, 'INVALID_STATE');
      await ctx.auditTx?.(undefined, { action: 'purchase_order.void', target: order._id, details: { number: order.fullNumber } });
      return ordersOf(tenantId).findOne({ _id: order._id });
    },

    /** Recibe la orden: la convierte en la factura de compra con el número que trae la factura del proveedor. */
    async receiveOrder(tenantId, id, input, ctx = {}) {
      const _id = objectId(id, 'la orden');
      const order = await ordersOf(tenantId).findOne({ _id });
      if (!order) fail('la orden no existe', 'NOT_FOUND');
      const supplierDocNumber = text(input.supplierDocNumber, 'el número de la factura del proveedor', { required: true, max: 40 });
      const issueDate = input.issueDate ? parseDay(input.issueDate, 'la fecha de la factura') : todayStart();
      let outcome;
      await convert(ordersOf, tenantId, _id, {
        from: ['open'],
        during: 'receiving',
        to: 'received',
        label: 'la orden',
        run: async () => {
          outcome = await purchases.createPurchase(
            tenantId,
            {
              supplierId: String(order.supplier.partyId),
              supplierDocNumber,
              issueDate: dayOf(issueDate),
              ...(input.dueDate ? { dueDate: input.dueDate } : {}),
              notes: `Según orden ${order.fullNumber}${order.notes ? `. ${order.notes}` : ''}`.slice(0, 500),
              lines: asDocumentLines(order.lines),
            },
            { ...ctx, idempotencyKey: `po-${_id}` },
          );
          return { set: { purchaseId: outcome.purchase._id, purchaseNumber: outcome.purchase.fullNumber, receivedAt: now() } };
        },
      });
      await ctx.auditTx?.(undefined, { action: 'purchase_order.receive', target: _id, details: { number: order.fullNumber, purchase: outcome.purchase.fullNumber } });
      return { order: await ordersOf(tenantId).findOne({ _id }), purchase: outcome.purchase };
    },

    // ---- Facturas recurrentes ----

    async createRecurring(tenantId, input, ctx = {}) {
      const tenant = await tenantInfo(tenantId);
      const customer = await requireParty(tenantId, input.customerId, 'customer', 'cliente');
      const name = text(input.name, 'el nombre de la plantilla', { required: true, max: 100 });
      if (!FREQUENCIES.includes(input.frequency)) fail('la frecuencia es semanal, mensual, trimestral o anual');
      if (!PAYMENT_METHODS.includes(input.paymentMethod)) fail('la forma de pago debe ser contado o crédito');
      const startDate = parseDay(input.startDate, 'la fecha de inicio');
      const endDate = input.endDate ? parseDay(input.endDate, 'la fecha final') : undefined;
      if (endDate && endDate < startDate) fail('la fecha final no puede ser anterior al inicio');
      const dueDays = input.dueDays ?? 0;
      if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) fail('los días de plazo van de 0 a 365');
      if (input.paymentMethod === 'credit' && dueDays === 0) fail('una venta a crédito necesita días de plazo');
      const { lines, totals } = await prepareLines(tenantId, input.lines, { country: tenant.country, accountRequired: false });
      const doc = {
        name,
        active: true,
        customer: snapshot(customer),
        frequency: input.frequency,
        anchorDay: startDate.getUTCDate(),
        startDate,
        ...(endDate ? { endDate } : {}),
        nextDate: startDate,
        paymentMethod: input.paymentMethod,
        dueDays,
        currency: tenant.currency,
        ...(text(input.notes, 'las notas') ? { notes: text(input.notes, 'las notas') } : {}),
        lines,
        totals,
        runCount: 0,
        createdBy: ctx.userId ?? null,
        createdAt: now(),
      };
      const { insertedId } = await recurringOf(tenantId).insertOne({ ...doc });
      await ctx.auditTx?.(undefined, { action: 'recurring.create', target: insertedId, details: { name, frequency: doc.frequency } });
      return { ...doc, _id: insertedId, tenantId };
    },

    async getRecurring(tenantId, id) {
      return recurringOf(tenantId).findOne({ _id: objectId(id, 'la plantilla') });
    },

    async listRecurring(tenantId, { active, ...page } = {}) {
      return pageOf(recurringOf, tenantId, active === undefined ? {} : { active: active === true || active === 'true' }, page);
    },

    /** Pausa o reanuda una plantilla, o cambia su fecha final o sus notas. */
    async updateRecurring(tenantId, id, input, ctx = {}) {
      const template = await recurringOf(tenantId).findOne({ _id: objectId(id, 'la plantilla') });
      if (!template) fail('la plantilla no existe', 'NOT_FOUND');
      const set = {};
      const unset = {};
      if (input.active !== undefined) set.active = Boolean(input.active);
      if (input.endDate !== undefined) {
        if (input.endDate === '') unset.endDate = '';
        else {
          const endDate = parseDay(input.endDate, 'la fecha final');
          if (endDate < template.startDate) fail('la fecha final no puede ser anterior al inicio');
          set.endDate = endDate;
        }
      }
      if (input.notes !== undefined) {
        const notes = text(input.notes, 'las notas');
        if (notes) set.notes = notes;
        else unset.notes = '';
      }
      if (!Object.keys(set).length && !Object.keys(unset).length) fail('no hay nada que cambiar');
      await recurringOf(tenantId).updateOne({ _id: template._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      await ctx.auditTx?.(undefined, { action: 'recurring.update', target: template._id, details: { name: template.name, ...(set.active !== undefined ? { active: set.active } : {}) } });
      return recurringOf(tenantId).findOne({ _id: template._id });
    },

    /** Salta el período pendiente de una plantilla sin emitir factura (por ejemplo, tras un rechazo que se resolvió a mano). */
    async skipRecurring(tenantId, id, ctx = {}) {
      const template = await recurringOf(tenantId).findOne({ _id: objectId(id, 'la plantilla') });
      if (!template) fail('la plantilla no existe', 'NOT_FOUND');
      const next = nextOccurrence(template.nextDate, template.frequency, template.anchorDay);
      const res = await recurringOf(tenantId).updateOne({ _id: template._id, nextDate: template.nextDate }, { $set: { nextDate: next }, $unset: { lastError: '' } });
      if (res.matchedCount === 0) fail('la plantilla cambió mientras se saltaba: vuelve a intentarlo', 'INVALID_STATE');
      await ctx.auditTx?.(undefined, { action: 'recurring.skip', target: template._id, details: { name: template.name, skipped: dayOf(template.nextDate) } });
      return recurringOf(tenantId).findOne({ _id: template._id });
    },

    /**
     * Emite las facturas vencidas de las plantillas activas hasta `asOf` (hoy por omisión). Una plantilla que falla se
     * detiene en ese período con su error; las demás siguen. Devuelve lo emitido y lo fallido.
     */
    async runRecurring(tenantId, { asOf, templateId } = {}, ctx = {}) {
      const limit = asOf ? parseDay(asOf, 'la fecha') : todayStart();
      if (limit.getTime() > now().getTime() + DAY_MS) fail('no se generan facturas con fecha futura');
      const filter = { active: true, nextDate: { $lte: limit }, ...(templateId ? { _id: objectId(templateId, 'la plantilla') } : {}) };
      const templates = await recurringOf(tenantId).find(filter, { sort: { nextDate: 1 }, limit: MAX_TEMPLATES_PER_RUN }).toArray();
      const generated = [];
      const failed = [];
      for (const template of templates) {
        let current = template;
        for (let n = 0; n < MAX_CATCH_UP && current.nextDate <= limit; n += 1) {
          if (current.endDate && current.nextDate > current.endDate) {
            await recurringOf(tenantId).updateOne({ _id: template._id, nextDate: current.nextDate }, { $set: { active: false, finishedAt: now() } });
            break;
          }
          const date = current.nextDate;
          const dueDate = current.paymentMethod === 'credit' ? dayOf(addDays(date, current.dueDays)) : undefined;
          let result;
          try {
            result = await invoicing.issueInvoice(
              tenantId,
              {
                customerId: String(current.customer.partyId),
                issueDate: dayOf(date),
                paymentMethod: current.paymentMethod,
                ...(dueDate ? { dueDate } : {}),
                notes: `${current.name}${current.notes ? `. ${current.notes}` : ''}`.slice(0, 500),
                lines: asDocumentLines(current.lines),
              },
              { ...ctx, idempotencyKey: `recurring-${template._id}-${dayOf(date)}` },
            );
            if (result.rejected) throw new CommercialError('el proveedor de facturación rechazó la factura', 'INVALID_STATE');
          } catch (err) {
            const message = err?.message ?? 'no se pudo emitir la factura';
            await recurringOf(tenantId).updateOne({ _id: template._id }, { $set: { lastError: { date, message, at: now() } } });
            failed.push({ templateId: template._id, name: template.name, date: dayOf(date), message });
            break;
          }
          const next = nextOccurrence(date, current.frequency, current.anchorDay);
          const advanced = await recurringOf(tenantId).findOneAndUpdate(
            { _id: template._id, nextDate: date },
            { $set: { nextDate: next, lastRun: { date, invoiceId: result.invoice._id, number: result.invoice.fullNumber ?? null, pending: Boolean(result.pending), at: now() } }, $inc: { runCount: 1 }, $unset: { lastError: '' } },
            { returnDocument: 'after' },
          );
          generated.push({ templateId: template._id, name: template.name, date: dayOf(date), invoiceId: result.invoice._id, number: result.invoice.fullNumber ?? null, pending: Boolean(result.pending) });
          // Otra ejecución a la vez ya avanzó la plantilla con la misma factura: se sigue desde lo que ella dejó.
          if (!advanced) break;
          current = advanced;
        }
      }
      if (generated.length || failed.length) await ctx.auditTx?.(undefined, { action: 'recurring.run', details: { generated: generated.length, failed: failed.length } });
      return { generated, failed };
    },
  };

  return api;
}
