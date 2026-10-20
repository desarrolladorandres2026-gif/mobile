import { ObjectId } from 'mongodb';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { isDuplicate } from '../data/tx.js';

export const MAX_ALLOCATIONS = 200;
export const MAX_RECEIPT_PAGE = 50;
export const MAX_AGING_ROWS = 500;
export const MAX_OPEN_INVOICES = 200;
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

export class ReceivablesError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'ReceivablesError';
    this.code = code;
  }
}

function parseDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReceivablesError(`${label} debe tener el formato AAAA-MM-DD`);
  // Mediodía UTC, igual que las facturas: una fecha de calendario no cambia de día con la zona horaria.
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ReceivablesError(`${label} no es una fecha válida`);
  return date;
}

const dayOf = (date) => date.toISOString().slice(0, 10);
const startOfDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/*
 * Recibo de caja (referencia, sin tipos):
 * { _id, tenantId, idempotencyKey, number, fullNumber, status 'posted'|'void',
 *   partyId, party { name, taxIdType, taxId }, date, currency, depositAccount,
 *   allocations [{ invoiceId, invoiceFullNumber, amount }], total, notes?,
 *   journalId, voidJournalId?, voidedAt?, voidedBy?, createdBy, createdAt }
 *
 * Un recibo aplica el cobro a una o varias facturas del mismo cliente y moneda. El asiento (débito a la cuenta
 * de caja o banco, crédito a la cuenta por cobrar de cada factura), la baja del saldo de cada factura y el
 * recibo mismo se confirman en una sola transacción. La baja del saldo es una operación condicionada
 * (`balance >= importe`): dos cobros simultáneos a la misma factura no pueden dejarla en negativo.
 *
 * Límites: el recibo debe aplicarse por completo a facturas (no hay anticipos de clientes todavía) y la cartera
 * por edades se calcula con el saldo de hoy, no a una fecha pasada.
 */
