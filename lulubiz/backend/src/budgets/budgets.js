import { closingEffects } from '../closing/yearEnd.js';
import { assertCurrency, assertMinorUnits } from '../core/money.js';
import { normalizeCenter } from '../core/dims.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { LedgerValidationError, assertPeriod } from '../ledger/ledger.js';

export const MAX_BUDGET_LINES = 300;
const RESULT_TYPES = ['income', 'cost', 'expense'];
const ACCOUNT = /^[0-9]{1,12}$/;

export class BudgetError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BudgetError(message, code);
};
// 0 - neto y no -neto: negar un cero entrega -0.
const natural = (type, debit, credit) => (type === 'income' ? credit - debit : debit - credit);

/*
 * Presupuesto por cuenta de resultados (ingresos, costos y gastos), por mes de un año y, si se quiere, por centro de costo.
 *
 *  - Una línea es una cuenta (y un centro, o ninguno) con doce importes mensuales. Guardar una línea la reemplaza; una línea
 *    en ceros equivale a no tener presupuesto. Sin centro de costo la línea cubre la cuenta completa.
 *  - La ejecución compara, en un rango de meses, lo presupuestado con lo real del libro: ingresos como créditos menos
 *    débitos, costos y gastos como débitos menos créditos (el asiento de cierre de ejercicio no cuenta, igual que en el estado
 *    de resultados). La diferencia es real menos presupuesto: en un ingreso positivo es bueno; en un gasto, un exceso.
 *  - Con un centro de costo, tanto lo presupuestado como lo real se limitan a ese centro. Sin él, el presupuesto suma todas las
 *    líneas de la cuenta (con o sin centro) contra el total de la cuenta.
 */
