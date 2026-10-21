import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createLedger } from '../ledger/ledger.js';
import { createReportService } from '../reports/reports.js';
import { startMongo } from '../testing/mongo.js';
import { createYearEndService } from './yearEnd.js';

let mongo;
let db;
let ledger;
let accounts;
let reports;
let yearEnd;
let tenant;
let n = 0;

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);
const day = (iso) => new Date(`${iso}T12:00:00Z`);
const ctx = { userId: null };

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital social', 'equity', '3');
  await make('360505', 'Utilidad del ejercicio', 'equity', '3');
  await make('360510', 'Pérdida del ejercicio', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('510506', 'Sueldos', 'expense', '5');
  await make('6', 'Costos de ventas', 'cost');
  await make('613505', 'Costo de mercancía vendida', 'cost', '6');
}

const post = (date, lines, currency = 'COP') =>
  ledger.postJournal(tenant, { docType: 'AJ', date: day(date), currency, idempotencyKey: `aj-${(n += 1)}-aaaaaaaa`, lines });
/** Una venta de `income`, con `cost` y `expense` del mismo día, todo cobrado en caja. */
async function year(y, { income, cost = 0, expense = 0, currency = 'COP', month = '03' }) {
  const date = `${y}-${month}-10`;
  await post(date, [{ accountId: '110505', debit: income }, { accountId: '413505', credit: income }], currency);
  if (cost) await post(date, [{ accountId: '613505', debit: cost }, { accountId: '110505', credit: cost }], currency);
  if (expense) await post(date, [{ accountId: '510506', debit: expense }, { accountId: '110505', credit: expense }], currency);
}
const close = (y, patch = {}, currency = 'COP') => yearEnd.close(tenant, { year: y, currency, profitAccount: '360505', lossAccount: '360510', ...patch }, ctx);
const net = async (account, currency = 'COP') => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account, currency }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};
const periodDoc = (period) => db.collection(COLLECTIONS.periods).findOne({ tenantId: tenant, period });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_year_end_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
  reports = createReportService(db, accounts);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  await openChart();
  yearEnd = createYearEndService({ client: mongo.client, db, ledger, accounts });
});

describe('cierre con utilidad', () => {
  it('lleva a cero ingresos, costos y gastos y deja la utilidad en el patrimonio', async () => {
    await year(2025, { income: 1_000_000, cost: 300_000, expense: 200_000 });
    const preview = await yearEnd.preview(tenant, { year: 2025, currency: 'COP' });
    expect(preview.totals).toEqual({ income: 1_000_000, cost: 300_000, expense: 200_000, result: 500_000 });
    expect(preview.blockers).toEqual([]);
    expect(preview.closed).toBeNull();

    const { journal, replayed, periodsClosed, pendingCurrencies } = await close(2025);
    expect(replayed).toBe(false);
    expect(pendingCurrencies).toEqual([]);
    expect(periodsClosed).toHaveLength(12);
    expect(journal).toMatchObject({ docType: 'CA', totalDebit: 1_000_000, totalCredit: 1_000_000, period: '2025-12', source: { kind: 'year_close', year: 2025, result: 500_000 } });
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: '413505', debit: 1_000_000 }),
        expect.objectContaining({ accountId: '613505', credit: 300_000 }),
        expect.objectContaining({ accountId: '510506', credit: 200_000 }),
        expect.objectContaining({ accountId: '360505', credit: 500_000 }),
      ]),
    );
    for (const account of ['413505', '613505', '510506']) expect(await net(account)).toBe(0);
    expect(await net('360505')).toBe(-500_000);
  });

  it('el balance general trae la utilidad en el patrimonio y sigue cuadrado, y el estado de resultados muestra la actividad real', async () => {
    await year(2025, { income: 1_000_000, cost: 300_000, expense: 200_000 });
    const before = await reports.balanceSheet(tenant, { to: '2025-12', currency: 'COP' });
    expect(before.totals).toMatchObject({ equity: 0, result: 500_000 });
    await close(2025);
    const after = await reports.balanceSheet(tenant, { to: '2025-12', currency: 'COP' });
    expect(after.totals).toMatchObject({ assets: 500_000, equity: 500_000, result: 0 });
    expect(after.difference ?? after.totals.assets - after.totals.equity - after.totals.result).toBe(0);

    const income = await reports.incomeStatement(tenant, { from: '2025-01', to: '2025-12', currency: 'COP' });
    expect(income.totals).toMatchObject({ income: 1_000_000, cost: 300_000, expense: 200_000, grossProfit: 700_000, net: 500_000 });
    const december = await reports.incomeStatement(tenant, { from: '2025-12', to: '2025-12', currency: 'COP' });
    expect(december.totals.net).toBe(0);
    const trial = await reports.trialBalance(tenant, { from: '2025-01', to: '2025-12', currency: 'COP' });
    expect(trial.balanced).toBe(true);
  });

  it('el año siguiente empieza de cero', async () => {
    await year(2025, { income: 1_000_000, cost: 300_000, expense: 200_000 });
    await close(2025);
    await year(2026, { income: 400_000, expense: 100_000 });
    const sheet = await reports.balanceSheet(tenant, { to: '2026-12', currency: 'COP' });
    expect(sheet.totals).toMatchObject({ equity: 500_000, result: 300_000 });
    const income = await reports.incomeStatement(tenant, { from: '2026-01', to: '2026-12', currency: 'COP' });
    expect(income.totals).toMatchObject({ income: 400_000, net: 300_000 });
    const two = await reports.incomeStatement(tenant, { from: '2025-01', to: '2026-12', currency: 'COP' });
    expect(two.totals).toMatchObject({ income: 1_400_000, net: 800_000 });
  });
});