export function createReceivablesService({ client, db, ledger, accounts, parties, now = () => new Date() }) {
  const receiptsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.receipts), tenantId);
  const invoicesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.invoices), tenantId);

  const openFilter = { status: 'issued', collectible: true, balance: { $gt: 0 } };

  function cleanAllocations(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw new ReceivablesError('indica a qué facturas se aplica el cobro');
    if (raw.length > MAX_ALLOCATIONS) throw new ReceivablesError(`un recibo aplica como máximo a ${MAX_ALLOCATIONS} facturas`);
    const seen = new Set();
    return raw.map((a, i) => {
      const id = String(a?.invoiceId ?? '');
      if (!/^[a-f0-9]{24}$/.test(id)) throw new ReceivablesError(`aplicación ${i + 1}: factura inválida`);
      if (seen.has(id)) throw new ReceivablesError(`aplicación ${i + 1}: la factura se repite`);
      seen.add(id);
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) throw new ReceivablesError(`aplicación ${i + 1}: el importe debe ser un entero positivo`);
      return { invoiceId: new ObjectId(id), amount: a.amount };
    });
  }

  const api = {
    async createReceipt(tenantId, input, ctx = {}) {
      const { idempotencyKey, userId } = ctx;
      if (!idempotencyKey?.trim()) throw new ReceivablesError('falta la clave de idempotencia');
      const previous = await receiptsOf(tenantId).findOne({ idempotencyKey });
      if (previous) return { receipt: previous, replayed: true };

      const date = parseDay(input.date, 'la fecha del recibo');
      const allocations = cleanAllocations(input.allocations);
      const notes = String(input.notes ?? '').trim().slice(0, 500) || undefined;

      const party = await parties.get(tenantId, input.partyId);
      if (!party) throw new ReceivablesError('el cliente no existe', 'NOT_FOUND');
      if (!party.roles.includes('customer')) throw new ReceivablesError('el tercero elegido no está registrado como cliente');

      const deposit = String(input.depositAccount ?? '');
      const problems = await accounts.postingProblems(tenantId, [deposit]);
      if (problems.length) throw new ReceivablesError(problems.join('; '));
      const depositAccount = await accounts.get(tenantId, deposit);
      if (depositAccount.type !== 'asset') throw new ReceivablesError('el dinero entra a una cuenta de activo: caja o bancos');

      const invoices = await invoicesOf(tenantId)
        .find({ _id: { $in: allocations.map((a) => a.invoiceId) } })
        .toArray();
      const byId = new Map(invoices.map((inv) => [String(inv._id), inv]));
      const currencies = new Set();
      for (const [i, a] of allocations.entries()) {
        const inv = byId.get(String(a.invoiceId));
        if (!inv) throw new ReceivablesError(`aplicación ${i + 1}: la factura no existe`, 'NOT_FOUND');
        if (String(inv.customer.partyId) !== String(party._id)) throw new ReceivablesError(`la factura ${inv.fullNumber} es de otro cliente`);
        if (inv.status !== 'issued' || inv.accounting?.status !== 'posted') throw new ReceivablesError(`la factura ${inv.fullNumber} no está emitida y contabilizada`, 'INVALID_STATE');
        if (!inv.collectible) throw new ReceivablesError(`la factura ${inv.fullNumber} se pagó de contado: no tiene cartera`, 'INVALID_STATE');
        if (dayOf(date) < dayOf(inv.issueDate)) throw new ReceivablesError(`el recibo no puede ser anterior a la factura ${inv.fullNumber}`);
        if (a.amount > inv.balance) throw new ReceivablesError(`la factura ${inv.fullNumber} solo tiene saldo por ${inv.balance}`, 'OVER_PAYMENT');
        currencies.add(inv.currency);
      }
      if (currencies.size !== 1) throw new ReceivablesError('un recibo es de una sola moneda');
      const [currency] = currencies;
      assertCurrency(currency);
      if (input.currency && input.currency !== currency) throw new ReceivablesError(`las facturas están en ${currency}`);

      let total = 0;
      const credits = new Map();
      for (const a of allocations) {
        total = assertMinorUnits(total + a.amount, 'total del recibo');
        const account = byId.get(String(a.invoiceId)).accountsUsed.debit;
        credits.set(account, (credits.get(account) ?? 0) + a.amount);
      }
      if (credits.has(deposit)) throw new ReceivablesError('la cuenta de caja o bancos no puede ser la misma cuenta por cobrar');

      const journalInput = {
        docType: 'RC',
        date,
        currency,
        idempotencyKey: `receipt-${idempotencyKey}`,
        description: `Recibo de caja de ${party.name}`,
        source: { kind: 'receipt', id: idempotencyKey },
        lines: [{ accountId: deposit, debit: total }, ...[...credits].map(([accountId, credit]) => ({ accountId, credit }))],
      };

      const result = await ledger
        .postJournal(tenantId, journalInput, {
          inTx: async (session, { journal }) => {
            for (const a of allocations) {
              const inv = byId.get(String(a.invoiceId));
              const reserved = await invoicesOf(tenantId).updateOne(
                { _id: a.invoiceId, ...openFilter, 'accounting.status': 'posted', 'customer.partyId': party._id, balance: { $gte: a.amount } },
                { $inc: { paidTotal: a.amount, balance: -a.amount } },
                { session },
              );
              if (reserved.matchedCount === 0) throw new ReceivablesError(`la factura ${inv.fullNumber} ya no tiene saldo suficiente`, 'OVER_PAYMENT');
            }
            const doc = {
              idempotencyKey,
              number: journal.number,
              fullNumber: `RC${journal.number}`,
              status: 'posted',
              partyId: party._id,
              party: { name: party.name, taxIdType: party.taxIdType, taxId: party.taxId },
              date,
              currency,
              depositAccount: deposit,
              allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceFullNumber: byId.get(String(a.invoiceId)).fullNumber, amount: a.amount })),
              total,
              ...(notes ? { notes } : {}),
              journalId: journal._id,
              createdBy: userId ?? null,
              createdAt: now(),
            };
            const { insertedId } = await receiptsOf(tenantId).insertOne({ ...doc }, session);
            await ctx.auditTx?.(session, { action: 'receipt.create', target: insertedId, details: { number: doc.fullNumber, total, invoices: allocations.length } });
          },
        })
        .catch((err) => {
          if (isDuplicate(err, 'tenant_receipt_idempotency')) return { replayed: true };
          throw err;
        });

      const receipt = await receiptsOf(tenantId).findOne({ idempotencyKey });
      if (!receipt) throw new ReceivablesError('el asiento del recibo ya existía sin recibo: contacta a soporte', 'INVALID_STATE');
      return { receipt, replayed: Boolean(result.replayed) };
    },

    /** Anula un recibo: reversa su asiento y devuelve el saldo a cada factura, todo en una transacción. */
    async voidReceipt(tenantId, receiptId, input = {}, ctx = {}) {
      const receipt = await receiptsOf(tenantId).findOne({ _id: new ObjectId(receiptId) });
      if (!receipt) throw new ReceivablesError('el recibo no existe', 'NOT_FOUND');
      if (receipt.status === 'void') return { receipt, replayed: true };
      const date = input.date ? parseDay(input.date, 'la fecha de la anulación') : now();
      if (dayOf(date) < dayOf(receipt.date)) throw new ReceivablesError('la anulación no puede ser anterior al recibo');

      await ledger.reverseJournal(
        tenantId,
        receipt.journalId,
        { idempotencyKey: `receipt-void-${receipt._id}`, date, description: `Anulación del recibo ${receipt.fullNumber}` },
        {
          inTx: async (session, { journal }) => {
            const changed = await receiptsOf(tenantId).updateOne(
              { _id: receipt._id, status: 'posted' },
              { $set: { status: 'void', voidJournalId: journal._id, voidedAt: now(), voidedBy: ctx.userId ?? null } },
              { session },
            );
            if (changed.matchedCount === 0) throw new ReceivablesError('el recibo ya fue anulado', 'INVALID_STATE');
            for (const a of receipt.allocations) {
              await invoicesOf(tenantId).updateOne({ _id: a.invoiceId }, { $inc: { paidTotal: -a.amount, balance: a.amount } }, { session });
            }
            await ctx.auditTx?.(session, { action: 'receipt.void', target: receipt._id, details: { number: receipt.fullNumber, total: receipt.total } });
          },
        },
      );
      return { receipt: await receiptsOf(tenantId).findOne({ _id: receipt._id }), replayed: false };
    },

    getReceipt(tenantId, id) {
      return receiptsOf(tenantId).findOne({ _id: new ObjectId(id) });
    },

    async listReceipts(tenantId, { partyId, status, limit = 25, cursor } = {}) {
      const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_RECEIPT_PAGE);
      const filter = {
        ...(partyId ? { partyId: new ObjectId(partyId) } : {}),
        ...(status ? { status: String(status) } : {}),
        ...(cursor ? { _id: { $lt: new ObjectId(cursor) } } : {}),
      };
      const rows = await receiptsOf(tenantId).find(filter, { sort: { _id: -1 }, limit: size + 1 }).toArray();
      const hasMore = rows.length > size;
      const items = hasMore ? rows.slice(0, size) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]._id.toHexString() : null };
    },

    /** Facturas de un cliente con saldo por cobrar, las que vencen antes primero. */
    async listOpenInvoices(tenantId, { partyId, currency }) {
      assertCurrency(currency);
      const rows = await invoicesOf(tenantId)
        .find(
          { ...openFilter, currency, 'customer.partyId': new ObjectId(partyId) },
          {
            sort: { dueDate: 1, _id: 1 },
            limit: MAX_OPEN_INVOICES,
            projection: { fullNumber: 1, issueDate: 1, dueDate: 1, totals: 1, creditedTotal: 1, paidTotal: 1, balance: 1, currency: 1 },
          },
        )
        .toArray();
      return rows.map((r) => ({
        _id: r._id,
        fullNumber: r.fullNumber,
        issueDate: r.issueDate,
        ...(r.dueDate ? { dueDate: r.dueDate } : {}),
        currency: r.currency,
        total: r.totals.total,
        credited: r.creditedTotal,
        paid: r.paidTotal,
        balance: r.balance,
      }));
    },

    /**
     * Cartera por edades con el saldo de hoy: por cliente, lo que no ha vencido y lo vencido a 1-30, 31-60, 61-90
     * y más de 90 días. El vencimiento es `dueDate`, o la emisión si la factura no lo tiene.
     */
    async aging(tenantId, { currency }) {
      assertCurrency(currency);
      const asOf = startOfDay(now());
      const groups = await invoicesOf(tenantId)
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
              _id: { partyId: '$customer.partyId', bucket: '$bucket' },
              amount: { $sum: '$balance' },
              count: { $sum: 1 },
              name: { $first: '$customer.name' },
              taxId: { $first: '$customer.taxId' },
            },
          },
        ])
        .toArray();

      const byParty = new Map();
      const totals = Object.fromEntries([...AGING_BUCKETS, 'total', 'invoices'].map((k) => [k, 0]));
      for (const g of groups) {
        const key = String(g._id.partyId);
        const row = byParty.get(key) ?? { partyId: g._id.partyId, name: g.name, taxId: g.taxId, ...Object.fromEntries([...AGING_BUCKETS, 'total', 'invoices'].map((k) => [k, 0])) };
        row[g._id.bucket] += Number(g.amount);
        row.total += Number(g.amount);
        row.invoices += g.count;
        totals[g._id.bucket] += Number(g.amount);
        totals.total += Number(g.amount);
        totals.invoices += g.count;
        byParty.set(key, row);
      }
      const all = [...byParty.values()].sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
      return {
        asOf: asOf.toISOString().slice(0, 10),
        currency,
        rows: all.slice(0, MAX_AGING_ROWS),
        truncated: all.length > MAX_AGING_ROWS,
        customers: all.length,
        totals,
      };
    },
  };
  return api;
}
