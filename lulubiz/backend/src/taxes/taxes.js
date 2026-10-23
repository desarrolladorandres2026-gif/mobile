import { ObjectId } from 'mongodb';
import { DAY_MS, dayOf, parseDay as parseCalendarDay } from '../core/dates.js';
import { assertCurrency } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';
import { roundDiv } from '../invoicing/tax.js';

export const MAX_NOTES = 5000;
export const CLOSE_DOC_TYPE = 'CI';

export class TaxError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new TaxError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);

function range(from, to) {
  const start = parseDay(from, 'la fecha inicial');
  const end = parseDay(to, 'la fecha final');
  if (start > end) fail('la fecha inicial no puede ser posterior a la final');
  return { start, end, endExclusive: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) + DAY_MS) };
}

/*
 * Impuestos, calculados desde los documentos y contrastados con el libro.
 *
 *  - **IVA**: generado (facturas emitidas y ventas de mostrador, menos notas crédito) y descontable (compras y notas débito del
 *    proveedor, menos notas de proveedor), por tarifa, con la base y el impuesto de cada una. El neto es lo que se debe o queda a
 *    favor. Cada lado se compara con el movimiento de su cuenta en el libro del mismo rango: una diferencia es un asiento manual
 *    sobre la cuenta o un documento anterior a su configuración.
 *  - **Retenciones practicadas** en las compras (por concepto y por proveedor), menos lo devuelto por las notas de proveedor,
 *    y el **certificado de retenciones** de un proveedor en un año. La retención de nómina está en los reportes de nómina.
 *  - **Cierre de IVA** de un período (mes, bimestre, cuatrimestre): un asiento `CI` que cruza el IVA generado contra el descontable
 *    con los saldos del libro del rango y deja el resultado en una cuenta de IVA por pagar o de saldo a favor. Un rango no se cierra
 *    dos veces ni se traslapa con otro vigente; se anula reversando el asiento.
 *
 * Límites: la fecha de cada documento es la de emisión (no la de pago); no hay IVA por tarifas diferenciales de bienes, ni el
 * ICA más allá de su informe, ni los formularios de la DIAN (solo la base para prepararlos).
 */
