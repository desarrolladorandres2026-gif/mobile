import { ObjectId } from 'mongodb';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { LedgerValidationError, assertPeriod } from '../ledger/ledger.js';

export const MAX_LEDGER_PAGE = 200;
const MAX_DEPTH = 20;
const FIRST_PERIOD = '0000-01';

/*
 * Reportes contables. Solo leen: los saldos mensuales por cuenta (`balances`) que el libro
 * actualiza en la misma transacción de cada asiento, y los asientos para el libro auxiliar.
 * Nunca recorren el libro entero para sumar.
 *
 * Los importes son enteros en unidades menores. Un saldo "natural" es positivo cuando está
 * del lado de la naturaleza de la cuenta (débito para activos y gastos, crédito para pasivos,
 * patrimonio e ingresos) y negativo cuando es contrario.
 *
 * Límites conocidos: el ejercicio no se cierra (no hay asiento de cierre), así que el balance
 * muestra un único "resultado acumulado" desde el primer período. Los reportes son por
 * períodos mensuales (AAAA-MM) y por una sola moneda a la vez.
 */

// 0 - net y no -net: negar un cero entrega -0, que se compara distinto de 0 aunque el JSON lo muestre igual.
const natural = (nature, net) => (nature === 'debit' ? net : 0 - net);

function sum(a, b) {
  return assertMinorUnits(a + b, 'suma');
}

function assertRange(from, to) {
  assertPeriod(from);
  assertPeriod(to);
  if (from > to) throw new LedgerValidationError('el período inicial no puede ser posterior al final');
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(text) {
  let raw;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new LedgerValidationError('cursor inválido');
  }
  const date = new Date(raw?.d);
  const valid =
    raw &&
    !Number.isNaN(date.getTime()) &&
    typeof raw.i === 'string' &&
    /^[a-f0-9]{24}$/.test(raw.i) &&
    Number.isSafeInteger(raw.dr) &&
    Number.isSafeInteger(raw.cr) &&
    raw.dr >= 0 &&
    raw.cr >= 0;
  if (!valid) throw new LedgerValidationError('cursor inválido');
  return { date, id: new ObjectId(raw.i), debit: raw.dr, credit: raw.cr };
}

