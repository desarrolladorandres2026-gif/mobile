import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { categoryOf } from '../reports/cashflow.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const Y = new Date().getUTCFullYear() - 1; // un año pasado: sus períodos están abiertos y el cierre de ejercicio se puede probar

let mongo;
let db;
let app;
let mailer;
let counter = 0;

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true } });
};

const call = (method, url, { cookie, body, key } = {}) =>
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': `pl-${(counter += 1)}-aaaaaaaa` } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company(name = 'Andina SAS', email = 'ana@andina.co') {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = await login(email);
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '111005', name: 'Bancos', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '152405', name: 'Equipo de oficina', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '210505', name: 'Obligaciones financieras', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await make({ code: '310505', name: 'Capital', type: 'equity', parentCode: '3' });
  await make({ code: '360505', name: 'Utilidad del ejercicio', type: 'equity', parentCode: '3' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  await make({ code: '6', name: 'Costos', type: 'cost', postable: false });
  await make({ code: '613505', name: 'Costo de ventas', type: 'cost', parentCode: '6' });
  return { cookie, base, tenantId: new ObjectId(reg.json().tenantId) };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const entry = async (c, date, lines) => {
  const res = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().journal;
};
const get = (c, path, cookie = c.cookie) => call('GET', `${c.base}${path}`, { cookie });
const put = (c, path, body, cookie = c.cookie) => call('PUT', `${c.base}${path}`, { cookie, body });
const query = (q) => new URLSearchParams(q).toString();

beforeAll(async () => {
  mongo = await startMongo('lulubiz_planning_http_test');
  db = mongo.db;
});

afterAll(async () => {
  await app?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await app?.close();
  await db.dropDatabase();
  await ensureIndexes(db);
  mailer = createMemoryMailer();
  app = await makeApp();
});

describe('clasificación de actividades', () => {
  const map = { investing: ['12', '15', '16'], financing: ['21'] };
  it('patrimonio y obligaciones financieras son financiación; propiedades y equipo, inversión; lo demás, operación', () => {
    expect(categoryOf({ code: '310505', type: 'equity' }, map)).toBe('financing');
    expect(categoryOf({ code: '210505', type: 'liability' }, map)).toBe('financing');
    expect(categoryOf({ code: '152405', type: 'asset' }, map)).toBe('investing');
    expect(categoryOf({ code: '130505', type: 'asset' }, map)).toBe('operating');
    expect(categoryOf({ code: '413505', type: 'income' }, map)).toBe('operating');
    expect(categoryOf({ code: '240805', type: 'liability' }, map)).toBe('operating');
  });
});

describe('flujo de efectivo', () => {
  async function scenario(c) {
    await entry(c, `${Y - 1}-12-15`, [{ accountId: '111005', debit: 1_000_000 }, { accountId: '310505', credit: 1_000_000 }]); // aporte anterior al rango
    await entry(c, `${Y}-03-05`, [{ accountId: '110505', debit: 500_000 }, { accountId: '413505', credit: 500_000 }]);
    await entry(c, `${Y}-03-06`, [{ accountId: '130505', debit: 200_000 }, { accountId: '413505', credit: 200_000 }]); // venta a crédito: no es efectivo
    await entry(c, `${Y}-03-10`, [{ accountId: '111005', debit: 200_000 }, { accountId: '130505', credit: 200_000 }]); // cobro de cartera
    await entry(c, `${Y}-03-12`, [{ accountId: '519595', debit: 100_000 }, { accountId: '111005', credit: 100_000 }]);
    await entry(c, `${Y}-03-15`, [{ accountId: '152405', debit: 400_000 }, { accountId: '111005', credit: 400_000 }]);
    await entry(c, `${Y}-03-18`, [{ accountId: '111005', debit: 300_000 }, { accountId: '210505', credit: 300_000 }]);
    await entry(c, `${Y}-03-20`, [{ accountId: '111005', debit: 50_000 }, { accountId: '110505', credit: 50_000 }]); // traspaso entre cuentas de efectivo
    await entry(c, `${Y}-03-22`, [{ accountId: '111005', debit: 119_000 }, { accountId: '413505', credit: 100_000 }, { accountId: '240805', credit: 19_000 }]); // asiento con varias líneas
    await entry(c, `${Y}-04-02`, [{ accountId: '110505', debit: 9_999 }, { accountId: '413505', credit: 9_999 }]); // fuera del rango
  }
  const report = (c, extra = {}) => get(c, `/reports/cash-flow?${query({ from: `${Y}-03-01`, to: `${Y}-03-31`, currency: 'COP', ...extra })}`);

  it('explica el cambio de efectivo por actividad, y el saldo final es el del libro', async () => {
    const c = await company();
    await scenario(c);
    const res = await report(c);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.accounts.map((a) => a.code)).toEqual(['110505', '111005']);
    expect(r).toMatchObject({ opening: 1_000_000, change: 619_000, closing: 1_619_000 });
    expect(r.sections.operating.rows).toEqual([
      { code: '130505', name: 'Clientes', amount: 200_000 },
      { code: '240805', name: 'IVA por pagar', amount: 19_000 },
      { code: '413505', name: 'Ventas', amount: 600_000 },
      { code: '519595', name: 'Gastos diversos', amount: -100_000 },
    ]);
    expect(r.sections.operating.total).toBe(719_000);
    expect(r.sections.investing).toEqual({ rows: [{ code: '152405', name: 'Equipo de oficina', amount: -400_000 }], total: -400_000 });
    expect(r.sections.financing).toEqual({ rows: [{ code: '210505', name: 'Obligaciones financieras', amount: 300_000 }], total: 300_000 });
    expect(r.sections.operating.total + r.sections.investing.total + r.sections.financing.total).toBe(r.change);
    // El saldo final es el saldo de las cuentas de efectivo en el libro a esa fecha.
    const balances = await db.collection(COLLECTIONS.balances).find({ tenantId: c.tenantId, accountId: { $in: ['110505', '111005'] }, period: { $lte: `${Y}-03` } }).toArray();
    expect(balances.reduce((acc, b) => acc + b.debit - b.credit, 0)).toBe(r.closing);
  });

  it('un rango posterior arranca con el saldo final del anterior', async () => {
    const c = await company();
    await scenario(c);
    const april = (await report(c, { from: `${Y}-04-01`, to: `${Y}-04-30` })).json();
    expect(april).toMatchObject({ opening: 1_619_000, change: 9_999, closing: 1_628_999 });
    expect(april.sections.operating.rows).toEqual([{ code: '413505', name: 'Ventas', amount: 9_999 }]);
  });

  it('se pueden cambiar los prefijos de efectivo y de actividad', async () => {
    const c = await company();
    await scenario(c);
    // Solo bancos: el traspaso con caja pasa a ser una entrada de efectivo de operación.
    const banks = (await report(c, { cash: '1110' })).json();
    expect(banks.accounts.map((a) => a.code)).toEqual(['111005']);
    expect(banks.sections.operating.rows.find((x) => x.code === '110505')).toEqual({ code: '110505', name: 'Caja', amount: 50_000 });
    // El equipo como operación y el préstamo como operación.
    const custom = (await report(c, { investing: '99', financing: '99' })).json();
    expect(custom.sections.investing.rows).toEqual([]);
    expect(custom.sections.financing.rows.map((x) => x.code)).toEqual([]); // el capital no se movió en el rango, pero patrimonio siempre es financiación
    expect(custom.sections.operating.rows.map((x) => x.code)).toEqual(['130505', '152405', '210505', '240805', '413505', '519595']);
  });

  it('sin cuentas de efectivo o sin movimiento devuelve ceros, y valida los parámetros', async () => {
    const c = await company();
    expect((await report(c, { cash: '99' })).json()).toMatchObject({ opening: 0, change: 0, closing: 0, accounts: [] });
    expect((await report(c)).json()).toMatchObject({ opening: 0, change: 0, closing: 0 });
    expect((await report(c, { from: `${Y}-04-01`, to: `${Y}-03-01` })).statusCode).toBe(422);
    expect((await report(c, { from: '2026-02-30' })).statusCode).toBe(422);
    expect((await report(c, { cash: 'abc' })).statusCode).toBe(422);
    expect((await get(c, `/reports/cash-flow?${query({ from: `${Y}-03-01`, to: `${Y}-03-31` })}`)).statusCode).toBe(400);
  });

  it('el cierre de ejercicio no cambia el flujo, y otra empresa no lo ve', async () => {
    const c = await company();
    await scenario(c);
    const before = (await report(c, { from: `${Y}-01-01`, to: `${Y}-12-31` })).json();
    const closed = await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: { year: Y, currency: 'COP', profitAccount: '360505' } });
    expect(closed.statusCode, closed.body).toBe(201);
    expect((await report(c, { from: `${Y}-01-01`, to: `${Y}-12-31` })).json()).toEqual(before);
    const other = await company('Boreal SAS', 'bea@boreal.co');
    expect((await report(other)).json()).toMatchObject({ closing: 0 });
    expect((await report(c)).statusCode).toBe(200);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await get(c, `/reports/cash-flow?${query({ from: `${Y}-03-01`, to: `${Y}-03-31`, currency: 'COP' })}`, viewer)).statusCode).toBe(200);
  });
});

