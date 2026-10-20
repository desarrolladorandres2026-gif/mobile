import { ObjectId } from 'mongodb';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { dayOf, parseDay as parseCalendarDay, startOfDay } from '../core/dates.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';

export const MAX_ALLOCATIONS = 200;
export const MAX_PAYMENT_PAGE = 50;
export const MAX_AGING_ROWS = 500;
export const MAX_OPEN_PURCHASES = 200;
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

export class PayablesError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'PayablesError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PayablesError(message, code);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);

/*
 * Comprobante de egreso (referencia, sin tipos):
 * { _id, tenantId, idempotencyKey, number, fullNumber 'CE<n>', status 'posted'|'void',
 *   partyId, party { name, taxIdType, taxId }, date, currency, paymentAccount,
 *   allocations [{ purchaseId, purchaseFullNumber, supplierDocNumber, amount }], total, notes?,
 *   journalId, voidJournalId?, voidedAt?, voidedBy?, createdBy, createdAt }
 *
 * Es el espejo del recibo de caja: el pago se aplica a facturas de compra de un mismo proveedor y moneda; el asiento
 * (débito a la cuenta por pagar de cada factura, crédito a caja o bancos), la baja del saldo y el comprobante se
 * confirman en una sola transacción, y la baja es condicionada (`balance >= importe`).
 *
 * Límites: el pago debe aplicarse por completo a facturas (no hay anticipos a proveedores) y la cartera por pagar
 * por edades usa el saldo de hoy.
 */