export function createReportService(db, accounts) {
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);

  /** Movimiento por cuenta hasta `to`: lo anterior a `from` es saldo inicial y lo demás, movimiento del rango. */
  async function movements(tenantId, currency, from, to) {
    const rows = await balancesOf(tenantId)
      .aggregate([
        { $match: { currency, period: { $lte: to } } },
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
    return rows.map((r) => ({ code: r._id, od: Number(r.od), oc: Number(r.oc), d: Number(r.d), c: Number(r.c) }));
  }

  /** Acumula cada movimiento en su cuenta y en todos sus ancestros: así las cuentas de grupo suman a sus hijas. */
  async function buildRows(tenantId, currency, from, to) {
    const [chart, moves] = await Promise.all([accounts.list(tenantId), movements(tenantId, currency, from, to)]);
    const byCode = new Map(chart.map((a) => [a.code, a]));
    const totals = new Map();
    const add = (code, m) => {
      const cur = totals.get(code) ?? { od: 0, oc: 0, d: 0, c: 0 };
      cur.od = sum(cur.od, m.od);
      cur.oc = sum(cur.oc, m.oc);
      cur.d = sum(cur.d, m.d);
      cur.c = sum(cur.c, m.c);
      totals.set(code, cur);
    };
    for (const m of moves) {
      add(m.code, m);
      let parent = byCode.get(m.code)?.parentCode;
      for (let depth = 0; parent && depth < MAX_DEPTH; depth += 1) {
        add(parent, m);
        parent = byCode.get(parent)?.parentCode;
      }
    }
    const rows = [];
    for (const [code, t] of totals) {
      if (!t.od && !t.oc && !t.d && !t.c) continue;
      const account = byCode.get(code);
      const nature = account?.nature ?? 'debit';
      rows.push({
        code,
        name: account?.name ?? null,
        type: account?.type ?? null,
        nature,
        postable: account ? account.postable : true,
        opening: natural(nature, t.od - t.oc),
        debit: t.d,
        credit: t.c,
        closing: natural(nature, t.od + t.d - (t.oc + t.c)),
        _raw: t,
      });
    }
    rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return rows;
  }

  const publicRow = ({ _raw, ...row }) => row;
  const leaves = (rows) => rows.filter((r) => r.postable);

  const api = {
    /** Balance de prueba: saldo inicial, débitos, créditos y saldo final por cuenta, con las de grupo sumadas. */
    async trialBalance(tenantId, { from, to, currency }) {
      assertRange(from, to);
      assertCurrency(currency);
      const rows = await buildRows(tenantId, currency, from, to);
      let debit = 0;
      let credit = 0;
      let openingNet = 0;
      let closingNet = 0;
      for (const r of leaves(rows)) {
        debit = sum(debit, r.debit);
        credit = sum(credit, r.credit);
        openingNet = sum(openingNet, r._raw.od - r._raw.oc);
        closingNet = sum(closingNet, r._raw.od + r._raw.d - (r._raw.oc + r._raw.c));
      }
      return {
        from,
        to,
        currency,
        rows: rows.map(publicRow),
        totals: { debit, credit },
        balanced: debit === credit && openingNet === 0 && closingNet === 0,
      };
    },

    /** Estado de resultados del rango: ingresos, costos y gastos por cuenta, utilidad bruta y neta. */
    async incomeStatement(tenantId, { from, to, currency }) {
      assertRange(from, to);
      assertCurrency(currency);
      const rows = await buildRows(tenantId, currency, from, to);
      const section = (type) =>
        rows
          .filter((r) => r.type === type)
          .map((r) => ({ code: r.code, name: r.name, postable: r.postable, amount: natural(r.nature, r._raw.d - r._raw.c) }));
      const total = (list) => list.filter((r) => r.postable).reduce((acc, r) => sum(acc, r.amount), 0);
      const income = section('income');
      const cost = section('cost');
      const expense = section('expense');
      const totals = { income: total(income), cost: total(cost), expense: total(expense) };
      const grossProfit = totals.income - totals.cost;
      return {
        from,
        to,
        currency,
        income,
        cost,
        expense,
        totals: { ...totals, grossProfit, net: grossProfit - totals.expense },
      };
    },

    /**
     * Balance general al cierre del período `to`: activos, pasivos y patrimonio acumulados, más el resultado
     * acumulado de ingresos, costos y gastos. Las cuentas de orden no entran en la ecuación; su saldo neto
     * se informa aparte para que la comprobación sea exacta.
     */
    async balanceSheet(tenantId, { to, currency }) {
      assertPeriod(to);
      assertCurrency(currency);
      const rows = await buildRows(tenantId, currency, FIRST_PERIOD, to);
      const section = (type) =>
        rows
          .filter((r) => r.type === type)
          .map((r) => ({ code: r.code, name: r.name, postable: r.postable, amount: r.closing }));
      const total = (list) => list.filter((r) => r.postable).reduce((acc, r) => sum(acc, r.amount), 0);
      const assets = section('asset');
      const liabilities = section('liability');
      const equity = section('equity');
      const flow = (type) => total(section(type));
      const result = flow('income') - flow('cost') - flow('expense');
      const memoNet = leaves(rows)
        .filter((r) => r.type === 'memo')
        .reduce((acc, r) => sum(acc, r._raw.d - r._raw.c), 0);
      const totals = {
        assets: total(assets),
        liabilities: total(liabilities),
        equity: total(equity),
        result,
      };
      const difference = totals.assets - (totals.liabilities + totals.equity + totals.result);
      return {
        asOf: to,
        currency,
        assets,
        liabilities,
        equity,
        totals: { ...totals, liabilitiesAndEquity: totals.liabilities + totals.equity + totals.result },
        memoNet,
        difference,
        balanced: difference + memoNet === 0,
      };
    },

    /**
     * Libro auxiliar de una cuenta: saldo inicial, cada asiento en orden cronológico con su saldo corrido y
     * el saldo final en la última página. El cursor lleva los acumulados de la página anterior para no releer
     * el libro; solo afecta a lo que ve quien lo manipula.
     */
    async generalLedger(tenantId, { account: code, from, to, currency, limit = 100, cursor }) {
      assertRange(from, to);
      assertCurrency(currency);
      const account = await accounts.get(tenantId, code);
      if (!account) throw Object.assign(new LedgerValidationError(`la cuenta ${code} no existe`), { code: 'NOT_FOUND' });
      const size = Math.min(Math.max(Number(limit) || 100, 1), MAX_LEDGER_PAGE);

      let debit;
      let credit;
      let opening;
      const filter = { 'lines.accountId': code, currency, period: { $gte: from, $lte: to } };
      if (cursor) {
        const at = decodeCursor(cursor);
        ({ debit, credit } = at);
        filter.$or = [{ date: { $gt: at.date } }, { date: at.date, _id: { $gt: at.id } }];
      } else {
        const [prior] = await balancesOf(tenantId)
          .aggregate([
            { $match: { accountId: code, currency, period: { $lt: from } } },
            { $group: { _id: null, d: { $sum: '$debit' }, c: { $sum: '$credit' } } },
          ])
          .toArray();
        debit = Number(prior?.d ?? 0);
        credit = Number(prior?.c ?? 0);
        opening = { debit, credit, balance: natural(account.nature, debit - credit) };
      }

      const rows = await journalsOf(tenantId)
        .find(filter, { sort: { period: 1, date: 1, _id: 1 }, limit: size + 1 })
        .toArray();
      const hasMore = rows.length > size;
      const page = hasMore ? rows.slice(0, size) : rows;

      const items = page.map((journal) => {
        let d = 0;
        let c = 0;
        let note;
        for (const line of journal.lines) {
          if (line.accountId !== code) continue;
          d = sum(d, line.debit);
          c = sum(c, line.credit);
          note ??= line.description;
        }
        debit = sum(debit, d);
        credit = sum(credit, c);
        return {
          journalId: journal._id,
          docType: journal.docType,
          number: journal.number,
          date: journal.date,
          description: journal.description ?? note ?? null,
          ...(journal.reversesJournalId ? { reversesJournalId: journal.reversesJournalId } : {}),
          debit: d,
          credit: c,
          balance: natural(account.nature, debit - credit),
        };
      });

      const last = page[page.length - 1];
      const result = {
        account: { code: account.code, name: account.name, type: account.type, nature: account.nature },
        from,
        to,
        currency,
        ...(opening ? { opening } : {}),
        items,
        nextCursor: hasMore ? encodeCursor({ d: last.date.toISOString(), i: last._id.toHexString(), dr: debit, cr: credit }) : null,
      };
      if (!hasMore) result.closing = { debit, credit, balance: natural(account.nature, debit - credit) };
      return result;
    },
  };
  return api;
}