describe('presupuesto', () => {
  const months = (m) => Array.from({ length: 12 }, (_, i) => m[i] ?? 0);
  const save = (c, lines, cookie = c.cookie) => put(c, `/budgets/${Y}`, { lines }, cookie);

  it('guarda líneas, las reemplaza y una línea en ceros equivale a no tener presupuesto', async () => {
    const c = await company();
    const first = await save(c, [{ accountId: '413505', months: months([1_000_000, 1_000_000, 1_200_000]) }, { accountId: '519595', months: months([200_000, 200_000, 200_000]) }]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().lines.map((l) => [l.accountId, l.total, l.costCenter])).toEqual([['413505', 3_200_000, null], ['519595', 600_000, null]]);
    expect(first.json().lines[0]).toMatchObject({ name: 'Ventas', type: 'income' });
    await save(c, [{ accountId: '519595', months: months([250_000]) }]);
    expect((await get(c, `/budgets/${Y}`)).json().lines.find((l) => l.accountId === '519595').total).toBe(250_000);
    await save(c, [{ accountId: '519595', months: months([]) }]);
    expect((await get(c, `/budgets/${Y}`)).json().lines.map((l) => l.accountId)).toEqual(['413505']);
    expect((await get(c, `/budgets/${Y + 5}`)).json().lines).toEqual([]);
  });

  it('rechaza lo que no es un presupuesto válido', async () => {
    const c = await company();
    expect((await post_cc(c, 'NORTE')).statusCode).toBe(201);
    const bad = async (line) => (await save(c, [line])).statusCode;
    expect(await bad({ accountId: '111005', months: months([1]) })).toBe(400); // no es de resultados
    expect(await bad({ accountId: '999999', months: months([1]) })).toBe(400);
    expect(await bad({ accountId: '413505', months: [1, 2, 3] })).toBe(400);
    expect(await bad({ accountId: '413505', months: months([-5]) })).toBe(400);
    expect(await bad({ accountId: '413505', months: months([1.5]) })).toBe(400);
    expect(await bad({ accountId: '413505', costCenter: 'NOPE', months: months([1]) })).toBe(400);
    expect((await save(c, [{ accountId: '413505', months: months([1]) }, { accountId: '413505', months: months([2]) }])).statusCode).toBe(400); // repetida
    expect((await save(c, [])).statusCode).toBe(400);
    expect((await put(c, '/budgets/1999', { lines: [{ accountId: '413505', months: months([1]) }] })).statusCode).toBe(400);
    expect((await get(c, `/budgets/${Y}`)).json().lines).toEqual([]);
  });

  it('compara lo real con lo presupuestado por cuenta y deja los totales', async () => {
    const c = await company();
    await save(c, [
      { accountId: '413505', months: months([1_000_000, 1_000_000, 1_000_000]) },
      { accountId: '519595', months: months([200_000, 200_000, 200_000]) },
      { accountId: '613505', months: months([300_000]) },
    ]);
    await entry(c, `${Y}-01-10`, [{ accountId: '110505', debit: 900_000 }, { accountId: '413505', credit: 900_000 }]);
    await entry(c, `${Y}-02-10`, [{ accountId: '110505', debit: 1_300_000 }, { accountId: '413505', credit: 1_300_000 }]);
    await entry(c, `${Y}-02-11`, [{ accountId: '413505', debit: 100_000 }, { accountId: '110505', credit: 100_000 }]); // devolución: resta del ingreso
    await entry(c, `${Y}-01-15`, [{ accountId: '519595', debit: 250_000 }, { accountId: '110505', credit: 250_000 }]);
    await entry(c, `${Y}-03-15`, [{ accountId: '519595', debit: 999 }, { accountId: '110505', credit: 999 }]); // fuera del rango pedido
    const res = await get(c, `/reports/budget-execution?${query({ from: `${Y}-01`, to: `${Y}-02`, currency: 'COP' })}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.rows).toEqual([
      { code: '413505', name: 'Ventas', type: 'income', budget: 2_000_000, actual: 2_100_000, variance: 100_000, variancePct: 500 },
      { code: '519595', name: 'Gastos diversos', type: 'expense', budget: 400_000, actual: 250_000, variance: -150_000, variancePct: -3750 },
      { code: '613505', name: 'Costo de ventas', type: 'cost', budget: 300_000, actual: 0, variance: -300_000, variancePct: -10_000 },
    ]);
    expect(r.totals.budget).toEqual({ income: 2_000_000, cost: 300_000, expense: 400_000, result: 1_300_000 });
    expect(r.totals.actual).toEqual({ income: 2_100_000, cost: 0, expense: 250_000, result: 1_850_000 });
  });

  it('una cuenta sin presupuesto aparece con porcentaje vacío', async () => {
    const c = await company();
    await entry(c, `${Y}-01-10`, [{ accountId: '519595', debit: 5_000 }, { accountId: '110505', credit: 5_000 }]);
    const r = (await get(c, `/reports/budget-execution?${query({ from: `${Y}-01`, to: `${Y}-12`, currency: 'COP' })}`)).json();
    expect(r.rows).toEqual([{ code: '519595', name: 'Gastos diversos', type: 'expense', budget: 0, actual: 5_000, variance: 5_000, variancePct: null }]);
  });

  it('por centro de costo, ambos lados se limitan a ese centro', async () => {
    const c = await company();
    await post_cc(c, 'NORTE');
    await post_cc(c, 'SUR');
    await save(c, [
      { accountId: '519595', costCenter: 'NORTE', months: months([100_000, 100_000]) },
      { accountId: '519595', costCenter: 'SUR', months: months([500_000, 500_000]) },
    ]);
    await entry(c, `${Y}-01-10`, [{ accountId: '519595', debit: 80_000, costCenter: 'NORTE' }, { accountId: '110505', credit: 80_000 }]);
    await entry(c, `${Y}-01-11`, [{ accountId: '519595', debit: 300_000, costCenter: 'SUR' }, { accountId: '110505', credit: 300_000 }]);
    await entry(c, `${Y}-01-12`, [{ accountId: '519595', debit: 7_000 }, { accountId: '110505', credit: 7_000 }]);
    const north = (await get(c, `/reports/budget-execution?${query({ from: `${Y}-01`, to: `${Y}-02`, currency: 'COP', costCenter: 'norte' })}`)).json();
    expect(north.costCenter).toBe('NORTE');
    expect(north.rows).toEqual([{ code: '519595', name: 'Gastos diversos', type: 'expense', budget: 200_000, actual: 80_000, variance: -120_000, variancePct: -6000 }]);
    const all = (await get(c, `/reports/budget-execution?${query({ from: `${Y}-01`, to: `${Y}-02`, currency: 'COP' })}`)).json();
    expect(all.rows[0]).toMatchObject({ budget: 1_200_000, actual: 387_000 });
  });

  it('el cierre de ejercicio no altera lo real', async () => {
    const c = await company();
    await save(c, [{ accountId: '413505', months: months([500_000]) }]);
    await entry(c, `${Y}-01-10`, [{ accountId: '110505', debit: 700_000 }, { accountId: '413505', credit: 700_000 }]);
    const q = `/reports/budget-execution?${query({ from: `${Y}-01`, to: `${Y}-12`, currency: 'COP' })}`;
    const before = (await get(c, q)).json();
    expect((await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: { year: Y, currency: 'COP', profitAccount: '360505' } })).statusCode).toBe(201);
    expect((await get(c, q)).json()).toEqual(before);
    expect(before.rows[0]).toMatchObject({ actual: 700_000, budget: 500_000 });
  });

  it('valida el rango, exige permiso para guardar y no cruza empresas', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await save(a, [{ accountId: '413505', months: months([1]) }]);
    const exec = (c, q) => get(c, `/reports/budget-execution?${query({ currency: 'COP', ...q })}`);
    expect((await exec(a, { from: `${Y}-03`, to: `${Y}-02` })).statusCode).toBe(422);
    expect((await exec(a, { from: `${Y}-11`, to: `${Y + 1}-02` })).statusCode).toBe(422);
    expect((await exec(a, { from: `${Y}-13`, to: `${Y}-14` })).statusCode).toBe(400);
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(a, 'contador@andina.co', 'accountant');
    expect((await get(a, `/budgets/${Y}`, viewer)).statusCode).toBe(200);
    expect((await save(a, [{ accountId: '413505', months: months([2]) }], viewer)).statusCode).toBe(403);
    expect((await save(a, [{ accountId: '413505', months: months([3]) }], accountant)).statusCode).toBe(200);
    expect((await get(b, `/budgets/${Y}`)).json().lines).toEqual([]);
    expect((await get(a, `/budgets/${Y}`, b.cookie)).statusCode).toBe(403);
  });
});

async function post_cc(c, code) {
  return call('POST', `${c.base}/cost-centers`, { cookie: c.cookie, body: { code, name: `Centro ${code}` } });
}
