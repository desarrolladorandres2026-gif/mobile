import { ObjectId } from 'mongodb';
import { creditNoteReasonsFor, vatRatesFor } from '../countries/index.js';
import { normalizeCenter, requireCostCenters, sumByAccountAndCenter } from '../core/dims.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate, withTransaction } from '../data/tx.js';
import { averageCost, returnedCost } from '../inventory/inventory.js';
import { ProviderUnavailableError, assertProvider } from './provider.js';
import { InvoicingError, missingSettings } from './settings.js';
import { computeLine, computeTotals, proportionalShare } from './tax.js';

const MAX_LINES = 200;
export const PAYMENT_METHODS = ['cash', 'credit'];
export const MAX_INVOICE_PAGE = 50;

const NOT_FINAL = ['pending_provider', 'rejected'];
const DAY_MS = 86_400_000;

function parseDay(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) throw new InvoicingError(`${label} debe ser una fecha AAAA-MM-DD`);
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new InvoicingError(`${label} no es una fecha válida`);
  return date;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/*
 * Factura (referencia, sin tipos):
 * { _id, tenantId, idempotencyKey, resolutionId, prefix, number, fullNumber, resolution{...},
 *   status 'pending_provider'|'rejected'|'issued',
 *   customer { partyId, name, taxIdType, taxId, checkDigit?, email?, phone?, address? },
 *   issueDate, dueDate?, paymentMethod, currency, notes?,
 *   lines [{ description, quantity, unitPrice, discountBps, vatBps, accountId, gross, discount, net, tax, total,
 *            itemId?, warehouseId?, inventoryAccount?, cogsAccount? }],   las cuatro últimas, solo en líneas de bienes del inventario
 *   stockCost?[]                                           costo de ventas de cada línea (0 si no es del inventario), fijado al contabilizar
 *   totals { subtotal, discount, tax, total, taxByRate[] },
 *   accountsUsed { debit, vat },                          cuentas fijadas al crearla: un cambio posterior de configuración no la altera
 *   credited { quantity[], net[], tax[] }, creditedTotal,   lo ya acreditado por notas crédito
 *   collectible, paidTotal, balance                        cartera: si queda por cobrar (su débito fue a por cobrar), lo cobrado y
 *                                                          lo que falta (total − acreditado − cobrado; puede quedar negativo si se acredita lo ya cobrado)
 *   cufe?, qr?, validatedAt?, provider? { name, sandbox, reference }, issuedAt?,
 *   rejection? { code, message },
 *   accounting { status 'pending'|'posted', journalId?, error? },
 *   createdBy, createdAt }
 *
 * Ciclo de vida. Crear reserva el número y guarda la factura (`pending_provider`). Luego se envía al proveedor,
 * que es una llamada externa y por eso no va dentro de ninguna transacción:
 *   · aceptada  → `issued` y se contabiliza en la misma transacción;
 *   · rechazada → `rejected` (conserva su número; se puede reenviar);
 *   · sin respuesta → sigue `pending_provider` y se reintenta con `submit`. El proveedor es idempotente por referencia.
 * Si el proveedor ya la validó pero la contabilización falla (período cerrado, cuenta inactiva…), la validación
 * NO se pierde: la factura queda `issued` con la contabilización pendiente y se reintenta con `account`.
 *
 * Inventario. Una línea con `itemId` vende un bien: al contabilizar, en la misma transacción que el asiento FV, la
 * existencia sale al costo promedio de ese momento y el asiento suma costo de ventas contra inventario. La nota crédito
 * cuyo motivo devuelve bienes los regresa al costo al que salieron (`returnedCost`) y revierte ese costo. Si no hay
 * existencias al contabilizar, la factura (ya validada) queda emitida con la contabilización pendiente.
 */