export function createBudgetService({ db, accounts, now = () => new Date() }) {
  const budgetsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.budgets), tenantId);
  const balancesOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.balances), tenantId);
  const dimOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.dimBalances), tenantId);
  const tenants = db.collection(COLLECTIONS.tenants);

  async function tenantCurrency(tenantId) {
    const tenant = await tenants.findOne({ _id: tenantId }, { projection: { currency: 1 } });
    if (!tenant) fail('la empresa no existe', 'NOT_FOUND');
    return tenant.currency;
  }

  const checkYear = (year) => {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('el año debe estar entre 2000 y 2100');
    return year;
  };

  return {
    /** Guarda (reemplaza) las líneas del presupuesto de un año. Cada línea: `{ accountId, costCenter?, months: [12 importes] }`. */
    async saveLines(tenantId, year, input, ctx = {}) {
      checkYear(year);
      const currency = assertCurrency(input.currency ?? (await tenantCurrency(tenantId)));
      const raw = input.lines;
      if (!Array.isArray(raw) || raw.length === 0) fail('no hay líneas que guardar');
      if (raw.length > MAX_BUDGET_LINES) fail(`se guardan como máximo ${MAX_BUDGET_LINES} líneas por vez`);
      const seen = new Set();
      const chart = new Map((await accounts.list(tenantId)).map((a) => [a.code, a]));
      const centers = new Set((await db.collection(COLLECTIONS.costCenters).find({ tenantId, active: true }, { projection: { code: 1 } }).toArray()).map((c) => c.code));
      const prepared = raw.map((l, i) => {
        const where = `línea ${i + 1}`;
        const accountId = String(l?.accountId ?? '').trim();
        if (!ACCOUNT.test(accountId)) fail(`${where}: indica la cuenta`);
        const account = chart.get(accountId);
        if (!account) fail(`${where}: la cuenta ${accountId} no existe`);
        if (!RESULT_TYPES.includes(account.type)) fail(`${where}: el presupuesto es de ingresos, costos y gastos`);
        const costCenter = normalizeCenter(l?.costCenter) ?? '';
        if (costCenter && !centers.has(costCenter)) fail(`${where}: el centro de costo ${costCenter} no existe o está inactivo`);
        const key = `${accountId}|${costCenter}`;
        if (seen.has(key)) fail(`${where}: la cuenta ${accountId}${costCenter ? ` con el centro ${costCenter}` : ''} se repite`);
        seen.add(key);
        if (!Array.isArray(l.months) || l.months.length !== 12) fail(`${where}: lleva doce importes, uno por mes`);
        const months = l.months.map((m, k) => {
          const value = assertMinorUnits(m, `${where}, mes ${k + 1}`);
          if (value < 0) fail(`${where}, mes ${k + 1}: el importe no puede ser negativo`);
          return value;
        });
        return { accountId, costCenter, months };
      });
      for (const line of prepared) {
        await budgetsOf(tenantId).updateOne(
          { year, currency, accountId: line.accountId, costCenter: line.costCenter },
          { $set: { months: line.months, updatedAt: now(), updatedBy: ctx.userId ?? null } },
          { upsert: true },
        );
      }
      await ctx.auditTx?.(undefined, { action: 'budget.save', details: { year, currency, lines: prepared.length } });
      return this.list(tenantId, year, { currency });
    },

    async list(tenantId, year, { currency } = {}) {
      checkYear(year);
      const cur = assertCurrency(currency ?? (await tenantCurrency(tenantId)));
      const rows = await budgetsOf(tenantId).find({ year, currency: cur }, { sort: { accountId: 1, costCenter: 1 } }).toArray();
      const chart = new Map((await accounts.list(tenantId)).map((a) => [a.code, a]));
      const lines = rows
        .filter((r) => r.months.some((m) => m !== 0))
        .map((r) => ({ accountId: r.accountId, name: chart.get(r.accountId)?.name ?? null, type: chart.get(r.accountId)?.type ?? null, costCenter: r.costCenter || null, months: r.months, total: r.months.reduce((a, b) => a + b, 0) }));
      return { year, currency: cur, lines };
    },

    /** Presupuesto contra lo real, por cuenta, en un rango de meses de un mismo año. */
    async execution(tenantId, { from, to, currency, costCenter }) {
      assertPeriod(from);
      assertPeriod(to);
      if (from > to) throw new LedgerValidationError('el período inicial no puede ser posterior al final');
      const year = Number(from.slice(0, 4));
      if (to.slice(0, 4) !== from.slice(0, 4)) throw new LedgerValidationError('la ejecución presupuestal se pide dentro de un mismo año');
      const cur = assertCurrency(currency);
      const center = normalizeCenter(costCenter) ?? '';
      const first = Number(from.slice(5)) - 1;
      const last = Number(to.slice(5)) - 1;
      const chart = new Map((await accounts.list(tenantId)).map((a) => [a.code, a]));

      const budgetRows = await budgetsOf(tenantId).find({ year, currency: cur, ...(center ? { costCenter: center } : {}) }).toArray();
      const budget = new Map();
      for (const r of budgetRows) budget.set(r.accountId, (budget.get(r.accountId) ?? 0) + r.months.slice(first, last + 1).reduce((a, b) => a + b, 0));

      const codes = [...chart.values()].filter((a) => RESULT_TYPES.includes(a.type) && a.postable).map((a) => a.code);
      const actualRows = center
        ? await dimOf(tenantId)
            .aggregate([
              { $match: { dimension: 'costCenter', key: center, currency: cur, accountId: { $in: codes }, period: { $gte: from, $lte: to } } },
              { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
            ])
            .toArray()
        : await balancesOf(tenantId)
            .aggregate([
              { $match: { currency: cur, accountId: { $in: codes }, period: { $gte: from, $lte: to } } },
              { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
            ])
            .toArray();
      const actual = new Map(actualRows.map((r) => [r._id, { debit: Number(r.debit), credit: Number(r.credit) }]));
      if (!center) {
        for (const e of await closingEffects(db, tenantId, cur, to)) {
          const row = actual.get(e.accountId);
          if (e.period >= from && row) {
            row.debit -= e.debit;
            row.credit -= e.credit;
          }
        }
      }

      const rows = [...new Set([...budget.keys(), ...actual.keys()])]
        .map((code) => {
          const account = chart.get(code);
          const a = actual.get(code) ?? { debit: 0, credit: 0 };
          const planned = budget.get(code) ?? 0;
          const real = natural(account?.type, a.debit, a.credit);
          return { code, name: account?.name ?? null, type: account?.type ?? null, budget: planned, actual: real, variance: real - planned, variancePct: planned === 0 ? null : Math.round(((real - planned) * 10_000) / planned) };
        })
        .filter((r) => r.budget !== 0 || r.actual !== 0)
        .sort((a, b) => (a.code < b.code ? -1 : 1));
      const totalOf = (type, field) => rows.filter((r) => r.type === type).reduce((acc, r) => acc + r[field], 0);
      const totals = {};
      for (const field of ['budget', 'actual']) {
        totals[field] = { income: totalOf('income', field), cost: totalOf('cost', field), expense: totalOf('expense', field) };
        totals[field].result = totals[field].income - totals[field].cost - totals[field].expense;
      }
      return { from, to, currency: cur, costCenter: center || null, rows, totals };
    },
  };
}
