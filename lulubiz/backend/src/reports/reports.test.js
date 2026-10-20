import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { toTenantId } from '../core/tenant.js';
import { ensureIndexes } from '../data/db.js';
import { createLedger } from '../ledger/ledger.js';
import { startMongo } from '../testing/mongo.js';
import { createReportService } from './reports.js';

let mongo;
let db;
let ledger;
let accounts;
let reports;
let tenant;
let other;
let n = 0;

const CHART = [
  ['1', 'Activo', 'asset', null, false],
  ['11', 'Disponible', 'asset', '1', false],
  ['110505', 'Caja general', 'asset', '11', true],
  ['13', 'Deudores', 'asset', '1', false],
  ['130505', 'Clientes nacionales', 'asset', '13', true],
  ['2', 'Pasivo', 'liability', null, false],
  ['240805', 'IVA por pagar', 'liability', '2', true],
  ['3', 'Patrimonio', 'equity', null, false],
  ['310505', 'Capital social', 'equity', '3', true],
  ['4', 'Ingresos', 'income', null, false],
  ['413535', 'Ventas', 'income', '4', true],
  ['5', 'Gastos', 'expense', null, false],
  ['510506', 'Sueldos', 'expense', '5', true],
  ['6', 'Costos', 'cost', null, false],
  ['613505', 'Costo de ventas', 'cost', '6', true],
];

async function openChart(tenantId) {
  for (const [code, name, type, parentCode, postable] of CHART) {
    await accounts.create(tenantId, { code, name, type, ...(parentCode ? { parentCode } : {}), postable });
  }
}

const post = (tenantId, date, lines, extra = {}) =>
  ledger.postJournal(tenantId, {
    docType: 'CG',
    date: new Date(`${date}T12:00:00Z`),
    currency: 'COP',
    idempotencyKey: `k-${(n += 1)}`,
    lines: lines.map(([accountId, debit = 0, credit = 0]) => ({ accountId, debit, credit })),
    ...extra,
  });

const row = (rows, code) => rows.find((r) => r.code === code);

beforeAll(async () => {
  mongo = await startMongo();
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
  tenant = toTenantId(new ObjectId());
  other = toTenantId(new ObjectId());
  await openChart(tenant);
  await openChart(other);
});

/** Capital en septiembre; ventas y un gasto en octubre; otra venta en noviembre. */
async function seedYear() {
  await post(tenant, '2026-09-02', [['110505', 5_000_000], ['310505', 0, 5_000_000]]);
  await post(tenant, '2026-10-05', [['130505', 1_190_000], ['413535', 0, 1_000_000], ['240805', 0, 190_000]]);
  await post(tenant, '2026-10-20', [['510506', 300_000], ['110505', 0, 300_000]]);
  await post(tenant, '2026-11-03', [['110505', 595_000], ['413535', 0, 500_000], ['240805', 0, 95_000]]);
  await post(tenant, '2026-11-04', [['613505', 200_000], ['110505', 0, 200_000]]);
}