export function createInvoicingService({ client, db, ledger, accounts, parties, settings, resolutions, provider = null, inventory = null, now = () => new Date() }) {
  if (provider) assertProvider(provider);
  const invoicesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.invoices), tenantId);
  const notesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.creditNotes), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  const requireProvider = () => {
    if (!provider) throw new InvoicingError('la facturación electrónica no está configurada: no hay proveedor', 'NOT_CONFIGURED');
    return provider;
  };

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1, currency: 1 } });
    if (!tenant) throw new InvoicingError('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  async function readySettings(tenantId) {
    const cfg = await settings.get(tenantId);
    const missing = missingSettings(cfg);
    if (missing.length) throw new InvoicingError(`falta configurar: ${missing.join(', ')}`, 'SETTINGS_INCOMPLETE');
    return cfg;
  }

  const present = (doc) => {
    if (!doc) return doc;
    if (doc.credited) {
      const left = doc.lines.some((l, i) => l.quantity - doc.credited.quantity[i] > 0);
      return { ...doc, creditStatus: doc.creditedTotal === 0 ? 'none' : left ? 'partial' : 'full' };
    }
    return doc;
  };

  const customerSnapshot = (party) => ({
    partyId: party._id,
    name: party.name,
    taxIdType: party.taxIdType,
    taxId: party.taxId,
    ...(party.checkDigit !== undefined ? { checkDigit: party.checkDigit } : {}),
    ...(party.email ? { email: party.email } : {}),
    ...(party.phone ? { phone: party.phone } : {}),
    ...(party.address ? { address: party.address } : {}),
  });

  /** Lo que el proveedor no necesita ni debe ver: el inventario y su costo son internos. */
  const withoutStock = ({ itemId, warehouseId, inventoryAccount, cogsAccount, stockCost, costCenter, ...visible }) => visible;

  function providerDocument(kind, doc, cfg) {
    return {
      kind,
      issuer: cfg.issuer,
      number: { prefix: doc.prefix, number: doc.number, fullNumber: doc.fullNumber, resolution: doc.resolution },
      issueDate: isoDay(doc.issueDate),
      ...(doc.dueDate ? { dueDate: isoDay(doc.dueDate) } : {}),
      ...(doc.paymentMethod ? { paymentMethod: doc.paymentMethod } : {}),
      currency: doc.currency,
      customer: doc.customer,
      lines: doc.lines.map(withoutStock),
      totals: doc.totals,
      ...(doc.notes ? { notes: doc.notes } : {}),
      ...(kind === 'credit_note'
        ? { reason: { code: doc.reasonCode, text: doc.reasonText }, invoice: { fullNumber: doc.invoiceFullNumber, cufe: doc.invoiceCufe } }
        : {}),
    };
  }

  /** Asiento de una factura: débito a por cobrar (o caja), créditos a ingresos por cuenta y a IVA por pagar. */
  function invoiceJournal(invoice) {
    // El cliente va en la línea de la cuenta por cobrar: así el auxiliar por tercero y la cartera hablan del mismo cliente.
    const lines = [{ accountId: invoice.accountsUsed.debit, debit: invoice.totals.total, ...(invoice.collectible ? { partyId: invoice.customer.partyId } : {}) }];
    for (const { accountId, costCenter, amount } of sumByAccountAndCenter(invoice.lines, (l) => l.net)) {
      if (amount > 0) lines.push({ accountId, credit: amount, ...(costCenter ? { costCenter } : {}) });
    }
    if (invoice.totals.tax > 0) lines.push({ accountId: invoice.accountsUsed.vat, credit: invoice.totals.tax });
    return {
      docType: 'FV',
      date: invoice.issueDate,
      currency: invoice.currency,
      idempotencyKey: `invoice-${invoice._id}`,
      description: `Factura ${invoice.fullNumber}`,
      source: { kind: 'invoice', id: String(invoice._id) },
      lines,
    };
  }

  /** Asiento de una nota crédito: el inverso proporcional, con los importes de la nota. */
  function noteJournal(note, invoice) {
    const lines = [];
    for (const { accountId, costCenter, amount } of sumByAccountAndCenter(note.lines, (l) => l.net)) {
      if (amount > 0) lines.push({ accountId, debit: amount, ...(costCenter ? { costCenter } : {}) });
    }
    if (note.totals.tax > 0) lines.push({ accountId: invoice.accountsUsed.vat, debit: note.totals.tax });
    lines.push({ accountId: invoice.accountsUsed.debit, credit: note.totals.total, ...(invoice.collectible ? { partyId: invoice.customer.partyId } : {}) });
    return {
      docType: 'NC',
      date: note.issueDate,
      currency: note.currency,
      idempotencyKey: `credit-note-${note._id}`,
      description: `Nota crédito ${note.fullNumber} a la factura ${note.invoiceFullNumber}`,
      source: { kind: 'credit_note', id: String(note._id) },
      lines,
    };
  }

  // ------------------------------------------------------------------ inventario

  const addTo = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

  /** Líneas del asiento del costo: costo de ventas contra inventario, o al revés cuando el bien vuelve. */
  function costLines(entries, returning) {
    const cogs = new Map();
    const stock = new Map();
    for (const e of entries) {
      if (e.cost <= 0) continue;
      addTo(stock, e.inventoryAccount, e.cost);
      const key = `${e.cogsAccount}|${e.costCenter ?? ''}`;
      const cur = cogs.get(key) ?? { accountId: e.cogsAccount, costCenter: e.costCenter, amount: 0 };
      cur.amount += e.cost;
      cogs.set(key, cur);
    }
    const stockLines = (side) => [...stock].map(([accountId, amount]) => ({ accountId, [side]: amount }));
    const cogsLines = (side) => [...cogs.values()].map(({ accountId, costCenter, amount }) => ({ accountId, [side]: amount, ...(costCenter ? { costCenter } : {}) }));
    return returning ? [...stockLines('debit'), ...cogsLines('credit')] : [...cogsLines('debit'), ...stockLines('credit')];
  }

  /**
   * Salida de las líneas de bienes de una factura al costo promedio de este momento. Lee y planea; `apply` escribe
   * dentro de la transacción del asiento y falla con STOCK_CONFLICT si las existencias cambiaron entremedias.
   */
  async function saleStock(tenantId, invoice, ctx) {
    const stockLines = invoice.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.itemId);
    if (!stockLines.length) return null;
    if (!inventory) throw new InvoicingError('el inventario no está disponible');
    const plan = await inventory.planOut(tenantId, stockLines.map(({ line }) => ({ itemId: line.itemId, warehouseId: line.warehouseId, quantity: line.quantity })));
    // El costo de cada grupo (artículo y bodega) se reparte entre sus líneas sin dejar residuo.
    const left = new Map(plan.map((p) => [`${p.itemId}:${p.warehouseId}`, { quantity: p.quantity, value: p.cost }]));
    const stockCost = invoice.lines.map(() => 0);
    for (const { line, index } of stockLines) {
      const group = left.get(`${line.itemId}:${line.warehouseId}`);
      stockCost[index] = averageCost(group, line.quantity);
      group.quantity -= line.quantity;
      group.value -= stockCost[index];
    }
    return {
      set: { stockCost },
      lines: costLines(stockLines.map(({ line, index }) => ({ cost: stockCost[index], cogsAccount: line.cogsAccount, inventoryAccount: line.inventoryAccount, costCenter: line.costCenter })), false),
      apply: (session) =>
        inventory.applyOut(tenantId, plan, session, { type: 'sale_out', date: invoice.issueDate, source: { kind: 'invoice', id: String(invoice._id) }, userId: ctx.userId }),
    };
  }

  /** Reingreso de los bienes que una nota crédito devuelve, al costo al que salieron (fijado al crear la nota). */
  function returnStock(tenantId, note, ctx) {
    const lines = note.lines.filter((l) => l.itemId);
    if (!lines.length) return null;
    if (!inventory) throw new InvoicingError('el inventario no está disponible');
    return {
      set: {},
      lines: costLines(lines.map((l) => ({ cost: l.stockCost, cogsAccount: l.cogsAccount, inventoryAccount: l.inventoryAccount, costCenter: l.costCenter })), true),
      apply: (session) =>
        inventory.applyIn(
          tenantId,
          lines.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity, value: l.stockCost, lineIndex: l.lineIndex })),
          session,
          { type: 'sale_return', date: note.issueDate, source: { kind: 'credit_note', id: String(note._id) }, userId: ctx.userId },
        ),
    };
  }

  /**
   * Publica el asiento. Con inventario, planea la salida o el reingreso, suma el costo al asiento y lo aplica en la
   * misma transacción; si otra operación movió las existencias entremedias, repite todo desde la lectura.
   */
  async function postWithStock(tenantId, journalInput, stock, inTx) {
    const attempt = async () => {
      const extra = stock ? await stock() : null;
      const input = extra?.lines.length ? { ...journalInput, lines: [...journalInput.lines, ...extra.lines] } : journalInput;
      return ledger.postJournal(tenantId, input, { inTx: (session, posted) => inTx(session, posted, extra) });
    };
    return stock && inventory ? inventory.withStockRetry(attempt) : attempt();
  }

  /**
   * Contabiliza un documento ya validado por el proveedor y lo marca emitido, en una sola transacción.
   * Si la contabilización falla, la validación se conserva: queda emitido con la contabilización pendiente.
   * `stock`, si viene, planea el movimiento de inventario que acompaña al asiento.
   */
  async function finalize({ tenantId, collection, doc, receipt, journalInput, stock, auditAction, auditDetails, ctx }) {
    const target = collection(tenantId);
    const issuedFields = {
      status: 'issued',
      cufe: receipt.cufe,
      qr: receipt.qr,
      validatedAt: receipt.validatedAt,
      provider: { name: provider.name, sandbox: provider.sandbox, reference: receipt.reference },
      issuedAt: now(),
    };
    try {
      const { journal, replayed } = await postWithStock(tenantId, journalInput, stock, async (session, { journal: created }, extra) => {
        const result = await target.updateOne(
          { _id: doc._id, status: { $in: NOT_FINAL } },
          { $set: { ...issuedFields, ...(extra?.set ?? {}), accounting: { status: 'posted', journalId: created._id } }, $unset: { rejection: '' } },
          { session },
        );
        if (result.matchedCount === 0) throw new InvoicingError('el estado del documento cambió mientras se emitía', 'INVALID_STATE');
        await extra?.apply(session);
        await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: auditDetails });
      });
      if (replayed) {
        // El asiento ya existía (un intento anterior lo registró): solo falta marcar el documento.
        await target.updateOne(
          { _id: doc._id, status: { $in: NOT_FINAL } },
          { $set: { ...issuedFields, accounting: { status: 'posted', journalId: journal._id } }, $unset: { rejection: '' } },
        );
      }
    } catch (err) {
      if (err instanceof InvoicingError && err.code === 'INVALID_STATE') return target.findOne({ _id: doc._id });
      await withTransaction(client, async (session) => {
        await target.updateOne(
          { _id: doc._id, status: { $in: NOT_FINAL } },
          { $set: { ...issuedFields, accounting: { status: 'pending', error: err.message, at: now() } }, $unset: { rejection: '' } },
          { session },
        );
        await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: { ...auditDetails, accounting: 'pending', reason: err.message } });
      });
    }
    return target.findOne({ _id: doc._id });
  }

  async function markRejected({ tenantId, collection, doc, result, auditAction, release, ctx }) {
    const target = collection(tenantId);
    await withTransaction(client, async (session) => {
      const updated = await target.updateOne(
        { _id: doc._id, status: { $in: NOT_FINAL } },
        { $set: { status: 'rejected', rejection: { code: result.code, message: result.message }, rejectedAt: now() } },
        { session },
      );
      if (updated.matchedCount === 1 && release) await release(session);
      await ctx.auditTx?.(session, { action: auditAction, target: doc._id, details: { code: result.code } });
    });
    return target.findOne({ _id: doc._id });
  }

  /** Artículos y bodegas de las líneas que traen `itemId`; las demás quedan sin información de inventario. */
  async function resolveStock(tenantId, inputLines) {
    const wanted = (Array.isArray(inputLines) ? inputLines : []).map((l) => l?.itemId);
    if (!wanted.some(Boolean)) return [];
    if (!inventory) throw new InvoicingError('el inventario no está disponible');
    const items = await inventory.loadItems(tenantId, wanted.filter(Boolean));
    const info = [];
    for (const [i, itemId] of wanted.entries()) {
      if (!itemId) continue;
      const item = items.get(String(itemId));
      if (item.type !== 'goods') throw new InvoicingError(`línea ${i + 1}: solo los bienes salen del inventario; un servicio se factura sin artículo`);
      if (!item.active) throw new InvoicingError(`línea ${i + 1}: el artículo ${item.sku} está inactivo`);
      info[i] = { item, warehouse: await inventory.resolveWarehouse(tenantId, inputLines[i].warehouseId) };
    }
    return info;
  }

  function prepareLines(inputLines, { country, regime, defaultAccount, stockInfo = [] }) {
    if (!Array.isArray(inputLines) || inputLines.length === 0) throw new InvoicingError('la factura necesita al menos una línea');
    if (inputLines.length > MAX_LINES) throw new InvoicingError(`la factura admite como máximo ${MAX_LINES} líneas`);
    const allowed = vatRatesFor(country);
    return inputLines.map((line, i) => {
      const n = i + 1;
      const description = String(line.description ?? '').trim();
      if (!description) throw new InvoicingError(`línea ${n}: falta la descripción`);
      if (description.length > 200) throw new InvoicingError(`línea ${n}: la descripción admite como máximo 200 caracteres`);
      const vatBps = line.vatBps ?? 0;
      if (allowed && !allowed.includes(vatBps)) throw new InvoicingError(`línea ${n}: tarifa de IVA no válida (${vatBps / 100} %)`);
      if (regime === 'no_responsable' && vatBps !== 0) throw new InvoicingError(`línea ${n}: un emisor no responsable de IVA no puede facturar con IVA`);
      let computed;
      try {
        computed = computeLine({ quantity: line.quantity, unitPrice: line.unitPrice, discountBps: line.discountBps ?? 0, vatBps });
      } catch (error) {
        throw new InvoicingError(`línea ${n}: ${error.message}`);
      }
      const stock = stockInfo[i];
      const costCenter = normalizeCenter(line.costCenter);
      const accountId = String(line.accountId ?? stock?.item.incomeAccount ?? defaultAccount).trim();
      return {
        description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountBps: line.discountBps ?? 0,
        vatBps,
        accountId,
        ...(costCenter ? { costCenter } : {}),
        ...(stock
          ? { itemId: stock.item._id, warehouseId: stock.warehouse._id, inventoryAccount: stock.item.inventoryAccount, cogsAccount: stock.item.cogsAccount }
          : {}),
        ...computed,
      };
    });
  }

  // ------------------------------------------------------------------ facturas

  async function submitInvoice(tenantId, invoiceId, ctx = {}) {
    requireProvider();
    const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
    if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
    if (invoice.status === 'issued') return { invoice: present(invoice), replayed: true };

    const cfg = await readySettings(tenantId);
    let result;
    try {
      result = await provider.issue({ kind: 'invoice', reference: String(invoice._id), document: providerDocument('invoice', invoice, cfg) });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { invoice: present(invoice), pending: true };
      throw err;
    }
    if (result.status === 'rejected') {
      const rejected = await markRejected({ tenantId, collection: invoicesOf, doc: invoice, result, auditAction: 'invoice.reject', ctx });
      return { invoice: present(rejected), rejected: true };
    }
    const issued = await finalize({
      tenantId,
      collection: invoicesOf,
      doc: invoice,
      receipt: result,
      journalInput: invoiceJournal(invoice),
      stock: () => saleStock(tenantId, invoice, ctx),
      auditAction: 'invoice.issue',
      auditDetails: { number: invoice.fullNumber, total: invoice.totals.total, sandbox: provider.sandbox },
      ctx,
    });
    return { invoice: present(issued) };
  }

  async function issueInvoice(tenantId, input, ctx = {}) {
    requireProvider();
    const { idempotencyKey, userId } = ctx;
    if (!idempotencyKey?.trim()) throw new InvoicingError('falta la clave de idempotencia');

    const previous = await invoicesOf(tenantId).findOne({ idempotencyKey });
    if (previous) return { ...(await submitInvoice(tenantId, previous._id, ctx)), replayed: true };

    const cfg = await readySettings(tenantId);
    const tenant = await tenantInfo(tenantId);
    const party = await parties.get(tenantId, input.customerId);
    if (!party) throw new InvoicingError('el cliente no existe', 'NOT_FOUND');
    if (!party.active) throw new InvoicingError('el cliente está inactivo');
    if (!party.roles.includes('customer')) throw new InvoicingError('el tercero elegido no está registrado como cliente');

    const issueDate = parseDay(input.issueDate, 'la fecha de emisión');
    if (issueDate.getTime() > now().getTime() + DAY_MS) throw new InvoicingError('la fecha de emisión no puede ser futura');
    const paymentMethod = input.paymentMethod;
    if (!PAYMENT_METHODS.includes(paymentMethod)) throw new InvoicingError('la forma de pago debe ser contado o crédito');
    let dueDate;
    if (input.dueDate) {
      dueDate = parseDay(input.dueDate, 'la fecha de vencimiento');
      if (dueDate < issueDate) throw new InvoicingError('el vencimiento no puede ser anterior a la emisión');
    }
    if (paymentMethod === 'credit' && !dueDate) throw new InvoicingError('una venta a crédito necesita fecha de vencimiento');
    const notes = String(input.notes ?? '').trim().slice(0, 500) || undefined;

    const stockInfo = await resolveStock(tenantId, input.lines);
    const lines = prepareLines(input.lines, { country: tenant.country, regime: cfg.issuer.regime, defaultAccount: cfg.accounts.income, stockInfo });
    await requireCostCenters(db, tenantId, lines.map((l) => l.costCenter), (message) => {
      throw new InvoicingError(message);
    });
    const totals = computeTotals(lines);
    if (totals.total <= 0) throw new InvoicingError('el total de la factura debe ser mayor que cero');

    const debit = paymentMethod === 'cash' && cfg.accounts.cash ? cfg.accounts.cash : cfg.accounts.receivable;
    const problems = await accounts.postingProblems(tenantId, [debit, cfg.accounts.vatPayable, ...lines.map((l) => l.accountId)]);
    if (problems.length) throw new InvoicingError(problems.join('; '));
    // Aviso temprano, antes de gastar un número de la resolución: lo definitivo se comprueba al contabilizar.
    const sold = lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity }));
    if (sold.length) await inventory.planOut(tenantId, sold);

    let created;
    try {
      created = await withTransaction(client, async (session) => {
        const number = await resolutions.allocate(tenantId, 'invoice', now(), session);
        const doc = {
          idempotencyKey,
          resolutionId: number.resolutionId,
          prefix: number.prefix,
          number: number.number,
          fullNumber: number.fullNumber,
          resolution: number.resolution,
          status: 'pending_provider',
          customer: customerSnapshot(party),
          issueDate,
          ...(dueDate ? { dueDate } : {}),
          paymentMethod,
          currency: tenant.currency,
          ...(notes ? { notes } : {}),
          lines,
          totals,
          accountsUsed: { debit, vat: cfg.accounts.vatPayable },
          credited: { quantity: lines.map(() => 0), net: lines.map(() => 0), tax: lines.map(() => 0), restocked: lines.map(() => 0), cost: lines.map(() => 0) },
          creditedTotal: 0,
          collectible: debit === cfg.accounts.receivable,
          paidTotal: 0,
          balance: totals.total,
          accounting: { status: 'pending' },
          createdBy: userId ?? null,
          createdAt: now(),
        };
        const { insertedId } = await invoicesOf(tenantId).insertOne({ ...doc }, session);
        await ctx.auditTx?.(session, { action: 'invoice.create', target: insertedId, details: { number: number.fullNumber, total: totals.total } });
        return { ...doc, _id: insertedId, tenantId };
      });
    } catch (err) {
      if (isDuplicate(err, 'tenant_invoice_idempotency')) {
        const winner = await invoicesOf(tenantId).findOne({ idempotencyKey });
        return { ...(await submitInvoice(tenantId, winner._id, ctx)), replayed: true };
      }
      throw err;
    }
    return { ...(await submitInvoice(tenantId, created._id, ctx)), replayed: false };
  }

  /** Contabiliza una factura emitida cuya contabilización quedó pendiente (por ejemplo, tras reabrir el período). */
  async function accountInvoice(tenantId, invoiceId, ctx = {}) {
    const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
    if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
    if (invoice.status !== 'issued') throw new InvoicingError('solo se contabilizan facturas ya emitidas', 'INVALID_STATE');
    if (invoice.accounting?.status === 'posted') return present(invoice);
    await postWithStock(tenantId, invoiceJournal(invoice), () => saleStock(tenantId, invoice, ctx), async (session, { journal }, extra) => {
      await invoicesOf(tenantId).updateOne(
        { _id: invoice._id, 'accounting.status': 'pending' },
        { $set: { ...(extra?.set ?? {}), accounting: { status: 'posted', journalId: journal._id } } },
        { session },
      );
      await extra?.apply(session);
      await ctx.auditTx?.(session, { action: 'invoice.account', target: invoice._id, details: { number: invoice.fullNumber } });
    });
    return present(await invoicesOf(tenantId).findOne({ _id: invoice._id }));
  }

  // ------------------------------------------------------------- notas crédito

  async function submitCreditNote(tenantId, noteId, ctx = {}) {
    requireProvider();
    const note = await notesOf(tenantId).findOne({ _id: new ObjectId(noteId) });
    if (!note) throw new InvoicingError('la nota crédito no existe', 'NOT_FOUND');
    if (note.status === 'issued') return { note, replayed: true };
    if (note.status === 'rejected') return { note, rejected: true };

    const cfg = await readySettings(tenantId);
    const invoice = await invoicesOf(tenantId).findOne({ _id: note.invoiceId });
    let result;
    try {
      result = await provider.issue({ kind: 'credit_note', reference: String(note._id), document: providerDocument('credit_note', note, cfg) });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { note, pending: true };
      throw err;
    }
    if (result.status === 'rejected') {
      // Una nota rechazada es definitiva: se libera lo que había reservado en la factura y se crea otra si hace falta.
      const rejected = await markRejected({
        tenantId,
        collection: notesOf,
        doc: note,
        result,
        auditAction: 'credit_note.reject',
        ctx,
        release: (session) =>
          invoicesOf(tenantId).updateOne(
            { _id: note.invoiceId },
            {
              $inc: {
                creditedTotal: -note.totals.total,
                balance: note.totals.total,
                ...Object.fromEntries(note.lines.flatMap((l) => [
                  [`credited.quantity.${l.lineIndex}`, -l.quantity],
                  [`credited.net.${l.lineIndex}`, -l.net],
                  [`credited.tax.${l.lineIndex}`, -l.tax],
                  ...(l.itemId ? [[`credited.restocked.${l.lineIndex}`, -l.quantity], [`credited.cost.${l.lineIndex}`, -l.stockCost]] : []),
                ])),
              },
            },
            { session },
          ),
      });
      return { note: rejected, rejected: true };
    }
    const issued = await finalize({
      tenantId,
      collection: notesOf,
      doc: note,
      receipt: result,
      journalInput: noteJournal(note, invoice),
      stock: () => returnStock(tenantId, note, ctx),
      auditAction: 'credit_note.issue',
      auditDetails: { number: note.fullNumber, invoice: note.invoiceFullNumber, total: note.totals.total, sandbox: provider.sandbox },
      ctx,
    });
    return { note: issued };
  }

  async function issueCreditNote(tenantId, invoiceId, input, ctx = {}) {
    requireProvider();
    const { idempotencyKey, userId } = ctx;
    if (!idempotencyKey?.trim()) throw new InvoicingError('falta la clave de idempotencia');

    const previous = await notesOf(tenantId).findOne({ idempotencyKey });
    if (previous) return { ...(await submitCreditNote(tenantId, previous._id, ctx)), replayed: true };

    const tenant = await tenantInfo(tenantId);
    const reasons = creditNoteReasonsFor(tenant.country);
    const reason = reasons.find((r) => r.code === String(input.reasonCode));
    if (!reason) throw new InvoicingError('elige el motivo de la nota crédito');
    const issueDate = parseDay(input.issueDate ?? isoDay(now()), 'la fecha de emisión');
    if (issueDate.getTime() > now().getTime() + DAY_MS) throw new InvoicingError('la fecha de emisión no puede ser futura');

    // La reserva en la factura es optimista: si otra nota crédito la modificó entre la lectura y la escritura, se relee.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invoice = await invoicesOf(tenantId).findOne({ _id: new ObjectId(invoiceId) });
      if (!invoice) throw new InvoicingError('la factura no existe', 'NOT_FOUND');
      if (invoice.status !== 'issued') throw new InvoicingError('solo se acreditan facturas ya emitidas', 'INVALID_STATE');
      if (issueDate < invoice.issueDate) throw new InvoicingError('la nota crédito no puede ser anterior a la factura');

      const wanted = input.all
        ? invoice.lines.map((l, i) => ({ lineIndex: i, quantity: l.quantity - invoice.credited.quantity[i] })).filter((w) => w.quantity > 0)
        : (input.lines ?? []);
      if (!wanted.length) throw new InvoicingError('no queda nada por acreditar en esta factura', 'OVER_CREDIT');
      const seen = new Set();
      const noteLines = wanted.map((w) => {
        if (!Number.isInteger(w.lineIndex) || w.lineIndex < 0 || w.lineIndex >= invoice.lines.length) throw new InvoicingError('línea de factura inexistente');
        if (seen.has(w.lineIndex)) throw new InvoicingError('una línea de la factura solo puede acreditarse una vez por nota');
        seen.add(w.lineIndex);
        const line = invoice.lines[w.lineIndex];
        let share;
        try {
          share = proportionalShare(line, {
            quantity: w.quantity,
            creditedQuantity: invoice.credited.quantity[w.lineIndex],
            creditedNet: invoice.credited.net[w.lineIndex],
            creditedTax: invoice.credited.tax[w.lineIndex],
          });
        } catch (error) {
          throw new InvoicingError(`línea ${w.lineIndex + 1}: ${error.message}`, 'OVER_CREDIT');
        }
        // Un bien que vuelve entra al inventario al costo al que salió; ese costo se fija ahora, junto con lo demás que se reserva.
        let restock = {};
        if (reason.returnsGoods && line.itemId) {
          if (!invoice.stockCost) throw new InvoicingError('la factura aún no tiene contabilizado su costo de ventas: contabilízala antes de devolver sus bienes', 'INVALID_STATE');
          let stockCost;
          try {
            stockCost = returnedCost(invoice.stockCost[w.lineIndex], line.quantity, {
              quantity: w.quantity,
              restockedQuantity: invoice.credited.restocked?.[w.lineIndex] ?? 0,
              restockedCost: invoice.credited.cost?.[w.lineIndex] ?? 0,
            });
          } catch (error) {
            throw new InvoicingError(`línea ${w.lineIndex + 1}: ${error.message}`, 'OVER_CREDIT');
          }
          restock = { itemId: line.itemId, warehouseId: line.warehouseId, inventoryAccount: line.inventoryAccount, cogsAccount: line.cogsAccount, stockCost };
        }
        return {
          lineIndex: w.lineIndex,
          description: line.description,
          quantity: w.quantity,
          unitPrice: line.unitPrice,
          discountBps: line.discountBps,
          vatBps: line.vatBps,
          accountId: line.accountId,
          ...(line.costCenter ? { costCenter: line.costCenter } : {}),
          discount: 0,
          net: share.net,
          tax: share.tax,
          total: share.total,
          ...restock,
        };
      });
      const totals = computeTotals(noteLines);
      if (totals.total <= 0) throw new InvoicingError('el valor de la nota crédito debe ser mayor que cero');

      const guard = { _id: invoice._id, status: 'issued' };
      const inc = { creditedTotal: totals.total, balance: -totals.total };
      for (const l of noteLines) {
        guard[`credited.quantity.${l.lineIndex}`] = invoice.credited.quantity[l.lineIndex];
        guard[`credited.net.${l.lineIndex}`] = invoice.credited.net[l.lineIndex];
        guard[`credited.tax.${l.lineIndex}`] = invoice.credited.tax[l.lineIndex];
        inc[`credited.quantity.${l.lineIndex}`] = l.quantity;
        inc[`credited.net.${l.lineIndex}`] = l.net;
        inc[`credited.tax.${l.lineIndex}`] = l.tax;
        if (l.itemId) {
          guard[`credited.restocked.${l.lineIndex}`] = invoice.credited.restocked?.[l.lineIndex] ?? 0;
          guard[`credited.cost.${l.lineIndex}`] = invoice.credited.cost?.[l.lineIndex] ?? 0;
          inc[`credited.restocked.${l.lineIndex}`] = l.quantity;
          inc[`credited.cost.${l.lineIndex}`] = l.stockCost;
        }
      }

      let created = null;
      try {
        created = await withTransaction(client, async (session) => {
          const reserved = await invoicesOf(tenantId).updateOne(guard, { $inc: inc }, { session });
          if (reserved.matchedCount === 0) return null; // otra nota crédito se adelantó: se relee
          const number = await resolutions.allocate(tenantId, 'credit_note', now(), session);
          const doc = {
            idempotencyKey,
            invoiceId: invoice._id,
            invoiceFullNumber: invoice.fullNumber,
            invoiceCufe: invoice.cufe,
            resolutionId: number.resolutionId,
            prefix: number.prefix,
            number: number.number,
            fullNumber: number.fullNumber,
            resolution: number.resolution,
            status: 'pending_provider',
            reasonCode: reason.code,
            reasonText: reason.label,
            customer: invoice.customer,
            issueDate,
            currency: invoice.currency,
            lines: noteLines,
            totals,
            accounting: { status: 'pending' },
            createdBy: userId ?? null,
            createdAt: now(),
          };
          const { insertedId } = await notesOf(tenantId).insertOne({ ...doc }, session);
          await ctx.auditTx?.(session, { action: 'credit_note.create', target: insertedId, details: { number: number.fullNumber, invoice: invoice.fullNumber, total: totals.total } });
          return { ...doc, _id: insertedId, tenantId };
        });
      } catch (err) {
        if (isDuplicate(err, 'tenant_note_idempotency')) {
          const winner = await notesOf(tenantId).findOne({ idempotencyKey });
          return { ...(await submitCreditNote(tenantId, winner._id, ctx)), replayed: true };
        }
        throw err;
      }
      if (created) return { ...(await submitCreditNote(tenantId, created._id, ctx)), replayed: false };
    }
    throw new InvoicingError('la factura se está modificando en este momento: inténtalo de nuevo', 'INVALID_STATE');
  }

  async function accountCreditNote(tenantId, noteId, ctx = {}) {
    const note = await notesOf(tenantId).findOne({ _id: new ObjectId(noteId) });
    if (!note) throw new InvoicingError('la nota crédito no existe', 'NOT_FOUND');
    if (note.status !== 'issued') throw new InvoicingError('solo se contabilizan notas crédito ya emitidas', 'INVALID_STATE');
    if (note.accounting?.status === 'posted') return note;
    const invoice = await invoicesOf(tenantId).findOne({ _id: note.invoiceId });
    await postWithStock(tenantId, noteJournal(note, invoice), () => returnStock(tenantId, note, ctx), async (session, { journal }, extra) => {
      await notesOf(tenantId).updateOne(
        { _id: note._id, 'accounting.status': 'pending' },
        { $set: { accounting: { status: 'posted', journalId: journal._id } } },
        { session },
      );
      await extra?.apply(session);
      await ctx.auditTx?.(session, { action: 'credit_note.account', target: note._id, details: { number: note.fullNumber } });
    });
    return notesOf(tenantId).findOne({ _id: note._id });
  }

  // ------------------------------------------------------------------ consultas

  async function list(collection, tenantId, { status, customerId, from, to, invoiceId, limit = 25, cursor } = {}) {
    const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_INVOICE_PAGE);
    const filter = {};
    if (status) filter.status = String(status);
    if (customerId) filter['customer.partyId'] = new ObjectId(customerId);
    if (invoiceId) filter.invoiceId = new ObjectId(invoiceId);
    if (from || to) {
      filter.issueDate = {};
      if (from) filter.issueDate.$gte = parseDay(from, 'la fecha inicial');
      if (to) filter.issueDate.$lte = parseDay(to, 'la fecha final');
    }
    if (cursor) filter._id = { $lt: new ObjectId(cursor) };
    const rows = await collection(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
    const hasMore = rows.length > size;
    const items = hasMore ? rows.slice(0, size) : rows;
    return { items: items.map(present), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
  }

  return {
    async status(tenantId) {
      const cfg = await settings.get(tenantId);
      const resolutionList = await resolutions.list(tenantId);
      const missing = missingSettings(cfg);
      const usable = (docType) => resolutionList.some((r) => r.docType === docType && r.active && r.validTo >= now() && r.next <= r.to);
      if (!usable('invoice')) missing.push('una resolución de numeración vigente para facturas');
      if (!usable('credit_note')) missing.push('una resolución de numeración vigente para notas crédito');
      return {
        configured: Boolean(provider),
        provider: provider?.name ?? null,
        sandbox: provider?.sandbox ?? null,
        missing,
        ready: Boolean(provider) && missing.length === 0,
      };
    },
    issueInvoice,
    submitInvoice,
    accountInvoice,
    issueCreditNote,
    submitCreditNote,
    accountCreditNote,
    async getInvoice(tenantId, id) {
      return present(await invoicesOf(tenantId).findOne({ _id: new ObjectId(id) }));
    },
    listInvoices: (tenantId, options) => list(invoicesOf, tenantId, options),
    getCreditNote: (tenantId, id) => notesOf(tenantId).findOne({ _id: new ObjectId(id) }),
    listCreditNotes: (tenantId, options) => list(notesOf, tenantId, options),
  };
}