export function createPayablesService({ db, ledger, accounts, parties, now = () => new Date() }) {
  const paymentsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.payments), tenantId);
  const purchasesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.purchases), tenantId);

  const openFilter = { status: 'posted', balance: { $gt: 0 } };

  function cleanAllocations(raw) {
    if (!Array.isArray(raw) || raw.length === 0) fail('indica qué facturas se pagan');
    if (raw.length > MAX_ALLOCATIONS) fail(`un pago aplica como máximo a ${MAX_ALLOCATIONS} facturas`);
    const seen = new Set();
    return raw.map((a, i) => {
      const id = String(a?.purchaseId ?? '');
      if (!/^[a-f0-9]{24}$/.test(id)) fail(`aplicación ${i + 1}: factura inválida`);
      if (seen.has(id)) fail(`aplicación ${i + 1}: la factura se repite`);
      seen.add(id);
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) fail(`aplicación ${i + 1}: el importe debe ser un entero positivo`);
      return { purchaseId: new ObjectId(id), amount: a.amount };
    });
  }

  return {
    async createPayment(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) fail('falta la clave de idempotencia');
      const previous = await paymentsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { payment: previous, replayed: true };

      const date = parseDay(input.date, 'la fecha del pago');
      const allocations = cleanAllocations(input.allocations);
      const notes = String(input.notes ?? '').trim().slice(0, 500) || undefined;

      const party = await parties.get(tenantId, input.partyId);
      if (!party) fail('el proveedor no existe', 'NOT_FOUND');
      if (!party.roles.includes('supplier')) fail('el tercero elegido no está registrado como proveedor');

      const paymentAccount = String(input.paymentAccount ?? '');
      const problems = await accounts.postingProblems(tenantId, [paymentAccount]);
      if (problems.length) fail(problems.join('; '));
      if ((await accounts.get(tenantId, paymentAccount)).type !== 'asset') fail('el dinero sale de una cuenta de activo: caja o bancos');

      const purchases = await purchasesOf(tenantId)
        .find({ _id: { $in: allocations.map((a) => a.purchaseId) } })
        .toArray();
      const byId = new Map(purchases.map((p) => [String(p._id), p]));
      const currencies = new Set();
      for (const [i, a] of allocations.entries()) {
        const purchase = byId.get(String(a.purchaseId));
        if (!purchase) fail(`aplicación ${i + 1}: la factura no existe`, 'NOT_FOUND');
        if (String(purchase.supplier.partyId) !== String(party._id)) fail(`la factura ${purchase.fullNumber} es de otro proveedor`);
        if (purchase.status !== 'posted') fail(`la factura ${purchase.fullNumber} no está vigente`, 'INVALID_STATE');
        if (dayOf(date) < dayOf(purchase.issueDate)) fail(`el pago no puede ser anterior a la factura ${purchase.fullNumber}`);
        if (a.amount > purchase.balance) fail(`la factura ${purchase.fullNumber} solo tiene saldo por ${purchase.balance}`, 'OVER_PAYMENT');
        currencies.add(purchase.currency);
      }
      if (currencies.size !== 1) fail('un pago es de una sola moneda');
      const [currency] = currencies;
      assertCurrency(currency);
      if (input.currency && input.currency !== currency) fail(`las facturas están en ${currency}`);

      let total = 0;
      const debits = new Map();
      for (const a of allocations) {
        total = assertMinorUnits(total + a.amount, 'total del pago');
        const account = byId.get(String(a.purchaseId)).accountsUsed.payable;
        debits.set(account, (debits.get(account) ?? 0) + a.amount);
      }
      if (debits.has(paymentAccount)) fail('la cuenta de caja o bancos no puede ser la misma cuenta por pagar');

      let replayed = false;
      try {
        const posted = await ledger.postJournal(
          tenantId,
          {
            docType: 'CE',
            date,
            currency,
            idempotencyKey: `payment-${idempotencyKey}`,
            description: `Pago a ${party.name}`,
            source: { kind: 'payment', id: idempotencyKey },
            lines: [...[...debits].map(([accountId, debit]) => ({ accountId, debit })), { accountId: paymentAccount, credit: total }],
          },
          {
            inTx: async (session, { journal }) => {
              for (const a of allocations) {
                const purchase = byId.get(String(a.purchaseId));
                const reserved = await purchasesOf(tenantId).updateOne(
                  { _id: a.purchaseId, ...openFilter, 'supplier.partyId': party._id, balance: { $gte: a.amount } },
                  { $inc: { paidTotal: a.amount, balance: -a.amount } },
                  { session },
                );
                if (reserved.matchedCount === 0) fail(`la factura ${purchase.fullNumber} ya no tiene saldo suficiente`, 'OVER_PAYMENT');
              }
              const { insertedId } = await paymentsOf(tenantId).insertOne(
                {
                  idempotencyKey,
                  number: journal.number,
                  fullNumber: `CE${journal.number}`,
                  status: 'posted',
                  partyId: party._id,
                  party: { name: party.name, taxIdType: party.taxIdType, taxId: party.taxId },
                  date,
                  currency,
                  paymentAccount,
                  allocations: allocations.map((a) => {
                    const purchase = byId.get(String(a.purchaseId));
                    return { purchaseId: a.purchaseId, purchaseFullNumber: purchase.fullNumber, supplierDocNumber: purchase.supplierDocNumber, amount: a.amount };
                  }),
                  total,
                  ...(notes ? { notes } : {}),
                  journalId: journal._id,
                  createdBy: userId ?? null,
                  createdAt: now(),
                },
                session,
              );
              await ctx.auditTx?.(session, { action: 'payment.create', target: insertedId, details: { number: `CE${journal.number}`, total, purchases: allocations.length } });
            },
          },
        );
        replayed = posted.replayed;
      } catch (err) {
        if (!isDuplicate(err, 'tenant_payment_idempotency')) throw err;
        replayed = true;
      }

      const payment = await paymentsOf(tenantId).findOne({ idempotencyKey });
      if (!payment) fail('el asiento del pago ya existía sin comprobante: contacta a soporte', 'INVALID_STATE');
      return { payment, replayed };
    },

    async voidPayment(tenantId, paymentId, input = {}, ctx = {}) {
      const payment = await paymentsOf(tenantId).findOne({ _id: new ObjectId(paymentId) });
      if (!payment) fail('el comprobante no existe', 'NOT_FOUND');
      if (payment.status === 'void') return { payment, replayed: true };
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : now();
      if (dayOf(date) < dayOf(payment.date)) fail('la anulación no puede ser anterior al pago');

      await ledger.reverseJournal(
        tenantId,
        payment.journalId,
        { idempotencyKey: `payment-void-${payment._id}`, date, description: `Anulación del comprobante ${payment.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await paymentsOf(tenantId).updateOne(
              { _id: payment._id, status: 'posted' },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (changed.matchedCount === 0) fail('el comprobante ya fue anulado', 'INVALID_STATE');
            for (const a of payment.allocations) {
              await purchasesOf(tenantId).updateOne({ _id: a.purchaseId }, { $inc: { paidTotal: -a.amount, balance: a.amount } }, { session });
            }
            await ctx.auditTx?.(session, { action: 'payment.void', target: payment._id, details: { number: payment.fullNumber, total: payment.total } });
          },
        },
      );
      return { payment: await paymentsOf(tenantId).findOne({ _id: payment._id }), replayed: false };
    },

    getPayment(tenantId, id) {
      return paymentsOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    async listPayments(tenantId, { partyId, status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAYMENT_PAGE);
      const filter = {
        ...(partyId ? { partyId: new ObjectId(partyId) } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}),
      };
      const rows = await paymentsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /** Facturas de compra de un proveedor con saldo por pagar, las que vencen antes primero. */
    async listOpenPurchases(tenantId, { partyId, currency }) {
      assertCurrency(currency);
      const rows = await purchasesOf(tenantId)
        .find(
          { ...openFilter, currency, 'supplier.partyId': new ObjectId(partyId) },
          {
            sort: { dueDate: 1, _id: 1 },
            limit: MAX_OPEN_PURCHASES,
            projection: { fullNumber: 1, supplierDocNumber: 1, issueDate: 1, dueDate: 1, payable: 1, creditedTotal: 1, paidTotal: 1, balance: 1, currency: 1 },
          },
        )
        .toArray();
      return rows.map((r) => ({
        _id: r._id,
        fullNumber: r.fullNumber,
        supplierDocNumber: r.supplierDocNumber,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        currency: r.currency,
        payable: r.payable,
        paid: r.paidTotal,
        balance: r.balance,
      }));
    },

    /** Cuentas por pagar por edades con el saldo de hoy, por proveedor, desde el vencimiento de cada factura. */
    async aging(tenantId, { currency }) {
      assertCurrency(currency);
      const asOf = startOfDay(now());
      const groups = await purchasesOf(tenantId)
        .aggregate([
          { $match: { ...openFilter, currency } },
          { $addFields: { late: { $dateDiff: { startDate: { $ifNull: ['$dueDate', '$issueDate'] }, endDate: asOf, unit: 'day' } } } },
          {
            $addFields: {
              bucket: {
                $switch: {
                  branches: [
                    { case: { $lte: ['$late', 0] }, then: 'current' },
                    { case: { $lte: ['$late', 30] }, then: 'd1_30' },
                    { case: { $lte: ['$late', 60] }, then: 'd31_60' },
                    { case: { $lte: ['$late', 90] }, then: 'd61_90' },
                  ],
                  default: 'd90plus',
                },
              },
            },
          },
          {
            $group: {
              _id: { partyId: '$supplier.partyId', bucket: '$bucket' },
              amount: { $sum: '$balance' },
              count: { $sum: 1 },
              name: { $first: '$supplier.name' },
              taxId: { $first: '$supplier.taxId' },
            },
          },
        ])
        .toArray();

      const empty = () => Object.fromEntries([...AGING_BUCKETS, 'total', 'invoices'].map((k) => [k, 0]));
      const byParty = new Map();
      const totals = empty();
      for (const g of groups) {
        const key = String(g._id.partyId);
        const row = byParty.get(key) ?? { partyId: g._id.partyId, name: g.name, taxId: g.taxId, ...empty() };
        row[g._id.bucket] += Number(g.amount);
        row.total += Number(g.amount);
        row.invoices += g.count;
        totals[g._id.bucket] += Number(g.amount);
        totals.total += Number(g.amount);
        totals.invoices += g.count;
        byParty.set(key, row);
      }
      const all = [...byParty.values()].sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
      return { asOf: dayOf(asOf), currency, rows: all.slice(0, MAX_AGING_ROWS), truncated: all.length > MAX_AGING_ROWS, suppliers: all.length, totals };
    },
  };
}