describe('balance de prueba', () => {
  it('separa saldo inicial, movimiento y saldo final, y suma las cuentas de grupo', async () => {
    await seedYear();
    const result = await reports.trialBalance(tenant, { from: '2026-10', to: '2026-10', currency: 'COP' });

    expect(row(result.rows, '110505')).toMatchObject({ opening: 5_000_000, debit: 0, credit: 300_000, closing: 4_700_000 });
    expect(row(result.rows, '130505')).toMatchObject({ opening: 0, debit: 1_190_000, credit: 0, closing: 1_190_000 });
    expect(row(result.rows, '413535')).toMatchObject({ nature: 'credit', opening: 0, credit: 1_000_000, closing: 1_000_000 });
    // Las cuentas de grupo acumulan a sus hijas en todos los niveles.
    expect(row(result.rows, '11')).toMatchObject({ postable: false, closing: 4_700_000 });
    expect(row(result.rows, '1')).toMatchObject({ closing: 5_890_000 });
    expect(row(result.rows, '13').closing).toBe(1_190_000);
    // Noviembre queda fuera del rango.
    expect(row(result.rows, '613505')).toBeUndefined();
    expect(result.totals).toEqual({ debit: 1_490_000, credit: 1_490_000 });
    expect(result.balanced).toBe(true);
  });

  it('un rango de varios meses suma el movimiento y deja el saldo inicial anterior al rango', async () => {
    await seedYear();
    const result = await reports.trialBalance(tenant, { from: '2026-10', to: '2026-11', currency: 'COP' });
    expect(row(result.rows, '110505')).toMatchObject({ opening: 5_000_000, debit: 595_000, credit: 500_000, closing: 5_095_000 });
    expect(row(result.rows, '413535')).toMatchObject({ credit: 1_500_000, closing: 1_500_000 });
    expect(result.balanced).toBe(true);
  });

  it('las filas salen en orden de código, con los grupos antes que sus hijas', async () => {
    await seedYear();
    const { rows } = await reports.trialBalance(tenant, { from: '2026-09', to: '2026-11', currency: 'COP' });
    const codes = rows.map((r) => r.code);
    expect(codes).toEqual([...codes].sort());
    expect(codes.indexOf('1')).toBeLessThan(codes.indexOf('11'));
    expect(codes.indexOf('11')).toBeLessThan(codes.indexOf('110505'));
  });

  it('no mezcla monedas ni empresas', async () => {
    await seedYear();
    await post(tenant, '2026-10-06', [['110505', 100], ['310505', 0, 100]], { currency: 'USD' });
    await post(other, '2026-10-06', [['110505', 999_999], ['310505', 0, 999_999]]);
    const cop = await reports.trialBalance(tenant, { from: '2026-10', to: '2026-10', currency: 'COP' });
    const usd = await reports.trialBalance(tenant, { from: '2026-10', to: '2026-10', currency: 'USD' });
    expect(row(cop.rows, '110505').debit).toBe(0);
    expect(row(usd.rows, '110505')).toMatchObject({ debit: 100, closing: 100 });
    expect(row(usd.rows, '413535')).toBeUndefined();
  });

  it('una empresa sin movimiento devuelve un balance vacío y cuadrado', async () => {
    const result = await reports.trialBalance(other, { from: '2026-01', to: '2026-12', currency: 'COP' });
    expect(result.rows).toEqual([]);
    expect(result.balanced).toBe(true);
  });

  it('rechaza rangos y monedas inválidos', async () => {
    await expect(reports.trialBalance(tenant, { from: '2026-11', to: '2026-10', currency: 'COP' })).rejects.toThrow(/posterior/);
    await expect(reports.trialBalance(tenant, { from: '2026-1', to: '2026-10', currency: 'COP' })).rejects.toThrow(/AAAA-MM/);
    await expect(reports.trialBalance(tenant, { from: '2026-10', to: '2026-10', currency: 'XXX' })).rejects.toThrow(/moneda/);
  });
});

