import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { vatRatesFor } from '../countries/index.js';
import { normalizeCenter, requireCostCenters, sumByAccountAndCenter } from '../core/dims.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';
import { TaxError, computeLine, computeTotals, proportionalShare, roundDiv } from '../invoicing/tax.js';

export const MAX_LINES = 200;
export const MAX_WITHHOLDINGS = 10;
export const MAX_PURCHASE_PAGE = 50;
export const WITHHOLDING_BASES = ['subtotal', 'vat'];
const LINE_ACCOUNT_TYPES = ['asset', 'expense', 'cost'];

export class PurchasingError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PurchasingError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PurchasingError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);

/** Retención sobre una base: `rateBps` en puntos básicos (250 = 2,5 %), redondeo medio hacia arriba, con BigInt. */
export function withholdingAmount(base, rateBps) {
  if (!Number.isSafeInteger(base) || base < 0) throw new PurchasingError('la base de la retención no es válida');
  if (!Number.isSafeInteger(rateBps) || rateBps < 1 || rateBps > 10_000) throw new PurchasingError('la tarifa de la retención debe estar entre 0,01 % y 100 %');
  return Number(roundDiv(BigInt(base) * BigInt(rateBps), 10_000n));
}

const text = (value, label, { required = false, max = 200 } = {}) => {
  const clean = String(value ?? '').trim();
  if (!clean) {
    if (required) fail(`falta ${label}`);
    return undefined;
  }
  if (clean.length > max) fail(`${label} admite como máximo ${max} caracteres`);
  return clean;
};

/*
 * Factura de compra (referencia, sin tipos):
 * { _id, tenantId, idempotencyKey, number, fullNumber 'FC<n>', status 'posted'|'void',
 *   supplier { partyId, name, taxIdType, taxId }, supplierDocNumber, issueDate, dueDate, currency, notes?,
 *   lines [{ description, quantity, unitPrice, discountBps, vatBps, accountId, gross, discount, net, tax, total }],
 *   totals { subtotal, discount, tax, total, taxByRate[] },
 *   withholdings [{ name, accountId, basis 'subtotal'|'vat', rateBps, base, amount }], withheld,
 *   payable            lo que se le debe al proveedor: total − retenciones
 *   accountsUsed { payable, vat },
 *   credited { quantity[], net[], tax[] }, creditedTotal, creditedWithheld[],
 *   paidTotal, balance                 pagado y lo que falta (payable − notas − pagado; negativo = saldo a favor)
 *   journalId, voidJournalId?, voidedAt?, createdBy, createdAt }
 *
 * No hay proveedor tecnológico: la factura la emitió el proveedor y aquí solo se registra. El asiento, el saldo y la
 * factura se confirman en una sola transacción. La misma factura del proveedor no se registra dos veces
 * (índice único por proveedor y número, mientras no esté anulada).
 *
 * Nota de proveedor (devolución o descuento): reserva de forma optimista cantidades, neto, IVA y retenciones ya
 * acreditados, como las notas crédito de venta, y reduce lo que se le debe.
 */
