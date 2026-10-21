import { ObjectId } from 'mongodb';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { parseDay as parseCalendarDay } from '../core/dates.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';

export const MAX_BOOK_ROWS = 2000;

export class BooksError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'BooksError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BooksError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const add = (a, b) => assertMinorUnits(a + b, 'suma');

function range(from, to) {
  const start = parseDay(from, 'la fecha inicial');
  const end = parseDay(to, 'la fecha final');
  if (start > end) fail('la fecha inicial no puede ser posterior a la final');
  return { start, end };
}

/** Base e impuesto por tarifa, como un mapa `{ [vatBps]: { base, tax } }`. */
function byRate(totals, sign) {
  const out = {};
  for (const r of totals.taxByRate ?? []) out[r.vatBps] = { base: sign * r.base, tax: sign * r.tax };
  return out;
}

/** Suma las filas de un libro: por tarifa de IVA y en total. */
function sumBook(rows) {
  const rates = new Map();
  const totals = { documents: rows.length, subtotal: 0, tax: 0, total: 0, withheld: 0, payable: 0 };
  for (const row of rows) {
    for (const [bps, v] of Object.entries(row.rates)) {
      const cur = rates.get(Number(bps)) ?? { vatBps: Number(bps), base: 0, tax: 0 };
      cur.base = add(cur.base, v.base);
      cur.tax = add(cur.tax, v.tax);
      rates.set(Number(bps), cur);
    }
    totals.subtotal = add(totals.subtotal, row.subtotal);
    totals.tax = add(totals.tax, row.tax);
    totals.total = add(totals.total, row.total);
    totals.withheld = add(totals.withheld, row.withheld ?? 0);
    totals.payable = add(totals.payable, row.payable ?? 0);
  }
  return { ...totals, rates: [...rates.values()].sort((a, b) => a.vatBps - b.vatBps) };
}

/*
 * Libros y estados de cuenta, calculados desde los documentos (no desde el libro contable): son listados de lo que se
 * emitió o se registró, con su base e impuesto por tarifa, para revisar con el contador o presentar un tercero.
 * Solo leen. Un rango con más de MAX_BOOK_ROWS filas se rechaza: se pide uno más corto (el mes es lo habitual).
 *
 * Los estados de cuenta incluyen los anticipos (saldo a favor del cliente, o dinero ya entregado al proveedor); aplicar un
 * anticipo a un documento no es un movimiento nuevo: su dinero ya estaba contado.
 *
 * Límites: el libro de ventas lista facturas y notas crédito emitidas; no incluye las ventas de mostrador (todavía no
 * tienen documento electrónico). Los formatos no están validados por un contador ni siguen un formato oficial de la DIAN.
 */