describe('cierre con pérdida', () => {
  it('la pérdida va al débito de la cuenta de pérdida', async () => {
    await year(2025, { income: 100_000, expense: 350_000 });
    const { journal } = await close(2025);
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '360510', debit: 250_000 })]));
    expect(await net('360510')).toBe(250_000);
    const sheet = await reports.balanceSheet(tenant, { to: '2025-12', currency: 'COP' });
    expect(sheet.totals).toMatchObject({ equity: -250_000, result: 0 });
  });

  it('sin cuenta de pérdida aparte, usa la misma de la utilidad', async () => {
    await year(2025, { income: 100_000, expense: 350_000 });
    const { journal } = await yearEnd.close(tenant, { year: 2025, currency: 'COP', profitAccount: '360505' }, ctx);
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '360505', debit: 250_000 })]));
  });
});

describe('reglas del cierre', () => {
  it('cerrar dos veces devuelve el cierre existente sin asentar otro', async () => {
    await year(2025, { income: 1_000_000 });
    const first = await close(2025);
    const again = await close(2025);
    expect(again.replayed).toBe(true);
    expect(again.journal._id).toEqual(first.journal._id);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'CA' })).toBe(1);
    expect((await yearEnd.list(tenant)).map((c) => [c.year, c.currency])).toEqual([[2025, 'COP']]);
  });

  it('dos cierres a la vez asientan uno solo', async () => {
    await year(2025, { income: 1_000_000, expense: 100_000 });
    const results = await Promise.allSettled([close(2025), close(2025)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'CA' })).toBe(1);
    expect(await net('413505')).toBe(0);
  });

  it('se cierra en orden: antes hay que cerrar el año anterior con movimiento', async () => {
    await year(2024, { income: 200_000 });
    await year(2025, { income: 1_000_000 });
    expect((await yearEnd.preview(tenant, { year: 2025, currency: 'COP' })).blockers).toEqual(['cierra primero el ejercicio 2024']);
    expect(await code(close(2025))).toBe('INVALID_STATE');
    await close(2024);
    expect((await close(2025)).replayed).toBe(false);
  });

  it('un año sin movimiento antes no estorba', async () => {
    await year(2025, { income: 1_000_000 });
    expect((await close(2025)).replayed).toBe(false);
  });

  it('valida el año, la moneda, las cuentas y que haya algo que cerrar', async () => {
    await year(2025, { income: 1_000_000 });
    expect(await code(close(1999))).toBe('VALIDATION');
    expect(await code(close(2025, { currency: 'XXX' }))).toBe('MoneyError');
    expect(await code(close(2025, { profitAccount: '' }))).toBe('VALIDATION');
    expect(await code(close(2025, { profitAccount: '413505' }))).toBe('VALIDATION'); // un ingreso no es patrimonio
    expect(await code(close(2025, { profitAccount: '999999' }))).toBe('VALIDATION');
    expect(await code(close(2025, { profitAccount: '3' }))).toBe('VALIDATION'); // agrupación
    expect(await code(close(2025, { lossAccount: '110505' }))).toBe('VALIDATION');
    expect(await code(close(2023))).toBe('INVALID_STATE'); // sin movimiento
    expect(await code(close(2099))).toBe('VALIDATION'); // aún no termina
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'CA' })).toBe(0);
  });

  it('con diciembre cerrado a mano no se puede asentar el cierre, y la vista previa lo dice', async () => {
    await year(2025, { income: 1_000_000 });
    await ledger.closePeriod(tenant, '2025-12', null);
    expect((await yearEnd.preview(tenant, { year: 2025, currency: 'COP' })).blockers.join(' ')).toMatch(/2025-12 está cerrado/);
    expect(await code(close(2025))).toBe('PeriodClosedError');
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'CA' })).toBe(0);
  });

  it('el cierre cierra los doce períodos y un asiento tardío del año ya no entra', async () => {
    await year(2025, { income: 1_000_000 });
    await close(2025);
    for (const p of ['2025-01', '2025-06', '2025-12']) expect((await periodDoc(p)).status).toBe('closed');
    expect((await periodDoc('2025-06')).closedByYear).toBe(2025);
    expect(await code(post('2025-06-15', [{ accountId: '110505', debit: 5 }, { accountId: '413505', credit: 5 }]))).toBe('PeriodClosedError');
    expect(await net('413505')).toBe(0);
    await expect(yearEnd.assertPeriodReopenable(tenant, '2025-06')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(yearEnd.assertPeriodReopenable(tenant, '2026-01')).resolves.toBeUndefined();
  });

  it('con varias monedas, los períodos se cierran cuando todas las monedas con resultados están cerradas', async () => {
    await year(2025, { income: 1_000_000 });
    await year(2025, { income: 50_000, currency: 'USD' });
    const first = await close(2025);
    expect(first.pendingCurrencies).toEqual(['USD']);
    expect(first.periodsClosed).toEqual([]);
    expect((await periodDoc('2025-06'))?.status ?? 'open').toBe('open');
    const second = await close(2025, {}, 'USD');
    expect(second.pendingCurrencies).toEqual([]);
    expect(second.periodsClosed).toHaveLength(12);
    expect((await periodDoc('2025-06')).status).toBe('closed');
    expect(await net('413505', 'USD')).toBe(0);
    expect((await yearEnd.list(tenant)).map((c) => c.currency).sort()).toEqual(['COP', 'USD']);
  });

  it('el cierre es de la moneda: cerrar pesos no toca los dólares', async () => {
    await year(2025, { income: 1_000_000 });
    await year(2025, { income: 50_000, currency: 'USD' });
    await close(2025);
    expect(await net('413505', 'USD')).toBe(-50_000);
    expect(await net('413505', 'COP')).toBe(0);
  });
});