describe('estado de resultados', () => {
  it('calcula utilidad bruta y neta del rango', async () => {
    await seedYear();
    const october = await reports.incomeStatement(tenant, { from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(october.totals).toEqual({ income: 1_000_000, cost: 0, expense: 300_000, grossProfit: 1_000_000, net: 700_000 });

    const all = await reports.incomeStatement(tenant, { from: '2026-09', to: '2026-11', currency: 'COP' });
    expect(all.totals).toEqual({ income: 1_500_000, cost: 200_000, expense: 300_000, grossProfit: 1_300_000, net: 1_000_000 });
    expect(all.income.map((r) => r.code)).toEqual(['4', '413535']);
    // El grupo se muestra pero no se suma dos veces.
    expect(all.income.find((r) => r.code === '4')).toMatchObject({ postable: false, amount: 1_500_000 });
  });

  it('una devolución en contra resta de los ingresos', async () => {
    await post(tenant, '2026-10-05', [['130505', 100_000], ['413535', 0, 100_000]]);
    await post(tenant, '2026-10-06', [['413535', 30_000], ['130505', 0, 30_000]]);
    const result = await reports.incomeStatement(tenant, { from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(result.totals.income).toBe(70_000);
  });
});

describe('balance general', () => {
  it('cumple activo = pasivo + patrimonio + resultado acumulado', async () => {
    await seedYear();
    const sheet = await reports.balanceSheet(tenant, { to: '2026-11', currency: 'COP' });
    // Caja 5.000.000 − 300.000 + 595.000 − 200.000; clientes 1.190.000.
    expect(sheet.totals.assets).toBe(5_095_000 + 1_190_000);
    expect(sheet.totals.liabilities).toBe(285_000);
    expect(sheet.totals.equity).toBe(5_000_000);
    expect(sheet.totals.result).toBe(1_000_000);
    expect(sheet.difference).toBe(0);
    expect(sheet.balanced).toBe(true);
  });

  it('al corte de un período anterior no ve lo posterior', async () => {
    await seedYear();
    const sheet = await reports.balanceSheet(tenant, { to: '2026-09', currency: 'COP' });
    expect(sheet.totals).toMatchObject({ assets: 5_000_000, liabilities: 0, equity: 5_000_000, result: 0 });
    expect(sheet.balanced).toBe(true);
  });

  it('las cuentas de orden no rompen la ecuación: su saldo neto se informa aparte', async () => {
    await accounts.create(tenant, { code: '8', name: 'Cuentas de orden deudoras', type: 'memo', nature: 'debit', postable: false });
    await accounts.create(tenant, { code: '810505', name: 'Bienes recibidos en garantía', type: 'memo', nature: 'debit', parentCode: '8' });
    await accounts.create(tenant, { code: '9', name: 'Contrapartida de orden', type: 'memo', nature: 'credit', postable: false });
    await accounts.create(tenant, { code: '910505', name: 'Contrapartida garantías', type: 'memo', nature: 'credit', parentCode: '9' });
    await post(tenant, '2026-10-01', [['810505', 700_000], ['910505', 0, 700_000]]);
    await post(tenant, '2026-10-02', [['110505', 100_000], ['310505', 0, 100_000]]);
    // Un asiento que mezcla una cuenta de orden con una real queda fuera de la ecuación contable.
    await post(tenant, '2026-10-03', [['810505', 50_000], ['110505', 0, 50_000]]);
    const sheet = await reports.balanceSheet(tenant, { to: '2026-10', currency: 'COP' });
    expect(sheet.memoNet).toBe(700_000 - 700_000 + 50_000);
    expect(sheet.difference).toBe(-50_000);
    expect(sheet.balanced).toBe(true);
    const trial = await reports.trialBalance(tenant, { from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(trial.balanced).toBe(true);
  });
});

describe('libro auxiliar', () => {
  it('muestra saldo inicial, saldo corrido en orden cronológico y saldo final', async () => {
    await seedYear();
    const result = await reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-11', currency: 'COP' });
    expect(result.opening).toEqual({ debit: 5_000_000, credit: 0, balance: 5_000_000 });
    expect(result.items.map((i) => [i.debit, i.credit, i.balance])).toEqual([
      [0, 300_000, 4_700_000],
      [595_000, 0, 5_295_000],
      [0, 200_000, 5_095_000],
    ]);
    expect(result.items.map((i) => i.number)).toEqual([3, 4, 5]);
    expect(result.closing).toEqual({ debit: 5_595_000, credit: 500_000, balance: 5_095_000 });
    expect(result.nextCursor).toBeNull();
  });

  it('un asiento con fecha anterior aparece en su lugar cronológico, no en el orden de registro', async () => {
    await post(tenant, '2026-10-20', [['110505', 100], ['310505', 0, 100]]);
    await post(tenant, '2026-10-05', [['110505', 40], ['310505', 0, 40]]);
    const { items } = await reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(items.map((i) => [i.debit, i.balance])).toEqual([[40, 40], [100, 140]]);
  });

  it('pagina con cursor y llega al mismo saldo final que sin paginar', async () => {
    for (let i = 1; i <= 7; i += 1) {
      await post(tenant, `2026-10-${String(i).padStart(2, '0')}`, [['110505', i * 1000], ['310505', 0, i * 1000]]);
    }
    const whole = await reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP' });
    const pages = [];
    let cursor;
    do {
      const page = await reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP', limit: 3, cursor });
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(pages[0].opening).toBeDefined();
    expect(pages[1].opening).toBeUndefined();
    expect(pages[0].closing).toBeUndefined();
    expect(pages.flatMap((p) => p.items.map((i) => i.balance))).toEqual(whole.items.map((i) => i.balance));
    expect(pages[2].closing).toEqual(whole.closing);
    expect(whole.closing.balance).toBe(28_000);
  });

  it('muestra las reversiones y cuadra con el balance de prueba', async () => {
    const { journal } = await post(tenant, '2026-10-05', [['130505', 500], ['413535', 0, 500]]);
    await ledger.reverseJournal(tenant, journal._id, { idempotencyKey: 'rev-1', date: new Date('2026-10-06T12:00:00Z') });
    const { items, closing } = await reports.generalLedger(tenant, { account: '130505', from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(items).toHaveLength(2);
    expect(items[1].reversesJournalId).toEqual(journal._id);
    expect(closing.balance).toBe(0);
  });

  it('una cuenta de naturaleza crédito acumula en positivo del lado del crédito', async () => {
    await seedYear();
    const { closing, items } = await reports.generalLedger(tenant, { account: '413535', from: '2026-09', to: '2026-11', currency: 'COP' });
    expect(items.map((i) => i.balance)).toEqual([1_000_000, 1_500_000]);
    expect(closing.balance).toBe(1_500_000);
  });

  it('rechaza cuentas inexistentes y cursores manipulados', async () => {
    await expect(reports.generalLedger(tenant, { account: '999999', from: '2026-10', to: '2026-10', currency: 'COP' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP', cursor: 'no-es-un-cursor' })).rejects.toThrow(/cursor/);
    const forged = Buffer.from(JSON.stringify({ d: '2026-10-01T00:00:00Z', i: 'zz', dr: 1, cr: 1 })).toString('base64url');
    await expect(reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP', cursor: forged })).rejects.toThrow(/cursor/);
  });

  it('no ve los asientos de otra empresa', async () => {
    await post(other, '2026-10-05', [['110505', 777], ['310505', 0, 777]]);
    const result = await reports.generalLedger(tenant, { account: '110505', from: '2026-10', to: '2026-10', currency: 'COP' });
    expect(result.items).toEqual([]);
    expect(result.closing.balance).toBe(0);
  });
});

describe('coherencia entre reportes (asientos al azar)', () => {
  it('el libro auxiliar de cada cuenta termina en el saldo del balance de prueba y todo cuadra', async () => {
    // Generador determinista: la misma secuencia en cada corrida.
    let seed = 20261020;
    const rand = (max) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const postable = CHART.filter((c) => c[4]).map((c) => c[0]);
    for (let i = 0; i < 60; i += 1) {
      const a = postable[rand(postable.length)];
      let b = postable[rand(postable.length)];
      if (a === b) b = postable[(postable.indexOf(a) + 1) % postable.length];
      const amount = 1 + rand(9_999_999);
      const month = String(9 + rand(4)).padStart(2, '0');
      const day = String(1 + rand(27)).padStart(2, '0');
      await post(tenant, `2026-${month}-${day}`, [[a, amount], [b, 0, amount]]);
    }
    const range = { from: '2026-09', to: '2026-12', currency: 'COP' };
    const trial = await reports.trialBalance(tenant, range);
    expect(trial.balanced).toBe(true);
    for (const r of trial.rows.filter((x) => x.postable)) {
      const ledgerView = await reports.generalLedger(tenant, { account: r.code, ...range, limit: 7 });
      let last = ledgerView;
      let guard = 0;
      while (last.nextCursor && guard < 50) {
        last = await reports.generalLedger(tenant, { account: r.code, ...range, limit: 7, cursor: last.nextCursor });
        guard += 1;
      }
      expect(last.closing.balance, `cuenta ${r.code}`).toBe(r.closing);
    }
    const sheet = await reports.balanceSheet(tenant, { to: '2026-12', currency: 'COP' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.difference).toBe(0);
  });
});
