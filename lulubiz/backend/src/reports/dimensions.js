import { ObjectId } from 'mongodb';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { closingEffects } from '../closing/yearEnd.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { LedgerValidationError, assertPeriod } from '../ledger/ledger.js';

export const MAX_MOVEMENTS = 2000;
const RESULT_TYPES = ['income', 'cost', 'expense'];
const add = (a, b) => assertMinorUnits(a + b, 'suma');
// 0 - net y no -net: negar un cero entrega -0.
const natural = (nature, net) => (nature === 'debit' ? net : 0 - net);

function assertRange(from, to) {
  assertPeriod(from);
  assertPeriod(to);
  if (from > to) throw new LedgerValidationError('el período inicial no puede ser posterior al final');
}

/*
 * Reportes por dimensión: el resultado por centro de costo y el auxiliar por tercero. Leen los saldos por dimensión
 * (`dimBalances`), que el libro actualiza en la transacción de cada asiento, y los asientos para el detalle.
 *
 * Resultado por centro de costo: ingresos, costos y gastos del rango de cada centro, y una fila «sin centro de costo» con
 * lo que no se asignó, de modo que la suma de todas las filas es igual al estado de resultados del mismo rango. El asiento
 * de cierre de ejercicio no cuenta (no lleva centros): se resta, igual que en el estado de resultados.
 *
 * Auxiliar por tercero: por cuenta, saldo inicial, movimientos y saldo final de un tercero, y el detalle de sus
 * movimientos. Solo ve lo que se registró con el tercero en la línea: los documentos lo ponen en la cuenta por cobrar y
 * por pagar; un asiento manual sin tercero no aparece aquí.
 */