export function createPurchasesService({ client, db, ledger, accounts, parties, settings, inventory = null, now = () => new Date() }) {
  const purchasesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.purchases), tenantId);
  const notesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.supplierNotes), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function tenantInfo(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { country: 1, currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant;
  }

  const missingFor = (cfg) => [
    ...(cfg?.accounts?.payable ? [] : ['la cuenta de proveedores']),
    ...(cfg?.accounts?.vatDeductible ? [] : ['la cuenta de IVA descontable']),
  ];

  async function readySettings(tenantId) {
    const cfg = await settings.get(tenantId);
    const missing = missingFor(cfg);
    if (missing.length) fail(`falta configurar: ${missing.join(', ')}`, 'SETTINGS_INCOMPLETE');
    return cfg;
  }

  const present = (doc) => {
    if (!doc?.credited) return doc;
    const left = doc.lines.some((l, i) => l.quantity - doc.credited.quantity[i] > 0);
    return { ...doc, creditStatus: doc.creditedTotal === 0 ? 'none' : left ? 'partial' : 'full' };
  };

  const supplierSnapshot = (party) => ({ partyId: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId });

  async function requireSupplier(tenantId, id) {
    const party = await parties.get(tenantId, id);
    if (!party) fail('el proveedor no existe', 'NOT_FOUND');
    if (!party.active) fail('el proveedor está inactivo');
    if (!party.roles.includes('supplier')) fail('el tercero elegido no está registrado como proveedor');
    return party;
  }

  /** Cada cuenta debe recibir asientos y ser de uno de los tipos permitidos. */
  async function checkAccounts(tenantId, codes, types, label) {
    const unique = [...new Set(codes)];
    const problems = await accounts.postingProblems(tenantId, unique);
    if (problems.length) fail(problems.join('; '));
    for (const code of unique) {
      const account = await accounts.get(tenantId, code);
      if (!types.includes(account.type)) fail(`la cuenta ${code} no sirve para ${label}`);
    }
  }

  /**
   * Una línea con `itemId` es un bien que entra al inventario: su cuenta es la de inventario del artículo y su
   * valor es el neto de la línea. Las demás llevan la cuenta de gasto, costo o activo que indique quien registra.
   */
  function prepareLines(raw, rates, stockInfo = []) {
    if (!Array.isArray(raw) || raw.length === 0) fail('agrega al menos una línea');
    if (raw.length > MAX_LINES) fail(`una factura admite como máximo ${MAX_LINES} líneas`);
    return raw.map((l, i) => {
      const where = `línea ${i + 1}`;
      const description = text(l?.description, `la descripción de la ${where}`, { required: true });
      const stock = stockInfo[i];
      const costCenter = normalizeCenter(l?.costCenter);
      const accountId = stock ? stock.item.inventoryAccount : String(l?.accountId ?? '').trim();
      if (!/^[0-9]{1,12}$/.test(accountId)) fail(`${where}: indica la cuenta del gasto, costo o activo`);
      const vatBps = l.vatBps ?? 0;
      if (rates && !rates.includes(vatBps)) fail(`${where}: la tarifa de IVA ${vatBps / 100} % no existe en el país`);
      try {
        const computed = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBps: l.discountBps ?? 0, vatBps });
        return {
          description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountBps: l.discountBps ?? 0,
          vatBps,
          accountId,
          ...(costCenter ? { costCenter } : {}),
          ...(stock ? { itemId: stock.item._id, warehouseId: stock.warehouse._id } : {}),
          ...computed,
        };
      } catch (err) {
        if (err instanceof TaxError) fail(`${where}: ${err.message}`);
        throw err;
      }
    });
  }

  /** Artículos y bodegas de las líneas que traen `itemId`; el resto queda sin información de inventario. */
  async function resolveStock(tenantId, rawLines) {
    const wanted = (Array.isArray(rawLines) ? rawLines : []).map((l) => l?.itemId);
    if (!wanted.some(Boolean)) return [];
    if (!inventory) fail('el inventario no está disponible');
    const items = await inventory.loadItems(tenantId, wanted.filter(Boolean));
    const info = [];
    for (const [i, itemId] of wanted.entries()) {
      if (!itemId) continue;
      const item = items.get(String(itemId));
      if (item.type !== 'goods') fail(`línea ${i + 1}: solo los bienes entran al inventario`);
      if (!item.active) fail(`línea ${i + 1}: el artículo ${item.sku} está inactivo`);
      info[i] = { item, warehouse: await inventory.resolveWarehouse(tenantId, rawLines[i].warehouseId) };
    }
    return info;
  }

  /** Entradas de inventario de las líneas que tienen artículo: cantidad y neto de cada una. */
  const stockEntries = (lines) =>
    lines
      .map((l, lineIndex) => ({ l, lineIndex }))
      .filter(({ l }) => l.itemId)
      .map(({ l, lineIndex }) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity, value: l.net, lineIndex }));

  function prepareWithholdings(raw, totals) {
    const list = raw ?? [];
    if (!Array.isArray(list) || list.length > MAX_WITHHOLDINGS) fail(`una factura admite como máximo ${MAX_WITHHOLDINGS} retenciones`);
    return list.map((w, i) => {
      const where = `retención ${i + 1}`;
      if (!WITHHOLDING_BASES.includes(w?.basis)) fail(`${where}: la base es el subtotal o el IVA`);
      const accountId = String(w?.accountId ?? '').trim();
      if (!/^[0-9]{1,12}$/.test(accountId)) fail(`${where}: indica la cuenta de la retención por pagar`);
      const base = w.basis === 'vat' ? totals.tax : totals.subtotal;
      return {
        name: text(w.name, `el nombre de la ${where}`, { required: true, max: 60 }),
        accountId,
        basis: w.basis,
        rateBps: w.rateBps,
        base,
        amount: withholdingAmount(base, w.rateBps),
      };
    });
  }

  const docTypeOf = (doc) => (doc.kind === 'debit_note' ? 'NDP' : 'FC');

  function purchaseJournal(doc, description) {
    const lines = sumByAccountAndCenter(doc.lines, (l) => l.net)
      .filter(({ amount }) => amount > 0)
      .map(({ accountId, costCenter, amount }) => ({ accountId, debit: amount, ...(costCenter ? { costCenter } : {}) }));
    if (doc.totals.tax > 0) lines.push({ accountId: doc.accountsUsed.vat, debit: doc.totals.tax });
    // El proveedor va en la línea de la cuenta por pagar: así el auxiliar por tercero habla del mismo proveedor.
    lines.push({ accountId: doc.accountsUsed.payable, credit: doc.payable, partyId: doc.supplier.partyId });
    for (const w of doc.withholdings) if (w.amount > 0) lines.push({ accountId: w.accountId, credit: w.amount });
    return {
      docType: docTypeOf(doc),
      date: doc.issueDate,
      currency: doc.currency,
      idempotencyKey: `purchase-${doc.idempotencyKey}`,
      description,
      source: { kind: doc.kind === 'debit_note' ? 'supplier_debit_note' : 'purchase', id: doc.idempotencyKey },
      lines,
    };
  }

  const api = {
    /** Qué falta para registrar compras y qué tarifas de IVA admite el país. */
    async status(tenantId) {
      const [cfg, tenant] = await Promise.all([settings.get(tenantId), tenantInfo(tenantId)]);
      const missing = missingFor(cfg);
      return { ready: missing.length === 0, missing, country: tenant.country, currency: tenant.currency, vatRatesBps: vatRatesFor(tenant.country) ?? [0] };
    },

    async createPurchase(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await purchasesOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { purchase: present(previous), replayed: true };

      const cfg = await readySettings(tenantId);
      const tenant = await tenantInfo(tenantId);
      const supplier = await requireSupplier(tenantId, input.supplierId);
      const supplierDocNumber = text(input.supplierDocNumber, 'el número de la factura del proveedor', { required: true, max: 40 }).toUpperCase();
      const issueDate = parseDay(input.issueDate, 'la fecha de la factura');
      if (issueDate.getTime() > now().getTime() + DAY_MS) fail('la fecha de la factura no puede ser futura');
      const dueDate = input.dueDate ? parseDay(input.dueDate, 'la fecha de vencimiento') : issueDate;
      if (dueDate < issueDate) fail('el vencimiento no puede ser anterior a la fecha de la factura');
      const notes = text(input.notes, 'las notas', { max: 500 });
      const kind = input.kind === 'debit_note' ? 'debit_note' : 'purchase';
      let related;
      if (kind === 'debit_note') {
        // Una nota débito del proveedor aumenta lo que se le debe (intereses, ajustes de precio, fletes): es un documento
        // propio con su saldo, que se paga como una factura. No mueve existencias.
        if (!input.relatedPurchaseId) fail('indica la factura de compra a la que corresponde la nota débito');
        if ((Array.isArray(input.lines) ? input.lines : []).some((l) => l?.itemId)) fail('una nota débito no mueve existencias: registra el cargo con una cuenta de gasto o costo');
        related = await purchasesOf(tenantId).findOne({ _id: new ObjectId(input.relatedPurchaseId) });
        if (!related) fail('la factura de compra no existe', 'NOT_FOUND');
        if (related.kind === 'debit_note') fail('una nota débito no corresponde a otra nota débito');
        if (related.status !== 'posted') fail('la factura de compra no está vigente', 'INVALID_STATE');
        if (String(related.supplier.partyId) !== String(supplier._id)) fail('la nota débito es de otro proveedor distinto al de la factura');
        if (dayOf(issueDate) < dayOf(related.issueDate)) fail('la nota débito no puede ser anterior a la factura');
      }

      const lines = prepareLines(input.lines, vatRatesFor(tenant.country), await resolveStock(tenantId, input.lines));
      await requireCostCenters(db, tenantId, lines.map((l) => l.costCenter), fail);
      const totals = computeTotals(lines);
      if (totals.total <= 0) fail('el total de la factura debe ser mayor que cero');
      const withholdings = prepareWithholdings(input.withholdings, totals);
      const withheld = withholdings.reduce((acc, w) => acc + w.amount, 0);
      const payable = totals.total - withheld;
      if (payable <= 0) fail('las retenciones no pueden dejar la factura sin valor por pagar');

      await checkAccounts(tenantId, lines.map((l) => l.accountId), LINE_ACCOUNT_TYPES, 'un gasto, costo o activo');
      await checkAccounts(tenantId, withholdings.map((w) => w.accountId), ['liability'], 'una retención por pagar');
      const problems = await accounts.postingProblems(tenantId, [cfg.accounts.payable, cfg.accounts.vatDeductible]);
      if (problems.length) fail(problems.join('; '));

      const purchaseId = new ObjectId();
      const doc = {
        idempotencyKey,
        status: 'posted',
        kind,
        ...(related ? { relatedPurchaseId: related._id, relatedNumber: related.fullNumber } : {}),
        supplier: supplierSnapshot(supplier),
        supplierDocNumber,
        issueDate,
        dueDate,
        currency: tenant.currency,
        ...(notes ? { notes } : {}),
        lines,
        totals,
        withholdings,
        withheld,
        payable,
        accountsUsed: { payable: cfg.accounts.payable, vat: cfg.accounts.vatDeductible },
        credited: { quantity: lines.map(() => 0), net: lines.map(() => 0), tax: lines.map(() => 0) },
        creditedTotal: 0,
        creditedWithheld: withholdings.map(() => 0),
        paidTotal: 0,
        balance: payable,
        createdBy: userId ?? null,
        createdAt: now(),
      };

      let replayed = false;
      try {
        const posted = await ledger.postJournal(tenantId, purchaseJournal(doc, kind === 'debit_note' ? `Nota débito ${supplierDocNumber} de ${supplier.name} sobre ${related.fullNumber}` : `Compra ${supplierDocNumber} de ${supplier.name}`), {
          inTx: async (session, { journal }) => {
            const { insertedId } = await purchasesOf(tenantId).insertOne(
              { ...doc, _id: purchaseId, number: journal.number, fullNumber: `${docTypeOf(doc)}${journal.number}`, journalId: journal._id },
              session,
            );
            const entries = stockEntries(lines);
            if (entries.length) {
              await inventory.applyIn(tenantId, entries, session, { type: 'purchase_in', date: issueDate, source: { kind: 'purchase', id: String(purchaseId) }, userId });
            }
            await ctx.auditTx?.(session, { action: kind === 'debit_note' ? 'supplier_debit_note.create' : 'purchase.create', target: insertedId, details: { number: `${docTypeOf(doc)}${journal.number}`, supplierDocNumber, total: totals.total } });
          },
        });
        replayed = posted.replayed;
      } catch (err) {
        if (isDuplicate(err, 'tenant_purchase_supplier_doc')) fail(`la factura ${supplierDocNumber} de ${supplier.name} ya está registrada`, 'DUPLICATE');
        if (!isDuplicate(err, 'tenant_purchase_idempotency')) throw err;
        replayed = true;
      }
      const purchase = await purchasesOf(tenantId).findOne({ idempotencyKey });
      if (!purchase) fail('el asiento de la compra ya existía sin factura: contacta a soporte', 'INVALID_STATE');
      return { purchase: present(purchase), replayed };
    },

    /** Anula una factura de compra sin pagos ni notas: reversa su asiento y la deja `void`. */
    async voidPurchase(tenantId, purchaseId, input = {}, ctx = {}) {
      const purchase = await purchasesOf(tenantId).findOne({ _id: new ObjectId(purchaseId) });
      if (!purchase) fail('la factura de compra no existe', 'NOT_FOUND');
      if (purchase.status === 'void') return { purchase: present(purchase), replayed: true };
      if (purchase.paidTotal !== 0 || purchase.creditedTotal !== 0) fail('la factura tiene pagos o notas de proveedor: anúlalos primero', 'INVALID_STATE');
      if (await purchasesOf(tenantId).findOne({ relatedPurchaseId: purchase._id, status: 'posted' })) fail('la factura tiene notas débito del proveedor: anúlalas primero', 'INVALID_STATE');
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : now();
      if (dayOf(date) < dayOf(purchase.issueDate)) fail('la anulación no puede ser anterior a la factura');

      await ledger.reverseJournal(
        tenantId,
        purchase.journalId,
        { idempotencyKey: `purchase-void-${purchase._id}`, date, description: `Anulación de la compra ${purchase.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await purchasesOf(tenantId).updateOne(
              { _id: purchase._id, status: 'posted', paidTotal: 0, creditedTotal: 0 },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null, balance: 0 } },
              { session },
            );
            if (changed.matchedCount === 0) fail('la factura cambió mientras se anulaba: revisa sus pagos y notas', 'INVALID_STATE');
            const entries = stockEntries(purchase.lines);
            if (entries.length) {
              await inventory.applyExactOut(tenantId, entries, session, { type: 'purchase_void', date, source: { kind: 'purchase', id: String(purchase._id) }, userId: ctx.userId });
            }
            await ctx.auditTx?.(session, { action: 'purchase.void', target: purchase._id, details: { number: purchase.fullNumber } });
          },
        },
      );
      return { purchase: present(await purchasesOf(tenantId).findOne({ _id: purchase._id })), replayed: false };
    },

    async getPurchase(tenantId, id) {
      return present(await purchasesOf(tenantId).findOne({ _id: new ObjectId(id) }));
    },

    async listPurchases(tenantId, { supplierId, status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PURCHASE_PAGE);
      const filter = {
        ...(supplierId ? { 'supplier.partyId': new ObjectId(supplierId) } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}),
      };
      const rows = await purchasesOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items: items.map(present), nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    // ---- Notas de proveedor ----

    async createSupplierNote(tenantId, purchaseId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await notesOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { note: previous, replayed: true };

      const reason = text(input.reason, 'el motivo de la nota', { required: true, max: 200 });
      const supplierDocNumber = text(input.supplierDocNumber, 'el número de la nota del proveedor', { required: true, max: 40 }).toUpperCase();
      const issueDate = parseDay(input.issueDate ?? dayOf(now()), 'la fecha de la nota');
      if (issueDate.getTime() > now().getTime() + DAY_MS) fail('la fecha de la nota no puede ser futura');

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const purchase = await purchasesOf(tenantId).findOne({ _id: new ObjectId(purchaseId) });
        if (!purchase) fail('la factura de compra no existe', 'NOT_FOUND');
        if (purchase.status !== 'posted') fail('solo se acreditan facturas de compra vigentes', 'INVALID_STATE');
        if (purchase.kind === 'debit_note') fail('una nota débito no se acredita: anúlala si fue un error', 'INVALID_STATE');
        if (dayOf(issueDate) < dayOf(purchase.issueDate)) fail('la nota no puede ser anterior a la factura');

        const wanted = input.all
          ? purchase.lines.map((l, i) => ({ lineIndex: i, quantity: l.quantity - purchase.credited.quantity[i] })).filter((w) => w.quantity > 0)
          : (input.lines ?? []);
        if (!wanted.length) fail('no queda nada por acreditar en esta factura', 'OVER_CREDIT');
        const seen = new Set();
        const noteLines = wanted.map((w) => {
          if (!Number.isInteger(w.lineIndex) || w.lineIndex < 0 || w.lineIndex >= purchase.lines.length) fail('línea de factura inexistente');
          if (seen.has(w.lineIndex)) fail('una línea de la factura solo puede acreditarse una vez por nota');
          seen.add(w.lineIndex);
          const line = purchase.lines[w.lineIndex];
          let share;
          try {
            share = proportionalShare(line, {
              quantity: w.quantity,
              creditedQuantity: purchase.credited.quantity[w.lineIndex],
              creditedNet: purchase.credited.net[w.lineIndex],
              creditedTax: purchase.credited.tax[w.lineIndex],
            });
          } catch (err) {
            fail(`línea ${w.lineIndex + 1}: ${err.message}`, 'OVER_CREDIT');
          }
          return {
            lineIndex: w.lineIndex,
            description: line.description,
            quantity: w.quantity,
            vatBps: line.vatBps,
            accountId: line.accountId,
            ...(line.costCenter ? { costCenter: line.costCenter } : {}),
            ...(line.itemId ? { itemId: line.itemId, warehouseId: line.warehouseId } : {}),
            discount: 0,
            ...share,
          };
        });
        const totals = computeTotals(noteLines);
        if (totals.total <= 0) fail('el valor de la nota debe ser mayor que cero');

        // Las retenciones se devuelven en proporción; si la nota agota la factura, con la diferencia exacta.
        const completes = purchase.lines.every((l, i) => l.quantity - purchase.credited.quantity[i] - (noteLines.find((n) => n.lineIndex === i)?.quantity ?? 0) === 0);
        const shares = purchase.withholdings.map((w, i) => {
          const remaining = w.amount - purchase.creditedWithheld[i];
          const proportional = Number(roundDiv(BigInt(w.amount) * BigInt(totals.total), BigInt(purchase.totals.total)));
          return completes ? remaining : Math.min(proportional, remaining);
        });
        const withheldShare = shares.reduce((acc, s) => acc + s, 0);
        const effect = totals.total - withheldShare;
        if (effect <= 0) fail('la nota no tiene valor por reducir de la deuda');

        const debitLines = [{ accountId: purchase.accountsUsed.payable, debit: effect, partyId: purchase.supplier.partyId }];
        purchase.withholdings.forEach((w, i) => {
          if (shares[i] > 0) debitLines.push({ accountId: w.accountId, debit: shares[i] });
        });
        const creditLines = sumByAccountAndCenter(noteLines, (l) => l.net)
          .filter(({ amount }) => amount > 0)
          .map(({ accountId, costCenter, amount }) => ({ accountId, credit: amount, ...(costCenter ? { costCenter } : {}) }));
        if (totals.tax > 0) creditLines.push({ accountId: purchase.accountsUsed.vat, credit: totals.tax });

        const guard = { _id: purchase._id, status: 'posted' };
        const inc = { creditedTotal: totals.total, balance: -effect };
        for (const l of noteLines) {
          guard[`credited.quantity.${l.lineIndex}`] = purchase.credited.quantity[l.lineIndex];
          guard[`credited.net.${l.lineIndex}`] = purchase.credited.net[l.lineIndex];
          guard[`credited.tax.${l.lineIndex}`] = purchase.credited.tax[l.lineIndex];
          inc[`credited.quantity.${l.lineIndex}`] = l.quantity;
          inc[`credited.net.${l.lineIndex}`] = l.net;
          inc[`credited.tax.${l.lineIndex}`] = l.tax;
        }
        shares.forEach((s, i) => {
          guard[`creditedWithheld.${i}`] = purchase.creditedWithheld[i];
          if (s) inc[`creditedWithheld.${i}`] = s;
        });

        const RETRY = Symbol('retry');
        let replayed = false;
        try {
          const posted = await ledger.postJournal(
            tenantId,
            {
              docType: 'NP',
              date: issueDate,
              currency: purchase.currency,
              idempotencyKey: `supplier-note-${idempotencyKey}`,
              description: `Nota de proveedor ${supplierDocNumber} a la compra ${purchase.fullNumber}`,
              source: { kind: 'supplier_note', id: idempotencyKey },
              lines: [...debitLines, ...creditLines],
            },
            {
              inTx: async (session, { journal }) => {
                const reserved = await purchasesOf(tenantId).updateOne(guard, { $inc: inc }, { session });
                if (reserved.matchedCount === 0) throw Object.assign(new Error('reserva'), { [RETRY]: true });
                const outs = noteLines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity, value: l.net, lineIndex: l.lineIndex }));
                if (outs.length) {
                  await inventory.applyExactOut(tenantId, outs, session, { type: 'purchase_return', date: issueDate, source: { kind: 'purchase', id: String(purchase._id) }, userId });
                }
                const { insertedId } = await notesOf(tenantId).insertOne(
                  {
                    idempotencyKey,
                    number: journal.number,
                    fullNumber: `NP${journal.number}`,
                    status: 'posted',
                    purchaseId: purchase._id,
                    purchaseFullNumber: purchase.fullNumber,
                    supplier: purchase.supplier,
                    supplierDocNumber,
                    reason,
                    issueDate,
                    currency: purchase.currency,
                    lines: noteLines.map(({ lineIndex, description, quantity, vatBps, accountId, costCenter, itemId, warehouseId, net, tax, total }) => ({
                      lineIndex,
                      description,
                      quantity,
                      vatBps,
                      accountId,
                      ...(costCenter ? { costCenter } : {}),
                      ...(itemId ? { itemId, warehouseId } : {}),
                      net,
                      tax,
                      total,
                    })),
                    totals,
                    withholdingShares: shares,
                    withheld: withheldShare,
                    effect,
                    journalId: journal._id,
                    createdBy: userId ?? null,
                    createdAt: now(),
                  },
                  session,
                );
                await ctx.auditTx?.(session, { action: 'supplier_note.create', target: insertedId, details: { number: `NP${journal.number}`, purchase: purchase.fullNumber, total: totals.total } });
              },
            },
          );
          replayed = posted.replayed;
        } catch (err) {
          if (err?.[RETRY]) continue; // otra nota se adelantó: se relee y se recalcula
          if (isDuplicate(err, 'tenant_supplier_note_doc')) fail(`la nota ${supplierDocNumber} de ${purchase.supplier.name} ya está registrada`, 'DUPLICATE');
          if (!isDuplicate(err, 'tenant_supplier_note_idempotency')) throw err;
          replayed = true;
        }
        const note = await notesOf(tenantId).findOne({ idempotencyKey });
        if (!note) fail('el asiento de la nota ya existía sin nota: contacta a soporte', 'INVALID_STATE');
        return { note, replayed };
      }
      fail('otra nota se registraba a la vez sobre esta factura: inténtalo de nuevo', 'INVALID_STATE');
    },

    /** Anula una nota de proveedor: reversa su asiento y libera lo que había reservado en la factura. */
    async voidSupplierNote(tenantId, noteId, input = {}, ctx = {}) {
      const note = await notesOf(tenantId).findOne({ _id: new ObjectId(noteId) });
      if (!note) fail('la nota de proveedor no existe', 'NOT_FOUND');
      if (note.status === 'void') return { note, replayed: true };
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : now();
      if (dayOf(date) < dayOf(note.issueDate)) fail('la anulación no puede ser anterior a la nota');

      await ledger.reverseJournal(
        tenantId,
        note.journalId,
        { idempotencyKey: `supplier-note-void-${note._id}`, date, description: `Anulación de la nota ${note.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await notesOf(tenantId).updateOne(
              { _id: note._id, status: 'posted' },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (changed.matchedCount === 0) fail('la nota ya fue anulada', 'INVALID_STATE');
            const release = { creditedTotal: -note.totals.total, balance: note.effect };
            for (const l of note.lines) {
              release[`credited.quantity.${l.lineIndex}`] = -l.quantity;
              release[`credited.net.${l.lineIndex}`] = -l.net;
              release[`credited.tax.${l.lineIndex}`] = -l.tax;
            }
            note.withholdingShares.forEach((s, i) => {
              if (s) release[`creditedWithheld.${i}`] = -s;
            });
            await purchasesOf(tenantId).updateOne({ _id: note.purchaseId }, { $inc: release }, { session });
            const back = note.lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, quantity: l.quantity, value: l.net, lineIndex: l.lineIndex }));
            if (back.length) {
              await inventory.applyIn(tenantId, back, session, { type: 'purchase_return_void', date, source: { kind: 'purchase', id: String(note.purchaseId) }, userId: ctx.userId });
            }
            await ctx.auditTx?.(session, { action: 'supplier_note.void', target: note._id, details: { number: note.fullNumber } });
          },
        },
      );
      return { note: await notesOf(tenantId).findOne({ _id: note._id }), replayed: false };
    },

    getSupplierNote(tenantId, id) {
      return notesOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    async listSupplierNotes(tenantId, { purchaseId, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PURCHASE_PAGE);
      const filter = { ...(purchaseId ? { purchaseId: new ObjectId(purchaseId) } : {}), ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}) };
      const rows = await notesOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },
  };
  return api;
}
