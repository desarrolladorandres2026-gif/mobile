import { DAY_MS, dayOf, parseDay as parseCalendarDay, startOfDay } from '../core/dates.js';
import { assertCurrency } from '../core/money.js';
import { COLLECTIONS } from '../data/db.js';
import { TenantCollection } from '../data/tenantCollection.js';
import { LedgerValidationError } from '../ledger/ledger.js';

export const DEFAULT_CASH_PREFIXES = ['11'];
export const DEFAULT_INVESTING = ['12', '15', '16'];
export const DEFAULT_FINANCING = ['21'];
const MAX_ACCOUNTS = 50;

const fail = (message) => {
  throw new LedgerValidationError(message);
};
const parseDay = (value, label) => parseCalendarDay(value, label, fail);
const prefixes = (value, fallback, label) => {
  if (value === undefined || value === '') return fallback;
  const list = String(value).split(',').map((p) => p.trim()).filter(Boolean);
  for (const p of list) if (!/^[0-9]{1,12}$/.test(p)) fail(`${label}: «${p}» no es un prefijo de cuenta`);
  return list;
};

/** La actividad de una cuenta del otro lado del efectivo: inversión, financiación u operación. */
export function categoryOf(account, { investing, financing }) {
  if (account.type === 'equity') return 'financing';
  if (financing.some((p) => account.code.startsWith(p))) return 'financing';
  if (investing.some((p) => account.code.startsWith(p))) return 'investing';
  return 'operating';
}

/*
 * Estado de flujo de efectivo, método directo. Para cada asiento que toca una cuenta de efectivo (caja y bancos), las líneas
 * que **no** son de efectivo explican de dónde vino o a dónde fue ese dinero: como el asiento cuadra, la suma de (crédito −
 * débito) de esas líneas es exactamente el cambio de efectivo. Cada cuenta del otro lado se clasifica en una actividad:
 *
 *  - Financiación: patrimonio y las cuentas que empiecen por los prefijos de financiación (por omisión 21, obligaciones financieras).
 *  - Inversión: las que empiecen por los prefijos de inversión (por omisión 12, 15 y 16: inversiones, propiedades y equipo,
 *    intangibles).
 *  - Operación: todo lo demás (ventas, compras, gastos, impuestos, cartera, proveedores, anticipos).
 *
 * Las cuentas de efectivo por omisión son las de prefijo 11. Un traspaso entre cuentas de efectivo no aparece (no cambia el
 * efectivo). Los prefijos se pueden cambiar en la consulta, y el cierre de ejercicio no cuenta (no toca efectivo).
 * El informe cuadra por construcción: saldo inicial + cambio = saldo final, y el saldo final es el del libro.
 */
export function createCashFlowReport(db, accounts) {
  const journalsOf = (tenantId) => new TenantCollection(db.collection(COLLECTIONS.journals), tenantId);

  return {
    async cashFlow(tenantId, { from, to, currency, cash, investing, financing }) {
      const start = startOfDay(parseDay(from, 'la fecha inicial'));
      const end = new Date(startOfDay(parseDay(to, 'la fecha final')).getTime() + DAY_MS);
      if (start >= end) fail('la fecha inicial no puede ser posterior a la final');
      assertCurrency(currency);
      const map = { investing: prefixes(investing, DEFAULT_INVESTING, 'inversión'), financing: prefixes(financing, DEFAULT_FINANCING, 'financiación') };
      const cashPrefixes = prefixes(cash, DEFAULT_CASH_PREFIXES, 'efectivo');
      const chart = await accounts.list(tenantId);
      const byCode = new Map(chart.map((a) => [a.code, a]));
      const cashAccounts = chart.filter((a) => a.postable && a.type === 'asset' && cashPrefixes.some((p) => a.code.startsWith(p))).map((a) => a.code);
      if (cashAccounts.length > MAX_ACCOUNTS) fail(`hay más de ${MAX_ACCOUNTS} cuentas de efectivo: acota los prefijos`);
      const base = { accounts: cashAccounts.map((code) => ({ code, name: byCode.get(code)?.name ?? null })), from: dayOf(start), to: dayOf(new Date(end.getTime() - DAY_MS)), currency };
      if (cashAccounts.length === 0) return { ...base, opening: 0, closing: 0, change: 0, sections: { operating: { rows: [], total: 0 }, investing: { rows: [], total: 0 }, financing: { rows: [], total: 0 } } };

      const sumCash = async (match) => {
        const [row] = await journalsOf(tenantId)
          .aggregate([{ $match: { currency, 'lines.accountId': { $in: cashAccounts }, ...match } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': { $in: cashAccounts } } }, { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }])
          .toArray();
        return row ? Number(row.debit) - Number(row.credit) : 0;
      };
      const [opening, change, others] = await Promise.all([
        sumCash({ date: { $lt: start } }),
        sumCash({ date: { $gte: start, $lt: end } }),
        journalsOf(tenantId)
          .aggregate([
            { $match: { currency, date: { $gte: start, $lt: end }, 'lines.accountId': { $in: cashAccounts } } },
            { $unwind: '$lines' },
            { $match: { 'lines.accountId': { $nin: cashAccounts } } },
            { $group: { _id: '$lines.accountId', amount: { $sum: { $subtract: [{ $ifNull: ['$lines.credit', 0] }, { $ifNull: ['$lines.debit', 0] }] } } } },
          ])
          .toArray(),
      ]);

      const sections = { operating: { rows: [], total: 0 }, investing: { rows: [], total: 0 }, financing: { rows: [], total: 0 } };
      for (const r of others) {
        const amount = Number(r.amount);
        if (amount === 0) continue;
        const account = byCode.get(r._id) ?? { code: r._id, type: 'asset' };
        const section = sections[categoryOf(account, map)];
        section.rows.push({ code: r._id, name: account.name ?? null, amount });
        section.total += amount;
      }
      for (const s of Object.values(sections)) s.rows.sort((a, b) => (a.code < b.code ? -1 : 1));
      return { ...base, opening, change, closing: opening + change, sections };
    },
  };
}