describe('reabrir el ejercicio', () => {
  it('reversa el cierre, reabre los períodos y permite asentar de nuevo', async () => {
    await year(2025, { income: 1_000_000, expense: 400_000 });
    await close(2025);
    const { journal, periodsReopened } = await yearEnd.reopen(tenant, { year: 2025, currency: 'COP' }, ctx);
    expect(journal.reversesJournalId).toBeDefined();
    expect(periodsReopened).toHaveLength(12);
    expect(await net('413505')).toBe(-1_000_000);
    expect(await net('510506')).toBe(400_000);
    expect(await net('360505')).toBe(0);
    expect((await periodDoc('2025-06')).status).toBe('open');
    expect((await periodDoc('2025-06')).closedByYear).toBeUndefined();
    expect(await yearEnd.list(tenant)).toEqual([]);
    expect((await yearEnd.preview(tenant, { year: 2025, currency: 'COP' })).closed).toBeNull();

    // Se corrige algo del año y se vuelve a cerrar: el cierre nuevo cuenta lo corregido, no el reverso.
    await year(2025, { income: 100_000, month: '11' });
    const again = await close(2025);
    expect(again.replayed).toBe(false);
    expect(again.journal.source.result).toBe(700_000);
    expect(await net('413505')).toBe(0);
    expect(await net('360505')).toBe(-700_000);
    const income = await reports.incomeStatement(tenant, { from: '2025-01', to: '2025-12', currency: 'COP' });
    expect(income.totals).toMatchObject({ income: 1_100_000, expense: 400_000, net: 700_000 });
  });

  it('no se reabre un ejercicio si hay uno posterior cerrado, ni uno que no está cerrado', async () => {
    await year(2024, { income: 1_000_000 });
    await year(2025, { income: 500_000 });
    expect(await code(yearEnd.reopen(tenant, { year: 2024, currency: 'COP' }, ctx))).toBe('NOT_FOUND');
    await close(2024);
    await close(2025);
    expect(await code(yearEnd.reopen(tenant, { year: 2024, currency: 'COP' }, ctx))).toBe('INVALID_STATE');
    await yearEnd.reopen(tenant, { year: 2025, currency: 'COP' }, ctx);
    await yearEnd.reopen(tenant, { year: 2024, currency: 'COP' }, ctx);
    expect(await net('413505')).toBe(-1_500_000);
  });

  it('si la reversión falla, los períodos vuelven a quedar cerrados', async () => {
    await year(2025, { income: 1_000_000 });
    await close(2025);
    const failing = createYearEndService({
      client: mongo.client,
      db,
      accounts,
      ledger: { ...ledger, reverseJournal: async () => Promise.reject(new Error('base caída')) },
    });
    await expect(failing.reopen(tenant, { year: 2025, currency: 'COP' }, ctx)).rejects.toThrow('base caída');
    expect((await periodDoc('2025-06')).status).toBe('closed');
    expect((await periodDoc('2025-06')).closedByYear).toBe(2025);
    expect((await yearEnd.list(tenant)).map((c) => c.year)).toEqual([2025]);
  });
});