export function createTaxService({ db, ledger, accounts, settings, now = () => new Date() }) {
  const col = (name, tenantId) => new TenantCollection(db.collection(name), tenantId);
  const closesOf = (tenantId) => col(COLLECTIONS.taxCloses, tenantId);
  const journalsOf = (tenantId) => col(COLLECTIONS.journals, tenantId);

  /** Base e IVA por tarifa de un conjunto de documentos, con el número de documentos. */
  async function ratesOf(name, tenantId, match) {
    const [rows, count] = await Promise.all([
      col(name, tenantId)
        .aggregate([{ $match: match }, { $unwind: '$totals.taxByRate' }, { $group: { _id: '$totals.taxByRate.vatBps', base: { $sum: '$totals.taxByRate.base' }, tax: { $sum: '$totals.taxByRate.tax' } } }])
        .toArray(),
      col(name, tenantId).countDocuments(match),
    ]);
    return { documents: count, rates: new Map(rows.map((r) => [r._id, { base: Number(r.base), tax: Number(r.tax) }])) };
  }

  /** Suma `plus` y resta `minus`, por tarifa. */
  function combine(plus, minus) {
    const out = new Map();
    const put = (rate, base, tax) => {
      const cur = out.get(rate) ?? { vatBps: rate, base: 0, tax: 0 };
      cur.base += base;
      cur.tax += tax;
      out.set(rate, cur);
    };
    for (const part of plus) for (const [rate, v] of part.rates) put(rate, v.base, v.tax);
    for (const part of minus) for (const [rate, v] of part.rates) put(rate, -v.base, -v.tax);
    const rates = [...out.values()].sort((a, b) => a.vatBps - b.vatBps);
    return { rates, base: sum(rates, (r) => r.base), tax: sum(rates, (r) => r.tax) };
  }

  /** Movimiento de una cuenta en el libro en un rango, sin los asientos de cierre de IVA: débito menos crédito. */
  async function ledgerNet(tenantId, currency, accountId, start, endExclusive) {
    if (!accountId) return null;
    const [row] = await journalsOf(tenantId)
      .aggregate([
        { $match: { currency, docType: { $ne: CLOSE_DOC_TYPE }, date: { $gte: start, $lt: endExclusive }, 'lines.accountId': accountId } },
        { $unwind: '$lines' },
        { $match: { 'lines.accountId': accountId } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ])
      .toArray();
    return row ? Number(row.debit) - Number(row.credit) : 0;
  }

  const api = {
    async vat(tenantId, { from, to, currency }) {
      assertCurrency(currency);
      const { start, end, endExclusive } = range(from, to);
      const between = (field) => ({ currency, [field]: { $gte: start, $lt: endExclusive } });
      const [invoices, pos, notes, purchases, supplierNotes, cfg] = await Promise.all([
        ratesOf(COLLECTIONS.invoices, tenantId, { ...between('issueDate'), status: 'issued' }),
        ratesOf(COLLECTIONS.posSales, tenantId, { ...between('date'), status: 'posted' }),
        ratesOf(COLLECTIONS.creditNotes, tenantId, { ...between('issueDate'), status: 'issued' }),
        ratesOf(COLLECTIONS.purchases, tenantId, { ...between('issueDate'), status: 'posted' }),
        ratesOf(COLLECTIONS.supplierNotes, tenantId, { ...between('issueDate'), status: 'posted' }),
        settings.get(tenantId),
      ]);
      const generated = combine([invoices, pos], [notes]);
      const deductible = combine([purchases], [supplierNotes]);
      const payableAccount = cfg?.accounts?.vatPayable ?? null;
      const deductibleAccount = cfg?.accounts?.vatDeductible ?? null;
      const [payableLedger, deductibleLedger] = await Promise.all([ledgerNet(tenantId, currency, payableAccount, start, endExclusive), ledgerNet(tenantId, currency, deductibleAccount, start, endExclusive)]);
      const names = new Map((await accounts.list(tenantId)).map((a) => [a.code, a.name]));
      // El IVA por pagar es de naturaleza crédito (su movimiento sube con el crédito); el descontable, de débito.
      const ledgerGenerated = payableLedger === null ? null : 0 - payableLedger;
      const ledgerDeductible = deductibleLedger;
      return {
        from: dayOf(start),
        to: dayOf(end),
        currency,
        generated: { ...generated, documents: { invoices: invoices.documents, posSales: pos.documents, creditNotes: notes.documents } },
        deductible: { ...deductible, documents: { purchases: purchases.documents, supplierNotes: supplierNotes.documents } },
        net: generated.tax - deductible.tax,
        ledger: {
          generated: { account: payableAccount, name: names.get(payableAccount) ?? null, amount: ledgerGenerated, difference: ledgerGenerated === null ? null : ledgerGenerated - generated.tax },
          deductible: { account: deductibleAccount, name: names.get(deductibleAccount) ?? null, amount: ledgerDeductible, difference: ledgerDeductible === null ? null : ledgerDeductible - deductible.tax },
        },
      };
    },

    /** Retenciones practicadas en las compras de un rango, por concepto y por proveedor, netas de las notas de proveedor. */
    async withholdings(tenantId, { from, to, currency, supplierId }) {
      assertCurrency(currency);
      const { start, endExclusive, end } = range(from, to);
      const supplierMatch = supplierId ? { 'supplier.partyId': /^[a-f0-9]{24}$/.test(String(supplierId)) ? new ObjectId(supplierId) : fail('proveedor inválido') } : {};
      const match = { currency, status: 'posted', issueDate: { $gte: start, $lt: endExclusive }, ...supplierMatch };
      const purchases = await col(COLLECTIONS.purchases, tenantId).find({ ...match, 'withholdings.0': { $exists: true } }, { projection: { withholdings: 1, supplier: 1, fullNumber: 1 } }).toArray();
      const noteDocs = await col(COLLECTIONS.supplierNotes, tenantId).find({ ...match, withheld: { $gt: 0 } }, { limit: MAX_NOTES + 1, projection: { purchaseId: 1, withholdingShares: 1, supplier: 1 } }).toArray();
      if (noteDocs.length > MAX_NOTES) fail(`el rango tiene más de ${MAX_NOTES} notas con retención: elige uno más corto`, 'RANGE_TOO_LARGE');
      // Una nota devuelve retención de una compra que puede ser de un rango anterior: se leen sus conceptos.
      const owners = new Map((await col(COLLECTIONS.purchases, tenantId).find({ _id: { $in: [...new Set(noteDocs.map((n) => String(n.purchaseId)))].map((id) => new ObjectId(id)) } }, { projection: { withholdings: 1 } }).toArray()).map((p) => [String(p._id), p]));

      const concepts = new Map();
      const suppliers = new Map();
      const add = (supplier, w, base, amount) => {
        const key = `${w.name}|${w.accountId}|${w.rateBps}|${w.basis}`;
        const c = concepts.get(key) ?? { name: w.name, accountId: w.accountId, rateBps: w.rateBps, basis: w.basis, base: 0, amount: 0 };
        c.base += base;
        c.amount += amount;
        concepts.set(key, c);
        const sKey = String(supplier.partyId);
        const s = suppliers.get(sKey) ?? { partyId: supplier.partyId, name: supplier.name, taxIdType: supplier.taxIdType, taxId: supplier.taxId, base: 0, amount: 0 };
        s.base += base;
        s.amount += amount;
        suppliers.set(sKey, s);
      };
      for (const p of purchases) for (const w of p.withholdings) add(p.supplier, w, w.base, w.amount);
      for (const n of noteDocs) {
        const owner = owners.get(String(n.purchaseId));
        (n.withholdingShares ?? []).forEach((share, i) => {
          const w = owner?.withholdings?.[i];
          if (!w || !share) return;
          // La base devuelta es la misma proporción de la base original que lo devuelto de la retención.
          const base = w.amount > 0 ? Number(roundDiv(BigInt(w.base) * BigInt(share), BigInt(w.amount))) : 0;
          add(n.supplier, w, -base, -share);
        });
      }
      const conceptRows = [...concepts.values()].filter((c) => c.amount !== 0 || c.base !== 0).sort((a, b) => (a.accountId + a.name < b.accountId + b.name ? -1 : 1));
      const supplierRows = [...suppliers.values()].filter((s) => s.amount !== 0).sort((a, b) => (a.name < b.name ? -1 : 1));
      return { from: dayOf(start), to: dayOf(end), currency, concepts: conceptRows, suppliers: supplierRows, totals: { base: sum(conceptRows, (c) => c.base), amount: sum(conceptRows, (c) => c.amount) } };
    },

    /** Retenciones que los clientes nos practicaron al pagar (recibos de caja vigentes), por concepto y por cliente. */
    async withholdingsSuffered(tenantId, { from, to, currency, customerId }) {
      assertCurrency(currency);
      const { start, endExclusive, end } = range(from, to);
      const customerMatch = customerId ? { partyId: /^[a-f0-9]{24}$/.test(String(customerId)) ? new ObjectId(customerId) : fail('cliente inválido') } : {};
      const receipts = await col(COLLECTIONS.receipts, tenantId)
        .find({ currency, status: 'posted', date: { $gte: start, $lt: endExclusive }, 'withholdings.0': { $exists: true }, ...customerMatch }, { limit: MAX_NOTES + 1, projection: { withholdings: 1, party: 1, partyId: 1, fullNumber: 1 } })
        .toArray();
      if (receipts.length > MAX_NOTES) fail(`el rango tiene más de ${MAX_NOTES} recibos con retención: elige uno más corto`, 'RANGE_TOO_LARGE');
      const concepts = new Map();
      const customers = new Map();
      for (const r of receipts) {
        for (const w of r.withholdings) {
          const key = `${w.name}|${w.accountId}`;
          const c = concepts.get(key) ?? { name: w.name, accountId: w.accountId, amount: 0 };
          c.amount += w.amount;
          concepts.set(key, c);
          const cust = customers.get(String(r.partyId)) ?? { partyId: r.partyId, name: r.party.name, taxIdType: r.party.taxIdType, taxId: r.party.taxId, amount: 0 };
          cust.amount += w.amount;
          customers.set(String(r.partyId), cust);
        }
      }
      const conceptRows = [...concepts.values()].sort((a, b) => (a.accountId + a.name < b.accountId + b.name ? -1 : 1));
      return { from: dayOf(start), to: dayOf(end), currency, concepts: conceptRows, customers: [...customers.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), total: sum(conceptRows, (c) => c.amount) };
    },

    /** Certificado de retenciones de un proveedor en un año: lo que se le retuvo, por concepto. */
    async certificate(tenantId, { supplierId, year, currency }) {
      if (!/^\d{4}$/.test(String(year ?? ''))) fail('el año debe tener cuatro cifras');
      if (!/^[a-f0-9]{24}$/.test(String(supplierId ?? ''))) fail('proveedor inválido');
      const party = await col(COLLECTIONS.parties, tenantId).findOne({ _id: new ObjectId(supplierId) });
      if (!party) fail('el proveedor no existe', 'NOT_FOUND');
      const report = await api.withholdings(tenantId, { from: `${year}-01-01`, to: `${year}-12-31`, currency, supplierId });
      const cfg = await settings.get(tenantId);
      return {
        year: Number(year),
        currency,
        issuer: cfg?.issuer ? { name: cfg.issuer.name, taxIdType: cfg.issuer.taxIdType, taxId: cfg.issuer.taxId, checkDigit: cfg.issuer.checkDigit ?? null } : null,
        supplier: { _id: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId, checkDigit: party.checkDigit ?? null },
        concepts: report.concepts,
        totals: report.totals,
        issuedOn: dayOf(now()),
      };
    },

    /**
     * Base y valor del ICA de un rango: el movimiento neto (crédito menos débito) de las cuentas de ingreso del libro, sin los
     * asientos de cierre de ejercicio y sin las cuentas excluidas (ingresos no gravados, como los no operacionales). La tarifa
     * la fija quien declara, en partes por millón (9,66 por mil = 9660), porque cambia por municipio y por actividad.
     * Las devoluciones y rebajas ya restan porque son cuentas de ingreso con saldo débito.
     */
    async ica(tenantId, { from, to, currency, ratePpm, excludeAccounts = [] }) {
      assertCurrency(currency);
      const { start, end, endExclusive } = range(from, to);
      if (!Number.isSafeInteger(ratePpm) || ratePpm < 0 || ratePpm > 100_000) fail('la tarifa debe estar entre 0 y 100 por mil');
      const excluded = new Set(excludeAccounts.map((c) => String(c).trim()));
      const income = (await accounts.list(tenantId)).filter((a) => a.type === 'income' && a.postable !== false);
      const known = new Set(income.map((a) => a.code));
      for (const code of excluded) if (!known.has(code)) fail(`la cuenta ${code} no es una cuenta de ingreso que se pueda excluir`);
      const rows = await journalsOf(tenantId)
        .aggregate([
          { $match: { currency, docType: { $nin: ['CA'] }, date: { $gte: start, $lt: endExclusive }, 'lines.accountId': { $in: income.map((a) => a.code) } } },
          { $unwind: '$lines' },
          { $match: { 'lines.accountId': { $in: income.map((a) => a.code) } } },
          { $group: { _id: '$lines.accountId', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
        ])
        .toArray();
      const byCode = new Map(rows.map((r) => [r._id, Number(r.credit) - Number(r.debit)]));
      const lines = income
        .filter((a) => byCode.has(a.code))
        .map((a) => ({ account: a.code, name: a.name, amount: byCode.get(a.code), excluded: excluded.has(a.code) }))
        .sort((a, b) => (a.account < b.account ? -1 : 1));
      const total = sum(lines, (l) => l.amount);
      const base = sum(lines.filter((l) => !l.excluded), (l) => l.amount);
      // Una base negativa (más devoluciones que ventas) no genera impuesto a favor: el ICA no se devuelve por este informe.
      const taxable = base > 0 ? base : 0;
      const ica = Number(roundDiv(BigInt(taxable) * BigInt(ratePpm), 1_000_000n));
      return { from: dayOf(start), to: dayOf(end), currency, ratePpm, lines, total, excludedTotal: total - base, base, ica };
    },

    /**
     * Base para la información exógena de un año, por tercero: ingresos (facturas y notas crédito), compras y gastos (compras y
     * sus notas), retenciones practicadas a proveedores y retenciones que nos practicaron los clientes. Los topes mínimos de
     * reporte y los formatos cambian cada año y los fija la DIAN: `minAmount` solo oculta a los terceros por debajo del tope que
     * indique quien declara (en unidad menor). Las ventas de mostrador no tienen tercero y salen aparte, en una sola cifra.
     */
    async exogena(tenantId, { year, currency, minAmount = 0 }) {
      assertCurrency(currency);
      if (!/^\d{4}$/.test(String(year ?? ''))) fail('el año debe tener cuatro cifras');
      if (!Number.isSafeInteger(minAmount) || minAmount < 0) fail('el tope debe ser un entero mayor o igual a cero');
      const { start, end, endExclusive } = range(`${year}-01-01`, `${year}-12-31`);
      const by = async (name, party, dateField, status) =>
        col(name, tenantId)
          .aggregate([
            { $match: { currency, status, [dateField]: { $gte: start, $lt: endExclusive } } },
            { $group: { _id: `$${party}.partyId`, name: { $first: `$${party}.name` }, taxIdType: { $first: `$${party}.taxIdType` }, taxId: { $first: `$${party}.taxId` }, total: { $sum: '$totals.total' }, tax: { $sum: '$totals.tax' } } },
          ])
          .toArray();
      const merge = (plus, minus) => {
        const out = new Map();
        const put = (r, sign) => {
          const key = String(r._id);
          const cur = out.get(key) ?? { partyId: r._id, name: r.name, taxIdType: r.taxIdType, taxId: r.taxId, base: 0, tax: 0 };
          cur.base += sign * (Number(r.total) - Number(r.tax));
          cur.tax += sign * Number(r.tax);
          out.set(key, cur);
        };
        plus.flat().forEach((r) => put(r, 1));
        minus.flat().forEach((r) => put(r, -1));
        return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      };
      const [invoices, notes, purchases, supplierNotes, pos, practiced, suffered] = await Promise.all([
        by(COLLECTIONS.invoices, 'customer', 'issueDate', 'issued'),
        by(COLLECTIONS.creditNotes, 'customer', 'issueDate', 'issued'),
        by(COLLECTIONS.purchases, 'supplier', 'issueDate', 'posted'),
        by(COLLECTIONS.supplierNotes, 'supplier', 'issueDate', 'posted'),
        col(COLLECTIONS.posSales, tenantId)
          .aggregate([{ $match: { currency, status: 'posted', date: { $gte: start, $lt: endExclusive } } }, { $group: { _id: null, total: { $sum: '$totals.total' }, tax: { $sum: '$totals.tax' } } }])
          .toArray(),
        api.withholdings(tenantId, { from: dayOf(start), to: dayOf(end), currency }),
        api.withholdingsSuffered(tenantId, { from: dayOf(start), to: dayOf(end), currency }),
      ]);
      const keep = (rows, pick) => rows.filter((r) => Math.abs(pick(r)) >= minAmount);
      const incomeAll = merge([invoices], [notes]);
      const costsAll = merge([purchases], [supplierNotes]);
      const income = keep(incomeAll, (r) => r.base);
      const costs = keep(costsAll, (r) => r.base);
      const posNet = pos[0] ? Number(pos[0].total) - Number(pos[0].tax) : 0;
      return {
        year: Number(year),
        currency,
        minAmount,
        income: { parties: income, counterOfSale: posNet, total: sum(incomeAll, (r) => r.base) + posNet },
        costs: { parties: costs, total: sum(costsAll, (r) => r.base) },
        withheldFromSuppliers: { parties: keep(practiced.suppliers, (r) => r.amount), total: practiced.totals.amount },
        withheldByCustomers: { parties: keep(suffered.customers, (r) => r.amount), total: suffered.total },
      };
    },

    // ---- Cierre de IVA ----

    /** Calcula el cierre de un rango con los saldos del libro, sin guardar. */
    async previewClose(tenantId, { from, to, currency }) {
      assertCurrency(currency);
      const { start, end, endExclusive } = range(from, to);
      const cfg = await settings.get(tenantId);
      const payableAccount = cfg?.accounts?.vatPayable;
      const deductibleAccount = cfg?.accounts?.vatDeductible;
      if (!payableAccount || !deductibleAccount) fail('faltan las cuentas de IVA por pagar y de IVA descontable (en Facturación)', 'SETTINGS_INCOMPLETE');
      const [payableLedger, deductibleLedger] = await Promise.all([ledgerNet(tenantId, currency, payableAccount, start, endExclusive), ledgerNet(tenantId, currency, deductibleAccount, start, endExclusive)]);
      const generated = 0 - payableLedger;
      const deductible = deductibleLedger;
      const overlap = await closesOf(tenantId).findOne({ currency, status: 'posted', from: { $lte: end }, to: { $gte: start } });
      return { from: dayOf(start), to: dayOf(end), currency, payableAccount, deductibleAccount, generated, deductible, net: generated - deductible, overlap: overlap ? { _id: overlap._id, from: dayOf(overlap.from), to: dayOf(overlap.to), document: overlap.document } : null };
    },

    async close(tenantId, input, ctx = {}) {
      const preview = await api.previewClose(tenantId, input);
      if (preview.overlap) fail(`el rango se traslapa con el cierre ${preview.overlap.document} (${preview.overlap.from} a ${preview.overlap.to})`, 'DUPLICATE');
      if (preview.generated === 0 && preview.deductible === 0) fail('no hay IVA en el libro en ese rango: no hay nada que cerrar');
      const diff = preview.net;
      const dueAccount = String(input.dueAccount ?? '').trim();
      const creditAccount = String(input.creditAccount ?? '').trim();
      const side = diff > 0 ? { code: dueAccount, type: 'liability', label: 'la cuenta de IVA por pagar a la DIAN' } : diff < 0 ? { code: creditAccount, type: 'asset', label: 'la cuenta de saldo a favor de IVA' } : null;
      if (side) {
        if (!/^[0-9]{1,12}$/.test(side.code)) fail(`indica ${side.label}`);
        const problems = await accounts.postingProblems(tenantId, [side.code]);
        if (problems.length) fail(problems.join('; '));
        if ((await accounts.get(tenantId, side.code)).type !== side.type) fail(`${side.label} debe ser de ${side.type === 'liability' ? 'pasivo' : 'activo'}`);
        if ([preview.payableAccount, preview.deductibleAccount].includes(side.code)) fail('esa cuenta no puede ser la de IVA por pagar ni la de IVA descontable');
      }
      // El IVA generado se cancela al débito y el descontable al crédito; la diferencia queda en la cuenta del resultado.
      const lines = [];
      if (preview.generated > 0) lines.push({ accountId: preview.payableAccount, debit: preview.generated });
      else if (preview.generated < 0) lines.push({ accountId: preview.payableAccount, credit: -preview.generated });
      if (preview.deductible > 0) lines.push({ accountId: preview.deductibleAccount, credit: preview.deductible });
      else if (preview.deductible < 0) lines.push({ accountId: preview.deductibleAccount, debit: -preview.deductible });
      if (diff > 0) lines.push({ accountId: side.code, credit: diff });
      else if (diff < 0) lines.push({ accountId: side.code, debit: -diff });
      const id = new ObjectId();
      const date = parseDay(preview.to, 'la fecha final');
      try {
        const posted = await ledger.postJournal(
          tenantId,
          {
            docType: CLOSE_DOC_TYPE,
            date,
            currency: preview.currency,
            idempotencyKey: `vat-close-${id}`,
            description: `Cierre de IVA ${preview.from} a ${preview.to}`,
            source: { kind: 'vat_close', id: String(id) },
            lines,
          },
          {
            inTx: async (session, { journal }) => {
              await closesOf(tenantId).insertOne(
                { _id: id, status: 'posted', currency: preview.currency, from: parseDay(preview.from, 'la fecha inicial'), to: date, generated: preview.generated, deductible: preview.deductible, net: diff, result: diff > 0 ? 'payable' : diff < 0 ? 'credit' : 'zero', resultAccount: side?.code ?? null, journalId: journal._id, document: `CI${journal.number}`, createdBy: ctx.userId ?? null, createdAt: now() },
                session,
              );
              await ctx.auditTx?.(session, { action: 'tax.vat_close', target: id, details: { from: preview.from, to: preview.to, net: diff } });
            },
          },
        );
        if (posted.replayed) fail('ese rango ya está cerrado', 'DUPLICATE');
      } catch (err) {
        if (isDuplicate(err, 'tenant_taxclose_range')) fail('ese rango ya está cerrado', 'DUPLICATE');
        throw err;
      }
      return { close: await closesOf(tenantId).findOne({ _id: id }) };
    },

    async listCloses(tenantId, { limit = 25 } = {}) {
      const rows = await closesOf(tenantId).find({}, { sort: { to: -1, _id: -1 }, limit: Math.min(Math.max(Number(limit) || 25, 1), 100) }).toArray();
      return { items: rows };
    },

    async voidClose(tenantId, id, ctx = {}) {
      if (!/^[a-f0-9]{24}$/.test(String(id))) fail('cierre inválido');
      const close = await closesOf(tenantId).findOne({ _id: new ObjectId(id) });
      if (!close) fail('el cierre no existe', 'NOT_FOUND');
      if (close.status === 'void') return { close, replayed: true };
      await ledger.reverseJournal(
        tenantId,
        close.journalId,
        { idempotencyKey: `vat-close-void-${close._id}`, date: close.to, description: `Anulación del cierre de IVA ${dayOf(close.from)} a ${dayOf(close.to)}` },
        {
          inTx: async (session, { journal }) => {
            const res = await closesOf(tenantId).updateOne({ _id: close._id, status: 'posted' }, { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } }, { session });
            if (res.matchedCount === 0) fail('el cierre cambió mientras se anulaba', 'INVALID_STATE');
            await ctx.auditTx?.(session, { action: 'tax.vat_close_void', target: close._id, details: { document: close.document } });
          },
        },
      );
      return { close: await closesOf(tenantId).findOne({ _id: close._id }), replayed: false };
    },
  };
  return api;
}