export function createDimensionReports(db, accounts) {
  const dimOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.dimBalances), tenantId);
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);

  return {
    async costCenterResult(tenantId, { from, to, currency }) {
      assertRange(from, to);
      assertCurrency(currency);
      const chart = await accounts.list(tenantId);
      const byCode = new Map(chart.map((a) => [a.code, a]));
      const codes = chart.filter((a) => RESULT_TYPES.includes(a.type) && a.postable).map((a) => a.code);
      const [dimRows, totalRows, centers] = await Promise.all([
        dimOf(tenantId)
          .aggregate([
            { $match: { dimension: 'costCenter', currency, accountId: { $in: codes }, period: { $gte: from, $lte: to } } },
            { $group: { _id: { key: '$key', accountId: '$accountId' }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
          ])
          .toArray(),
        balancesOf(tenantId)
          .aggregate([
            { $match: { currency, accountId: { $in: codes }, period: { $gte: from, $lte: to } } },
            { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
          ])
          .toArray(),
        db.collection(COLLECTIONS.costCenters).find({ tenantId }).toArray(),
      ]);

      // Actividad real por cuenta: sin el asiento de cierre de ejercicio.
      const total = new Map(totalRows.map((r) => [r._id, Number(r.debit) - Number(r.credit)]));
      for (const e of await closingEffects(db, tenantId, currency, to)) {
        if (e.period >= from && total.has(e.accountId)) total.set(e.accountId, total.get(e.accountId) - (e.debit - e.credit));
      }

      const named = new Map(centers.map((c) => [c.code, c.name]));
      const perCenter = new Map();
      const assigned = new Map();
      for (const r of dimRows) {
        const net = Number(r.debit) - Number(r.credit);
        const list = perCenter.get(r._id.key) ?? [];
        list.push({ accountId: r._id.accountId, net });
        perCenter.set(r._id.key, list);
        assigned.set(r._id.accountId, (assigned.get(r._id.accountId) ?? 0) + net);
      }
      const unassigned = [];
      for (const [accountId, net] of total) {
        const rest = net - (assigned.get(accountId) ?? 0);
        if (rest !== 0) unassigned.push({ accountId, net: rest });
      }

      const section = (list) => {
        const rows = list
          .map(({ accountId, net }) => {
            const account = byCode.get(accountId);
            return { code: accountId, name: account?.name ?? null, type: account?.type ?? null, amount: natural(account?.nature ?? 'debit', net) };
          })
          .filter((r) => r.amount !== 0)
          .sort((a, b) => (a.code < b.code ? -1 : 1));
        const sum = (type) => rows.filter((r) => r.type === type).reduce((acc, r) => add(acc, r.amount), 0);
        const totals = { income: sum('income'), cost: sum('cost'), expense: sum('expense') };
        return { rows, totals: { ...totals, result: totals.income - totals.cost - totals.expense } };
      };

      const rows = [...perCenter].map(([code, list]) => ({ code, name: named.get(code) ?? null, ...section(list) })).sort((a, b) => (a.code < b.code ? -1 : 1));
      const none = section(unassigned);
      const all = [...rows, { code: null, name: 'Sin centro de costo', ...none }];
      const sumOf = (field) => all.reduce((acc, c) => add(acc, c.totals[field]), 0);
      return {
        from,
        to,
        currency,
        centers: rows,
        unassigned: none,
        totals: { income: sumOf('income'), cost: sumOf('cost'), expense: sumOf('expense'), result: sumOf('result') },
      };
    },

    async partyLedger(tenantId, { partyId, from, to, currency }) {
      assertRange(from, to);
      assertCurrency(currency);
      if (!/^[a-f0-9]{24}$/.test(String(partyId))) throw new LedgerValidationError('tercero inválido');
      const id = new ObjectId(partyId);
      const party = await new TenantCollection(db.collection(COLLECTIONS.parties), tenantId).findOne({ _id: id });
      if (!party) throw Object.assign(new LedgerValidationError('el tercero no existe'), { code: 'NOT_FOUND' });
      const chart = await accounts.list(tenantId);
      const byCode = new Map(chart.map((a) => [a.code, a]));

      const rows = await dimOf(tenantId)
        .aggregate([
          { $match: { dimension: 'party', key: String(id), currency, period: { $lte: to } } },
          {
            $group: {
              _id: '$accountId',
              od: { $sum: { $cond: [{ $lt: ['$period', from] }, '$debit', 0] } },
              oc: { $sum: { $cond: [{ $lt: ['$period', from] }, '$credit', 0] } },
              d: { $sum: { $cond: [{ $gte: ['$period', from] }, '$debit', 0] } },
              c: { $sum: { $cond: [{ $gte: ['$period', from] }, '$credit', 0] } },
            },
          },
        ])
        .toArray();
      const summary = rows
        .map((r) => {
          const nature = byCode.get(r._id)?.nature ?? 'debit';
          const [od, oc, d, c] = [Number(r.od), Number(r.oc), Number(r.d), Number(r.c)];
          return { code: r._id, name: byCode.get(r._id)?.name ?? null, nature, opening: natural(nature, od - oc), debit: d, credit: c, closing: natural(nature, od + d - (oc + c)) };
        })
        .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0)
        .sort((a, b) => (a.code < b.code ? -1 : 1));

      const start = new Date(`${from}-01T00:00:00.000Z`);
      const [ty, tm] = to.split('-').map(Number);
      const end = new Date(Date.UTC(ty, tm, 1));
      const journals = await journalsOf(tenantId)
        .find({ currency, 'lines.partyId': id, date: { $gte: start, $lt: end } }, { sort: { date: 1, _id: 1 }, limit: MAX_MOVEMENTS + 1, projection: { docType: 1, number: 1, date: 1, description: 1, lines: 1, reversesJournalId: 1 } })
        .toArray();
      if (journals.length > MAX_MOVEMENTS) throw Object.assign(new LedgerValidationError(`el rango tiene más de ${MAX_MOVEMENTS} asientos del tercero: elige uno más corto`), { code: 'RANGE_TOO_LARGE' });
      const movements = journals.flatMap((j) =>
        j.lines
          .filter((l) => l.partyId && String(l.partyId) === String(id))
          .map((l) => ({ date: j.date, document: `${j.docType}${j.number}`, journalId: j._id, accountId: l.accountId, debit: l.debit, credit: l.credit, description: j.description ?? '', reversal: Boolean(j.reversesJournalId) })),
      );
      return {
        party: { _id: party._id, name: party.name, taxIdType: party.taxIdType, taxId: party.taxId, ...(party.checkDigit !== undefined ? { checkDigit: party.checkDigit } : {}) },
        from,
        to,
        currency,
        accounts: summary,
        movements,
      };
    },
  };
}