export function createBooksService(db) {
  const col = (name, tenantId) => new TenantCollection(db.collection(name), tenantId);

  async function capped(cursor, label) {
    const rows = await cursor.limit(MAX_BOOK_ROWS + 1).toArray();
    if (rows.length > MAX_BOOK_ROWS) fail(`el rango tiene más de ${MAX_BOOK_ROWS} ${label}: elige uno más corto`, 'RANGE_TOO_LARGE');
    return rows;
  }

  const partyOf = (p) => ({ name: p.name, taxIdType: p.taxIdType, taxId: p.taxId, ...(p.checkDigit !== undefined ? { checkDigit: p.checkDigit } : {}) });
  const byDate = (a, b) => a.date - b.date || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);

  return {
    /** Libro de ventas: facturas emitidas (suman) y notas crédito emitidas (restan), con su base e IVA por tarifa. */
    async salesBook(tenantId, { from, to, currency }) {
      assertCurrency(currency);
      const { start, end } = range(from, to);
      const filter = { currency, status: 'issued', issueDate: { $gte: start, $lte: end } };
      const [invoices, notes] = await Promise.all([
        capped(col(COLLECTIONS.invoices, tenantId).find(filter, { sort: { issueDate: 1, _id: 1 } }), 'facturas'),
        capped(col(COLLECTIONS.creditNotes, tenantId).find(filter, { sort: { issueDate: 1, _id: 1 } }), 'notas crédito'),
      ]);
      const rows = [
        ...invoices.map((d) => ({ kind: 'invoice', id: d._id, order: String(d._id), date: d.issueDate, number: d.fullNumber, party: partyOf(d.customer), rates: byRate(d.totals, 1), subtotal: d.totals.subtotal, tax: d.totals.tax, total: d.totals.total, paymentMethod: d.paymentMethod })),
        ...notes.map((d) => ({ kind: 'credit_note', id: d._id, order: String(d._id), date: d.issueDate, number: d.fullNumber, party: partyOf(d.customer), rates: byRate(d.totals, -1), subtotal: 0 - d.totals.subtotal, tax: 0 - d.totals.tax, total: 0 - d.totals.total, reference: d.invoiceFullNumber })),
      ].sort(byDate);
      return { from, to, currency, rows: rows.map(({ order, ...r }) => r), totals: sumBook(rows) };
    },

    /** Libro de compras: facturas de compra vigentes (suman) y notas de proveedor vigentes (restan), con retenciones. */
    async purchasesBook(tenantId, { from, to, currency }) {
      assertCurrency(currency);
      const { start, end } = range(from, to);
      const filter = { currency, status: 'posted', issueDate: { $gte: start, $lte: end } };
      const [purchases, notes] = await Promise.all([
        capped(col(COLLECTIONS.purchases, tenantId).find(filter, { sort: { issueDate: 1, _id: 1 } }), 'compras'),
        capped(col(COLLECTIONS.supplierNotes, tenantId).find(filter, { sort: { issueDate: 1, _id: 1 } }), 'notas de proveedor'),
      ]);
      const rows = [
        ...purchases.map((d) => ({ kind: 'purchase', id: d._id, order: String(d._id), date: d.issueDate, number: d.fullNumber, supplierDocNumber: d.supplierDocNumber, party: partyOf(d.supplier), rates: byRate(d.totals, 1), subtotal: d.totals.subtotal, tax: d.totals.tax, total: d.totals.total, withheld: d.withheld, payable: d.payable })),
        ...notes.map((d) => ({ kind: 'supplier_note', id: d._id, order: String(d._id), date: d.issueDate, number: d.fullNumber, supplierDocNumber: d.supplierDocNumber, party: partyOf(d.supplier), rates: byRate(d.totals, -1), subtotal: 0 - d.totals.subtotal, tax: 0 - d.totals.tax, total: 0 - d.totals.total, withheld: 0 - d.withheld, payable: 0 - d.effect, reference: d.purchaseFullNumber })),
      ].sort(byDate);
      return { from, to, currency, rows: rows.map(({ order, ...r }) => r), totals: sumBook(rows) };
    },

    /**
     * Estado de cuenta de un cliente: facturas a crédito (aumentan lo que debe), notas crédito sobre ellas y recibos de
     * caja (lo disminuyen). Saldo inicial, movimientos del rango con saldo corrido y saldo final.
     */
    async customerStatement(tenantId, { partyId, from, to, currency }) {
      assertCurrency(currency);
      const { start, end } = range(from, to);
      if (!/^[a-f0-9]{24}$/.test(String(partyId))) fail('cliente inválido');
      const id = new ObjectId(partyId);
      const party = await col(COLLECTIONS.parties, tenantId).findOne({ _id: id });
      if (!party) fail('el cliente no existe', 'NOT_FOUND');

      const invoiceFilter = { 'customer.partyId': id, currency, status: 'issued', collectible: true };
      const noteFilter = { 'customer.partyId': id, currency, status: 'issued' };
      const receiptFilter = { partyId: id, currency, status: 'posted' };
      const [invoices, notesAll, receipts, advances] = await Promise.all([
        col(COLLECTIONS.invoices, tenantId).find({ ...invoiceFilter, issueDate: { $lte: end } }, { projection: { fullNumber: 1, issueDate: 1, dueDate: 1, totals: 1 } }).toArray(),
        col(COLLECTIONS.creditNotes, tenantId).find({ ...noteFilter, issueDate: { $lte: end } }, { projection: { fullNumber: 1, issueDate: 1, totals: 1, invoiceId: 1, invoiceFullNumber: 1 } }).toArray(),
        col(COLLECTIONS.receipts, tenantId).find({ ...receiptFilter, date: { $lte: end } }, { projection: { fullNumber: 1, date: 1, total: 1 } }).toArray(),
        // Un anticipo es dinero que el cliente ya entregó: baja lo que debe (o lo deja a su favor) desde que lo entrega.
        col(COLLECTIONS.advances, tenantId).find({ kind: 'customer', partyId: id, currency, status: 'posted', date: { $lte: end } }, { projection: { fullNumber: 1, date: 1, amount: 1 } }).toArray(),
      ]);
      // Una nota solo cambia lo que el cliente debe si su factura era a crédito.
      const collectibleIds = new Set(
        (await col(COLLECTIONS.invoices, tenantId).find({ _id: { $in: notesAll.map((n) => n.invoiceId) }, collectible: true }, { projection: { _id: 1 } }).toArray()).map((i) => String(i._id)),
      );
      const movements = [
        ...invoices.map((d) => ({ kind: 'invoice', date: d.issueDate, number: d.fullNumber, detail: 'Factura', dueDate: d.dueDate, debit: d.totals.total, credit: 0, order: String(d._id) })),
        ...notesAll.filter((n) => collectibleIds.has(String(n.invoiceId))).map((d) => ({ kind: 'credit_note', date: d.issueDate, number: d.fullNumber, detail: `Nota crédito a ${d.invoiceFullNumber}`, debit: 0, credit: d.totals.total, order: String(d._id) })),
        ...receipts.map((d) => ({ kind: 'receipt', date: d.date, number: d.fullNumber, detail: 'Recibo de caja', debit: 0, credit: d.total, order: String(d._id) })),
        ...advances.map((d) => ({ kind: 'advance', date: d.date, number: d.fullNumber, detail: 'Anticipo', debit: 0, credit: d.amount, order: String(d._id) })),
      ].sort(byDate);
      return statement({ party, from, to, currency, start, movements });
    },

    /** Estado de cuenta de un proveedor: compras (lo que se le debe, ya sin retenciones), notas de proveedor y pagos. */
    async supplierStatement(tenantId, { partyId, from, to, currency }) {
      assertCurrency(currency);
      const { start, end } = range(from, to);
      if (!/^[a-f0-9]{24}$/.test(String(partyId))) fail('proveedor inválido');
      const id = new ObjectId(partyId);
      const party = await col(COLLECTIONS.parties, tenantId).findOne({ _id: id });
      if (!party) fail('el proveedor no existe', 'NOT_FOUND');
      const [purchases, notes, payments, advances] = await Promise.all([
        col(COLLECTIONS.purchases, tenantId).find({ 'supplier.partyId': id, currency, status: 'posted', issueDate: { $lte: end } }, { projection: { fullNumber: 1, issueDate: 1, dueDate: 1, supplierDocNumber: 1, payable: 1 } }).toArray(),
        col(COLLECTIONS.supplierNotes, tenantId).find({ 'supplier.partyId': id, currency, status: 'posted', issueDate: { $lte: end } }, { projection: { fullNumber: 1, issueDate: 1, supplierDocNumber: 1, purchaseFullNumber: 1, effect: 1 } }).toArray(),
        col(COLLECTIONS.payments, tenantId).find({ partyId: id, currency, status: 'posted', date: { $lte: end } }, { projection: { fullNumber: 1, date: 1, total: 1 } }).toArray(),
        col(COLLECTIONS.advances, tenantId).find({ kind: 'supplier', partyId: id, currency, status: 'posted', date: { $lte: end } }, { projection: { fullNumber: 1, date: 1, amount: 1 } }).toArray(),
      ]);
      // Para un proveedor, «debe» es lo que se le debe: las compras lo aumentan (crédito) y las notas y pagos lo disminuyen (débito).
      const movements = [
        ...purchases.map((d) => ({ kind: 'purchase', date: d.issueDate, number: d.fullNumber, detail: `${d.kind === 'debit_note' ? 'Nota débito' : 'Factura'} ${d.supplierDocNumber}`, dueDate: d.dueDate, debit: 0, credit: d.payable, order: String(d._id) })),
        ...notes.map((d) => ({ kind: 'supplier_note', date: d.issueDate, number: d.fullNumber, detail: `Nota ${d.supplierDocNumber} a ${d.purchaseFullNumber}`, debit: d.effect, credit: 0, order: String(d._id) })),
        ...payments.map((d) => ({ kind: 'payment', date: d.date, number: d.fullNumber, detail: 'Comprobante de egreso', debit: d.total, credit: 0, order: String(d._id) })),
        ...advances.map((d) => ({ kind: 'advance', date: d.date, number: d.fullNumber, detail: 'Anticipo entregado', debit: d.amount, credit: 0, order: String(d._id) })),
      ].sort(byDate);
      return statement({ party, from, to, currency, start, movements, owed: true });
    },

    /** Ventas netas (facturas menos notas crédito) por cliente o por mes del rango. */
    async salesSummary(tenantId, { by, from, to, currency }) {
      if (!['customer', 'month'].includes(by)) fail('agrupa por cliente o por mes');
      assertCurrency(currency);
      const { start, end } = range(from, to);
      const filter = { currency, status: 'issued', issueDate: { $gte: start, $lte: end } };
      const key = by === 'customer' ? { id: '$customer.partyId', name: '$customer.name', taxId: '$customer.taxId' } : { id: { $dateToString: { format: '%Y-%m', date: '$issueDate' } } };
      const group = (sign) => [
        { $match: filter },
        { $group: { _id: key, documents: { $sum: 1 }, subtotal: { $sum: '$totals.subtotal' }, tax: { $sum: '$totals.tax' }, total: { $sum: '$totals.total' } } },
        { $project: { documents: 1, subtotal: { $multiply: ['$subtotal', sign] }, tax: { $multiply: ['$tax', sign] }, total: { $multiply: ['$total', sign] } } },
      ];
      const [inv, cn] = await Promise.all([
        col(COLLECTIONS.invoices, tenantId).aggregate(group(1)).toArray(),
        col(COLLECTIONS.creditNotes, tenantId).aggregate(group(-1)).toArray(),
      ]);
      const map = new Map();
      for (const [list, field] of [[inv, 'invoices'], [cn, 'notes']]) {
        for (const r of list) {
          const k = by === 'customer' ? String(r._id.id) : r._id.id;
          const row = map.get(k) ?? { key: k, ...(by === 'customer' ? { name: r._id.name, taxId: r._id.taxId } : {}), invoices: 0, notes: 0, subtotal: 0, tax: 0, total: 0 };
          row[field] += r.documents;
          row.subtotal = add(row.subtotal, Number(r.subtotal));
          row.tax = add(row.tax, Number(r.tax));
          row.total = add(row.total, Number(r.total));
          map.set(k, row);
        }
      }
      const rows = [...map.values()].sort(by === 'month' ? (a, b) => (a.key < b.key ? -1 : 1) : (a, b) => b.total - a.total);
      const totals = rows.reduce((acc, r) => ({ invoices: acc.invoices + r.invoices, notes: acc.notes + r.notes, subtotal: add(acc.subtotal, r.subtotal), tax: add(acc.tax, r.tax), total: add(acc.total, r.total) }), { invoices: 0, notes: 0, subtotal: 0, tax: 0, total: 0 });
      return { by, from, to, currency, rows, totals };
    },
  };
}

/** Saldo inicial (lo anterior al rango), movimientos del rango con saldo corrido y saldo final. */
function statement({ party, from, to, currency, start, movements, owed = false }) {
  let opening = 0;
  const inRange = [];
  for (const m of movements) {
    const net = owed ? m.credit - m.debit : m.debit - m.credit;
    if (m.date < start) opening = add(opening, net);
    else inRange.push({ ...m, net });
  }
  if (inRange.length > MAX_BOOK_ROWS) fail(`el rango tiene más de ${MAX_BOOK_ROWS} movimientos: elige uno más corto`, 'RANGE_TOO_LARGE');
  let balance = opening;
  let debit = 0;
  let credit = 0;
  const rows = inRange.map(({ net, order, ...m }) => {
    balance = add(balance, net);
    debit = add(debit, m.debit);
    credit = add(credit, m.credit);
    return { ...m, balance };
  });
  return {
    party: { _id: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId, ...(party.checkDigit !== undefined ? { checkDigit: party.checkDigit } : {}) },
    from,
    to,
    currency,
    opening,
    rows,
    totals: { debit, credit },
    closing: balance,
  };
}
