import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const cop = (pesos) => pesos * 100;

/** `AAAA-MM` de hace `back` meses. */
const ym = (back = 0) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - back, 1);
  return d.toISOString().slice(0, 7);
};
const PERIOD = ym(1);
const YEARS = [...new Set([ym(0).slice(0, 4), PERIOD.slice(0, 4)])];

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
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `pay-${(counter += 1)}-aaaaaaaa` : key } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

const CHART = [
  ['1', 'Activo', 'asset', null],
  ['111005', 'Bancos', 'asset', '1'],
  ['2', 'Pasivo', 'liability', null],
  ['250505', 'Salarios por pagar', 'liability', '2'],
  ['236505', 'Retención en la fuente por salarios', 'liability', '2'],
  ['237005', 'Aportes a EPS', 'liability', '2'],
  ['237006', 'Aportes a ARL', 'liability', '2'],
  ['238030', 'Fondos de pensiones', 'liability', '2'],
  ['237010', 'Aportes a cajas de compensación', 'liability', '2'],
  ['237015', 'Aportes al SENA', 'liability', '2'],
  ['237020', 'Aportes al ICBF', 'liability', '2'],
  ['237095', 'Otras deducciones de nómina', 'liability', '2'],
  ['261005', 'Cesantías consolidadas', 'liability', '2'],
  ['261010', 'Intereses sobre cesantías', 'liability', '2'],
  ['261015', 'Vacaciones consolidadas', 'liability', '2'],
  ['261020', 'Prima de servicios', 'liability', '2'],
  ['5', 'Gastos', 'expense', null],
  ['510506', 'Sueldos', 'expense', '5'],
  ['510527', 'Auxilio de transporte', 'expense', '5'],
  ['510530', 'Cesantías', 'expense', '5'],
  ['510533', 'Intereses sobre cesantías', 'expense', '5'],
  ['510536', 'Prima de servicios', 'expense', '5'],
  ['510539', 'Vacaciones', 'expense', '5'],
  ['510548', 'Bonificaciones', 'expense', '5'],
  ['510568', 'Aportes a ARL', 'expense', '5'],
  ['510569', 'Aportes a EPS', 'expense', '5'],
  ['510570', 'Aportes a fondos de pensiones', 'expense', '5'],
  ['510572', 'Aportes a cajas de compensación', 'expense', '5'],
  ['510575', 'Aportes al ICBF', 'expense', '5'],
  ['510578', 'Aportes al SENA', 'expense', '5'],
];
const ACCOUNTS = {
  salaryExpense: '510506', nonSalaryExpense: '510548', transportExpense: '510527', employerHealthExpense: '510569', employerPensionExpense: '510570', arlExpense: '510568', cajaExpense: '510572', senaExpense: '510578', icbfExpense: '510575', cesantiasExpense: '510530', cesantiasInterestExpense: '510533', primaExpense: '510536', vacationsExpense: '510539',
  payrollPayable: '250505', healthPayable: '237005', pensionPayable: '238030', arlPayable: '237006', cajaPayable: '237010', senaPayable: '237015', icbfPayable: '237020', withholdingPayable: '236505', deductionsPayable: '237095', cesantiasPayable: '261005', cesantiasInterestPayable: '261010', primaPayable: '261020', vacationsPayable: '261015',
};
const PARAMS = { smmlv: cop(1_423_500), transportAid: cop(200_000), uvt: cop(49_799) };

async function company(name = 'Andina SAS', email = 'ana@andina.co', { configure = true } = {}) {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = await login(email);
  const base = `/v1/tenants/${reg.json().tenantId}`;
  for (const [code, accountName, type, parentCode] of CHART) {
    await call('POST', `${base}/accounts`, { cookie, body: { code, name: accountName, type, ...(parentCode ? { parentCode } : { postable: false }) } });
  }
  const c = { cookie, base, tenantId: new ObjectId(reg.json().tenantId) };
  if (configure) {
    expect((await put(c, '/payroll/config/accounts', { accounts: ACCOUNTS })).statusCode).toBe(200);
    for (const year of YEARS) expect((await put(c, `/payroll/config/years/${year}`, { params: PARAMS })).statusCode).toBe(200);
  }
  return c;
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const get = (c, path, cookie = c.cookie) => call('GET', `${c.base}${path}`, { cookie });
const post = (c, path, body, cookie = c.cookie) => call('POST', `${c.base}${path}`, { cookie, body });
const put = (c, path, body, cookie = c.cookie) => call('PUT', `${c.base}${path}`, { cookie, body });
const employeeBody = (patch = {}) => ({ documentType: 'CC', documentNumber: '1075000001', name: 'Ana Pérez', hireDate: '2024-01-15', baseSalary: cop(2_000_000), ...patch });
const hire = async (c, patch) => {
  const res = await post(c, '/payroll/employees', employeeBody(patch));
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const runPayroll = (c, extra = {}, key = true) => call('POST', `${c.base}/payroll/runs`, { cookie: c.cookie, key, body: { period: PERIOD, ...extra } });
const net = async (c, account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: c.tenantId, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};

beforeAll(async () => {
  mongo = await startMongo('lulubiz_payroll_http_test');
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

describe('configuración', () => {
  it('guarda las cuentas con el tipo correcto y los parámetros del año', async () => {
    const c = await company('Andina SAS', 'ana@andina.co', { configure: false });
    expect((await get(c, '/payroll/config')).json()).toMatchObject({ accounts: {}, years: {} });
    const bad = async (accounts) => (await put(c, '/payroll/config/accounts', { accounts })).statusCode;
    expect(await bad({ salaryExpense: '250505' })).toBe(400); // un pasivo no es gasto
    expect(await bad({ payrollPayable: '510506' })).toBe(400); // un gasto no es pasivo
    expect(await bad({ salaryExpense: '999999' })).toBe(400);
    expect(await bad({ salaryExpense: '5' })).toBe(400); // cuenta de agrupación
    expect(await bad({ inventada: '510506' })).toBe(400);
    expect(await bad({})).toBe(400);
    expect((await put(c, '/payroll/config/accounts', { accounts: { salaryExpense: '510506' } })).statusCode).toBe(200);
    expect((await put(c, '/payroll/config/accounts', { accounts: { payrollPayable: '250505' } })).json().accounts).toEqual({ salaryExpense: '510506', payrollPayable: '250505' });
    const saved = await put(c, '/payroll/config/years/2026', { params: { ...PARAMS, exonerated: false, rates: { caja: 450 } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().years['2026']).toMatchObject({ smmlv: PARAMS.smmlv, exonerated: false, rates: { caja: 450 } });
    expect((await put(c, '/payroll/config/years/2026', { params: { smmlv: 0, transportAid: 1, uvt: 1 } })).statusCode).toBe(400);
    expect((await put(c, '/payroll/config/years/2026', { params: { smmlv: 1, transportAid: 1 } })).statusCode).toBe(400);
    expect((await put(c, '/payroll/config/years/26', { params: PARAMS })).statusCode).toBe(400);
    expect((await put(c, '/payroll/config/years/2026', { params: { ...PARAMS, rates: { caja: 20_000 } } })).statusCode).toBe(400);
  });

  it('la nómina maneja salarios: el lector y el cajero ni la ven; el contador sí', async () => {
    const c = await company();
    await hire(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    for (const path of ['/payroll/config', '/payroll/employees', '/payroll/runs']) {
      expect((await get(c, path, viewer)).statusCode, path).toBe(403);
      expect((await get(c, path, cashier)).statusCode, path).toBe(403);
      expect((await get(c, path, accountant)).statusCode, path).toBe(200);
    }
    expect((await post(c, '/payroll/employees', employeeBody({ documentNumber: '9' }), viewer)).statusCode).toBe(403);
    expect((await post(c, '/payroll/employees', employeeBody({ documentNumber: '9' }), accountant)).statusCode).toBe(201);
    expect((await get(c, '/payroll/config', (await joinAs(c, 'otro@boreal.co', 'viewer')))).statusCode).toBe(403);
  });
});

describe('empleados', () => {
  it('se crean, no repiten documento y se actualizan sin tocar lo liquidado', async () => {
    const c = await company();
    const e = await hire(c, { costCenter: undefined, position: 'Contadora', arlRiskLevel: 2 });
    expect(e).toMatchObject({ name: 'Ana Pérez', baseSalary: cop(2_000_000), active: true, transportAid: true, arlRiskLevel: 2, salaryType: 'ordinary', contractType: 'indefinite', position: 'Contadora' });
    expect((await post(c, '/payroll/employees', employeeBody())).statusCode).toBe(409);
    const updated = await call('PATCH', `${c.base}/payroll/employees/${e._id}`, { cookie: c.cookie, body: { baseSalary: cop(2_500_000), position: '', salaryType: 'ordinary' } });
    expect(updated.json()).toMatchObject({ baseSalary: cop(2_500_000) });
    expect(updated.json().position).toBeUndefined();
    expect((await call('PATCH', `${c.base}/payroll/employees/${e._id}`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);
    expect((await get(c, `/payroll/employees/${new ObjectId()}`)).statusCode).toBe(404);
    await call('PATCH', `${c.base}/payroll/employees/${e._id}`, { cookie: c.cookie, body: { active: false } });
    expect((await get(c, '/payroll/employees?active=true')).json().items).toEqual([]);
    expect((await get(c, '/payroll/employees?active=false')).json().items).toHaveLength(1);
  });

  it('rechaza datos inválidos', async () => {
    const c = await company();
    const bad = async (patch) => (await post(c, '/payroll/employees', employeeBody({ documentNumber: String(Math.random()).slice(2, 10), ...patch }))).statusCode;
    expect(await bad({ baseSalary: 0 })).toBe(400);
    expect(await bad({ baseSalary: 1.5 })).toBe(400);
    expect(await bad({ hireDate: '2026-02-30' })).toBe(400);
    expect(await bad({ endDate: '2020-01-01' })).toBe(400); // antes del ingreso
    expect(await bad({ documentType: 'NIT' })).toBe(400);
    expect(await bad({ arlRiskLevel: 9 })).toBe(400);
    expect(await bad({ costCenter: 'NOPE' })).toBe(400);
    expect(await bad({ name: '' })).toBe(400);
  });

  it('otra empresa no ve a los empleados', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const e = await hire(a);
    expect((await get(b, `/payroll/employees/${e._id}`)).statusCode).toBe(404);
    expect((await get(b, '/payroll/employees')).json().items).toEqual([]);
    expect((await hire(b)).documentNumber).toBe('1075000001'); // el mismo documento en otra empresa
  });
});

describe('vista previa', () => {
  it('pide los parámetros del año y calcula sin guardar nada', async () => {
    const c = await company('Andina SAS', 'ana@andina.co', { configure: false });
    await hire(c);
    const missing = await post(c, '/payroll/preview', { period: PERIOD });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toBe('SETTINGS_INCOMPLETE');
    for (const year of YEARS) await put(c, `/payroll/config/years/${year}`, { params: PARAMS });
    const preview = await post(c, '/payroll/preview', { period: PERIOD });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().totals).toMatchObject({ employees: 1, gross: cop(2_200_000), net: cop(2_040_000) });
    expect(preview.json().items[0]).toMatchObject({ name: 'Ana Pérez', days: 30, transportAid: cop(200_000) });
    expect(await db.collection(COLLECTIONS.payrollRuns).countDocuments({ tenantId: c.tenantId })).toBe(0);
  });

  it('suma novedades, deja fuera a quien aún no ingresaba y señala a quien tiene un problema', async () => {
    const c = await company();
    const a = await hire(c);
    const b = await hire(c, { documentNumber: '2', name: 'Bruno Díaz' });
    await hire(c, { documentNumber: '3', name: 'Futuro', hireDate: `${ym(0)}-28` });
    const preview = await post(c, '/payroll/preview', {
      period: PERIOD,
      novelties: [{ employeeId: a._id, salaryExtras: cop(300_000), nonSalaryExtras: cop(100_000), otherDeductions: cop(50_000), withholding: 0 }, { employeeId: b._id, otherDeductions: cop(9_000_000) }],
    });
    const r = preview.json();
    expect(r.items.map((i) => i.name)).toEqual(['Ana Pérez', 'Bruno Díaz'].filter((n) => n === 'Ana Pérez'));
    expect(r.problems).toEqual([expect.objectContaining({ name: 'Bruno Díaz', message: expect.stringMatching(/superan/) })]);
    expect(r.items[0]).toMatchObject({ gross: cop(2_600_000), ibc: cop(2_300_000) });
    expect((await post(c, '/payroll/preview', { period: PERIOD, novelties: [{ employeeId: String(new ObjectId()) }] })).statusCode).toBe(400);
    expect((await post(c, '/payroll/preview', { period: PERIOD, novelties: [{ employeeId: a._id }, { employeeId: a._id }] })).statusCode).toBe(400);
    expect((await post(c, '/payroll/preview', { period: '2026-13' })).statusCode).toBe(400);
  });
});

describe('liquidar la nómina', () => {
  async function twoEmployees(c) {
    await hire(c);
    await hire(c, { documentNumber: '2', name: 'Bruno Díaz', baseSalary: cop(12_000_000) });
  }

  it('asienta un solo comprobante NM que cuadra, con el neto por pagar y cada obligación', async () => {
    const c = await company();
    await twoEmployees(c);
    const res = await runPayroll(c);
    expect(res.statusCode, res.body).toBe(201);
    const { run } = res.json();
    expect(run).toMatchObject({ period: PERIOD, status: 'posted', totals: { employees: 2, net: cop(2_040_000) + cop(10_220_000) } });
    expect(run.document).toMatch(/^NM\d+$/);
    const journal = (await get(c, `/journals/${run.journalId}`)).json();
    expect(journal).toMatchObject({ docType: 'NM' });
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(await net(c, '250505')).toBe(-(cop(2_040_000) + cop(10_220_000)));
    expect(await net(c, '236505')).toBe(-cop(700_000)); // retención del segundo
    expect(await net(c, '237005')).toBe(-(cop(80_000) + cop(480_000))); // salud de los empleados (los patronales están exonerados)
    expect(await net(c, '238030')).toBe(-(cop(80_000) + cop(480_000) + cop(120_000) + cop(240_000) + cop(1_440_000)));
    expect(await net(c, '510506')).toBe(cop(14_000_000));
    expect(await net(c, '510527')).toBe(cop(200_000));
    // Provisiones: cesantías, intereses, prima y vacaciones.
    expect(await net(c, '261005')).toBe(-(cop(183_260) + cop(999_600)));
    expect(await net(c, '261015')).toBe(-(cop(83_400) + cop(500_400)));
    // Con la nómina ya liquidada, el balance de las cuentas de nómina cuadra con el total de lo asentado.
    expect(run.totals.employerTotal + run.totals.gross + run.totals.provisionsTotal).toBe(journal.totalDebit);
  });

  it('el gasto lleva el centro de costo del empleado', async () => {
    const c = await company();
    expect((await post(c, '/cost-centers', { code: 'VENTAS', name: 'Ventas' })).statusCode).toBe(201);
    await hire(c, { costCenter: 'ventas' });
    await hire(c, { documentNumber: '2', name: 'Bruno Díaz' });
    const { run } = (await runPayroll(c)).json();
    const journal = (await get(c, `/journals/${run.journalId}`)).json();
    const salaries = journal.lines.filter((l) => l.accountId === '510506');
    expect(salaries.map((l) => [l.costCenter ?? null, l.debit]).sort()).toEqual([[null, cop(2_000_000)], ['VENTAS', cop(2_000_000)]].sort());
  });

  it('una corrida por mes; repetir la clave devuelve la misma; no se liquida el futuro ni sin cuentas', async () => {
    const c = await company();
    await hire(c);
    const key = 'payroll-fixed-key-1';
    const first = await runPayroll(c, {}, key);
    expect(first.statusCode).toBe(201);
    const again = await runPayroll(c, {}, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().run._id).toBe(first.json().run._id);
    expect((await runPayroll(c)).statusCode).toBe(409); // otra clave, el mismo mes
    expect((await runPayroll(c, { period: ym(-1) })).statusCode).toBe(400); // futuro
    expect(await db.collection(COLLECTIONS.payrollRuns).countDocuments({ tenantId: c.tenantId })).toBe(1);
    const bare = await company('Boreal SAS', 'bea@boreal.co', { configure: false });
    await hire(bare);
    await put(bare, `/payroll/config/years/${PERIOD.slice(0, 4)}`, { params: PARAMS });
    const noAccounts = await runPayroll(bare);
    expect(noAccounts.statusCode).toBe(409);
    expect(noAccounts.json().message).toMatch(/faltan las cuentas/);
  });

  it('dos liquidaciones a la vez del mismo mes dejan una sola', async () => {
    const c = await company();
    await hire(c);
    const results = await Promise.all([runPayroll(c), runPayroll(c), runPayroll(c)]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    expect(await net(c, '250505')).toBe(-cop(2_040_000));
  });

  it('no deja liquidar con un empleado con problemas ni sin empleados', async () => {
    const c = await company();
    expect((await runPayroll(c)).statusCode).toBe(400);
    const a = await hire(c);
    const bad = await runPayroll(c, { novelties: [{ employeeId: a._id, otherDeductions: cop(9_000_000) }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/superan/);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: c.tenantId, docType: 'NM' })).toBe(0);
  });

  it('cambiar el salario después no reescribe lo liquidado', async () => {
    const c = await company();
    const e = await hire(c);
    const { run } = (await runPayroll(c)).json();
    await call('PATCH', `${c.base}/payroll/employees/${e._id}`, { cookie: c.cookie, body: { baseSalary: cop(9_000_000) } });
    const stored = (await get(c, `/payroll/runs/${run._id}`)).json();
    expect(stored.items[0]).toMatchObject({ baseSalary: cop(2_000_000), net: cop(2_040_000) });
    expect((await get(c, '/payroll/runs')).json().items[0].items).toBeUndefined();
  });
});

describe('pagos y anulación', () => {
  it('paga el neto y luego los aportes, cada uno una sola vez, y deja las obligaciones en cero', async () => {
    const c = await company();
    await hire(c);
    const { run } = (await runPayroll(c)).json();
    const date = `${ym(0)}-05`;
    const paid = await post(c, `/payroll/runs/${run._id}/pay`, { date, account: '111005' });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().run.payment).toMatchObject({ total: cop(2_040_000), account: '111005' });
    expect(paid.json().run.payment.document).toMatch(/^PN\d+$/);
    expect(await net(c, '250505')).toBe(0);
    expect((await post(c, `/payroll/runs/${run._id}/pay`, { date, account: '111005' })).statusCode).toBe(409);

    const contrib = await post(c, `/payroll/runs/${run._id}/pay-contributions`, { date, account: '111005' });
    expect(contrib.statusCode, contrib.body).toBe(200);
    // Salud 80.000; pensión 80.000 + 240.000; ARL 10.440; caja 80.000 (SENA e ICBF exonerados).
    expect(contrib.json().run.contributionsPayment.total).toBe(cop(80_000) + cop(320_000) + cop(10_440) + cop(80_000));
    for (const account of ['237005', '238030', '237006', '237010']) expect(await net(c, account), account).toBe(0);
    expect(await net(c, '111005')).toBe(-(cop(2_040_000) + cop(490_440)));
    expect((await post(c, `/payroll/runs/${run._id}/pay-contributions`, { date, account: '111005' })).statusCode).toBe(409);
  });

  it('valida el pago: fecha, cuenta de efectivo y corrida existente', async () => {
    const c = await company();
    await hire(c);
    const { run } = (await runPayroll(c)).json();
    const pay = (body) => post(c, `/payroll/runs/${run._id}/pay`, body);
    expect((await pay({ date: '2099-01-01', account: '111005' })).statusCode).toBe(400);
    expect((await pay({ date: `${ym(0)}-05`, account: '250505' })).statusCode).toBe(400); // un pasivo no es caja
    expect((await pay({ date: `${ym(0)}-05`, account: '999999' })).statusCode).toBe(400);
    expect((await post(c, `/payroll/runs/${new ObjectId()}/pay`, { date: `${ym(0)}-05`, account: '111005' })).statusCode).toBe(404);
    expect((await get(c, `/payroll/runs/${run._id}`)).json().payment).toBeUndefined();
  });

  it('se anula mientras no tenga pagos; con pagos no, y se puede liquidar de nuevo', async () => {
    const c = await company();
    await hire(c);
    const { run } = (await runPayroll(c)).json();
    const voided = await post(c, `/payroll/runs/${run._id}/void`);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().run.status).toBe('void');
    expect(await net(c, '250505')).toBe(0);
    expect(await net(c, '510506')).toBe(0);
    expect((await post(c, `/payroll/runs/${run._id}/void`)).json().replayed).toBe(true);
    expect((await post(c, `/payroll/runs/${run._id}/pay`, { date: `${ym(0)}-05`, account: '111005' })).statusCode).toBe(409); // anulada

    const second = (await runPayroll(c)).json().run;
    await post(c, `/payroll/runs/${second._id}/pay`, { date: `${ym(0)}-05`, account: '111005' });
    expect((await post(c, `/payroll/runs/${second._id}/void`)).statusCode).toBe(409);
    expect(await net(c, '250505')).toBe(0);
  });

  it('el contador liquida y paga; el administrador no hace falta para ello; el lector no entra', async () => {
    const c = await company();
    await hire(c);
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const key = 'payroll-accountant-key';
    const run = await call('POST', `${c.base}/payroll/runs`, { cookie: accountant, key, body: { period: PERIOD } });
    expect(run.statusCode, run.body).toBe(201);
    expect((await post(c, `/payroll/runs/${run.json().run._id}/pay`, { date: `${ym(0)}-05`, account: '111005' }, viewer)).statusCode).toBe(403);
    expect((await post(c, `/payroll/runs/${run.json().run._id}/pay`, { date: `${ym(0)}-05`, account: '111005' }, accountant)).statusCode).toBe(200);
    const audit = await db.collection(COLLECTIONS.audit).find({ tenantId: c.tenantId, action: /^payroll\./ }).toArray();
    expect(audit.map((e) => e.action).sort()).toEqual(expect.arrayContaining(['payroll.accounts', 'payroll.params', 'payroll.pay', 'payroll.run']));
  });
});

describe('prestaciones sociales', () => {
  const PY = String(Number(ym(0).slice(0, 4)) - 1);
  const run = (c, period) => call('POST', `${c.base}/payroll/runs`, { cookie: c.cookie, key: true, body: { period } });
  const benefit = (c, kind, label, cookie = c.cookie) => call('POST', `${c.base}/payroll/benefits`, { cookie, body: { kind, label } });
  const preview = (c, kind, label) => call('POST', `${c.base}/payroll/benefits/preview`, { cookie: c.cookie, body: { kind, label } });

  async function threeMonths(c) {
    expect((await put(c, `/payroll/config/years/${PY}`, { params: PARAMS })).statusCode).toBe(200);
    await hire(c); // Ana: 2.000.000 con auxilio de transporte, base mensual 2.200.000
    for (const m of ['01', '02', '03']) expect((await run(c, `${PY}-${m}`)).statusCode).toBe(201);
  }

  it('la prima del semestre se calcula con las nóminas y se compara con lo provisionado', async () => {
    const c = await company();
    await threeMonths(c);
    const p = (await preview(c, 'prima', `${PY}-1`)).json();
    expect(p).toMatchObject({ kind: 'prima', from: `${PY}-01`, to: `${PY}-06`, monthsCovered: 3, monthsInWindow: 6 });
    expect(p.items).toEqual([expect.objectContaining({ name: 'Ana Pérez', months: 3, days: 90, base: cop(6_600_000), amount: cop(550_000), accrued: cop(549_780), adjustment: cop(220) })]);
    expect(p.totals).toMatchObject({ amount: cop(550_000), accrued: cop(549_780), adjustment: cop(220), employees: 1 });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: c.tenantId, docType: 'PR' })).toBe(0); // la vista previa no asienta
  });

  it('liquidarla cancela lo provisionado, lleva la diferencia al gasto y deja lo debido por pagar', async () => {
    const c = await company();
    await threeMonths(c);
    expect(await net(c, '261020')).toBe(-cop(549_780));
    const res = await benefit(c, 'prima', `${PY}-1`);
    expect(res.statusCode, res.body).toBe(201);
    const { benefit: b } = res.json();
    expect(b).toMatchObject({ kind: 'prima', label: `${PY}-1`, status: 'posted', total: cop(550_000) });
    const journal = (await get(c, `/journals/${b.journalId}`)).json();
    expect(journal.lines).toEqual([
      expect.objectContaining({ accountId: '261020', debit: cop(549_780) }),
      expect.objectContaining({ accountId: '510536', debit: cop(220) }),
      expect.objectContaining({ accountId: '250505', credit: cop(550_000) }),
    ]);
    expect(await net(c, '261020')).toBe(0);
    expect(await net(c, '250505')).toBe(-(3 * cop(2_040_000) + cop(550_000)));
    // Una sola liquidación por período.
    expect((await benefit(c, 'prima', `${PY}-1`)).statusCode).toBe(409);
    // La nómina que entró en la liquidación ya no se anula.
    const firstRun = (await get(c, '/payroll/runs')).json().items.find((r) => r.period === `${PY}-02`);
    expect((await post(c, `/payroll/runs/${firstRun._id}/void`)).statusCode).toBe(409);
  });

  it('se paga una sola vez desde caja o bancos', async () => {
    const c = await company();
    await threeMonths(c);
    const b = (await benefit(c, 'prima', `${PY}-1`)).json().benefit;
    const pay = (body) => post(c, `/payroll/benefits/${b._id}/pay`, body);
    expect((await pay({ date: '2099-01-01', account: '111005' })).statusCode).toBe(400);
    expect((await pay({ date: `${ym(0)}-05`, account: '250505' })).statusCode).toBe(400);
    const paid = await pay({ date: `${ym(0)}-05`, account: '111005' });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().benefit.payment).toMatchObject({ total: cop(550_000), account: '111005' });
    expect(await net(c, '111005')).toBe(-cop(550_000));
    expect((await pay({ date: `${ym(0)}-05`, account: '111005' })).statusCode).toBe(409);
    expect((await get(c, '/payroll/benefits')).json().items[0].items).toBeUndefined();
    expect((await get(c, `/payroll/benefits/${b._id}`)).json().items).toHaveLength(1);
  });

  it('las cesantías del año traen sus intereses sobre los días trabajados', async () => {
    const c = await company();
    await threeMonths(c);
    const p = (await preview(c, 'cesantias', PY)).json();
    expect(p).toMatchObject({ from: `${PY}-01`, to: `${PY}-12`, monthsCovered: 3, monthsInWindow: 12 });
    // Cesantías 550.000; intereses = 550.000 × 12 % × 90 / 360 = 16.500; lo provisionado fue 3 × 22.000.
    expect(p.items[0]).toMatchObject({ amount: cop(550_000), accrued: cop(549_780), adjustment: cop(220), interest: cop(16_500), accruedInterest: cop(66_000), interestAdjustment: cop(16_500) - cop(66_000) });
    const b = (await benefit(c, 'cesantias', PY)).json().benefit;
    expect(b.total).toBe(cop(550_000) + cop(16_500));
    const journal = (await get(c, `/journals/${b.journalId}`)).json();
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: '261005', debit: cop(549_780) }),
        expect.objectContaining({ accountId: '510530', debit: cop(220) }),
        expect.objectContaining({ accountId: '261010', debit: cop(66_000) }),
        expect.objectContaining({ accountId: '510533', credit: cop(49_500) }), // se provisionó de más: el gasto se reversa
        expect.objectContaining({ accountId: '250505', credit: cop(566_500) }),
      ]),
    );
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(await net(c, '261005')).toBe(0);
    expect(await net(c, '261010')).toBe(0);
  });

  it('valida el período y exige que haya nóminas; el lector no entra', async () => {
    const c = await company();
    await hire(c);
    expect((await benefit(c, 'prima', `${PY}-3`)).statusCode).toBe(400);
    expect((await benefit(c, 'cesantias', `${PY}-1`)).statusCode).toBe(400);
    expect((await benefit(c, 'vacaciones', PY)).statusCode).toBe(400);
    const empty = await benefit(c, 'prima', `${PY}-1`);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toMatch(/no hay nóminas/);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await benefit(c, 'prima', `${PY}-1`, viewer)).statusCode).toBe(403);
    expect((await get(c, '/payroll/benefits', viewer)).statusCode).toBe(403);
  });

  it('dos liquidaciones a la vez dejan una sola', async () => {
    const c = await company();
    await threeMonths(c);
    const results = await Promise.all([benefit(c, 'prima', `${PY}-1`), benefit(c, 'prima', `${PY}-1`), benefit(c, 'prima', `${PY}-1`)]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    expect(await net(c, '261020')).toBe(0);
  });
});

describe('reportes de nómina', () => {
  const PY = String(Number(ym(0).slice(0, 4)) - 1);
  const run = (c, period) => call('POST', `${c.base}/payroll/runs`, { cookie: c.cookie, key: true, body: { period } });

  async function scenario(c) {
    expect((await put(c, `/payroll/config/years/${PY}`, { params: PARAMS })).statusCode).toBe(200);
    const a = await hire(c);
    const b = await hire(c, { documentNumber: '2', name: 'Bruno Díaz', baseSalary: cop(12_000_000) });
    const runs = [];
    for (const m of ['01', '02']) runs.push((await run(c, `${PY}-${m}`)).json().run);
    return { a, b, runs };
  }

  it('aportes por mes y por empleado, con totales por mes y generales', async () => {
    const c = await company();
    await scenario(c);
    const res = await get(c, `/payroll/reports/contributions?from=${PY}-01&to=${PY}-12`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.rows).toHaveLength(4);
    const ana = r.rows.find((x) => x.name === 'Ana Pérez' && x.period === `${PY}-01`);
    expect(ana).toMatchObject({ days: 30, ibc: cop(2_000_000), employeeHealth: cop(80_000), employerHealth: 0, employeePension: cop(80_000), employerPension: cop(240_000), arl: cop(10_440), caja: cop(80_000), sena: 0, icbf: 0 });
    expect(r.months.map((m) => [m.period, m.employees])).toEqual([[`${PY}-01`, 2], [`${PY}-02`, 2]]);
    // Un mes: salud 80.000 + 480.000; pensión 80.000+240.000 + 480.000+120.000+1.440.000.
    expect(r.months[0]).toMatchObject({ ibc: cop(14_000_000), health: cop(560_000), pension: cop(2_360_000), arl: cop(10_440) + cop(62_640), caja: cop(80_000) + cop(480_000) });
    expect(r.totals.ibc).toBe(cop(28_000_000));
    expect((await get(c, `/payroll/reports/contributions?from=${PY}-03&to=${PY}-01`)).statusCode).toBe(400);
    expect((await get(c, `/payroll/reports/contributions?from=${PY}-01&to=${Number(PY) + 5}-01`)).statusCode).toBe(400);
    expect((await get(c, `/payroll/reports/contributions?from=2026-13&to=2026-14`)).statusCode).toBe(400);
  });

  it('las provisiones cuadran con el libro, antes y después de liquidar la prima', async () => {
    const c = await company();
    await scenario(c);
    const before = (await get(c, '/payroll/reports/provisions')).json();
    expect(before.ok).toBe(true);
    const prima = before.lines.find((l) => l.key === 'prima');
    expect(prima).toMatchObject({ account: '261020', provisioned: cop(183_260 + 999_600) * 2, settled: 0, outstanding: cop(183_260 + 999_600) * 2, ledger: cop(183_260 + 999_600) * 2, difference: 0 });
    expect(before.employees.map((e) => e.name)).toEqual(['Ana Pérez', 'Bruno Díaz']);
    expect((await call('POST', `${c.base}/payroll/benefits`, { cookie: c.cookie, body: { kind: 'prima', label: `${PY}-1` } })).statusCode).toBe(201);
    const after = (await get(c, '/payroll/reports/provisions')).json();
    expect(after.ok).toBe(true);
    expect(after.lines.find((l) => l.key === 'prima')).toMatchObject({ settled: prima.provisioned, outstanding: 0, ledger: 0 });
    expect(after.lines.find((l) => l.key === 'vacations').outstanding).toBeGreaterThan(0);
    // Un asiento manual sobre la cuenta se ve como diferencia.
    await app.inject({ method: 'POST', url: `${c.base}/journals`, headers: { cookie: c.cookie, 'idempotency-key': 'prov-manual-aaaaaaaa' }, payload: { docType: 'AJ', date: `${PY}-03-01T12:00:00Z`, currency: 'COP', lines: [{ accountId: '510539', debit: 100 }, { accountId: '261015', credit: 100 }] } });
    const off = (await get(c, '/payroll/reports/provisions')).json();
    expect(off.ok).toBe(false);
    expect(off.lines.find((l) => l.key === 'vacations').difference).toBe(100);
  });

  it('el desprendible trae devengado, deducciones y neto de un empleado', async () => {
    const c = await company();
    const { a, runs } = await scenario(c);
    const res = await get(c, `/payroll/runs/${runs[0]._id}/payslips/${a._id}`);
    expect(res.statusCode, res.body).toBe(200);
    const slip = res.json();
    expect(slip).toMatchObject({ company: 'Andina SAS', period: `${PY}-01`, gross: cop(2_200_000), totalDeductions: cop(160_000), net: cop(2_040_000), employee: { name: 'Ana Pérez', documentNumber: '1075000001' } });
    expect(slip.earnings).toEqual([{ label: 'Salario', amount: cop(2_000_000) }, { label: 'Auxilio de transporte', amount: cop(200_000) }]);
    expect(slip.deductions).toEqual([{ label: 'Salud', amount: cop(80_000) }, { label: 'Pensión', amount: cop(80_000) }]);
    expect((await get(c, `/payroll/runs/${runs[0]._id}/payslips/${new ObjectId()}`)).statusCode).toBe(404);
    expect((await get(c, `/payroll/runs/${new ObjectId()}/payslips/${a._id}`)).statusCode).toBe(404);
  });

  it('el lector no ve los reportes y otra empresa no ve los de esta', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const { a: ana, runs } = await scenario(a);
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    expect((await get(a, `/payroll/reports/contributions?from=${PY}-01&to=${PY}-02`, viewer)).statusCode).toBe(403);
    expect((await get(a, '/payroll/reports/provisions', viewer)).statusCode).toBe(403);
    expect((await get(a, `/payroll/runs/${runs[0]._id}/payslips/${ana._id}`, viewer)).statusCode).toBe(403);
    expect((await get(b, `/payroll/runs/${runs[0]._id}/payslips/${ana._id}`)).statusCode).toBe(404);
    expect((await get(b, `/payroll/reports/contributions?from=${PY}-01&to=${PY}-02`)).json().rows).toEqual([]);
  });
});

describe('liquidación de contrato', () => {
  const PY = String(Number(ym(0).slice(0, 4)) - 1);
  const END = `${PY}-03-31`;
  const run = (c, period) => call('POST', `${c.base}/payroll/runs`, { cookie: c.cookie, key: true, body: { period } });
  const terminate = (c, extra = {}, path = '/payroll/terminations', cookie = c.cookie) => call('POST', `${c.base}${path}`, { cookie, body: { endDate: END, ...extra } });

  async function setup(c) {
    expect((await put(c, `/payroll/config/years/${PY}`, { params: PARAMS })).statusCode).toBe(200);
    const ana = await hire(c);
    for (const m of ['01', '02', '03']) expect((await run(c, `${PY}-${m}`)).statusCode).toBe(201);
    return ana;
  }

  it('calcula prima, cesantías, intereses y vacaciones contra lo provisionado', async () => {
    const c = await company();
    const ana = await setup(c);
    const res = await terminate(c, { employeeId: ana._id, vacationDaysPending: 10 }, '/payroll/terminations/preview');
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.period).toBe(`${PY}-03`);
    expect(r.lines.prima).toMatchObject({ base: cop(6_600_000), amount: cop(550_000), accrued: cop(549_780), skipped: false });
    expect(r.lines.cesantias).toMatchObject({ amount: cop(550_000), accrued: cop(549_780) });
    expect(r.lines.interest).toMatchObject({ days: 90, amount: cop(16_500), accrued: cop(66_000) });
    expect(r.lines.vacations).toMatchObject({ days: 10, amount: 66_666_667, accrued: cop(250_200) });
    expect(r.gross).toBe(cop(550_000) + cop(550_000) + cop(16_500) + 66_666_667);
    expect(r.net).toBe(r.gross);
    expect(await db.collection(COLLECTIONS.payrollTerminations).countDocuments({ tenantId: c.tenantId })).toBe(0);
  });

  it('asienta LC cancelando las provisiones del empleado, deja al empleado inactivo y se paga una vez', async () => {
    const c = await company();
    const ana = await setup(c);
    const res = await terminate(c, { employeeId: ana._id, vacationDaysPending: 10, severance: cop(1_000_000), withholding: cop(50_000) });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json().termination;
    expect(t.status).toBe('posted');
    expect(t.document).toMatch(/^LC\d+$/);
    expect(t.net).toBe(t.gross - cop(50_000));
    const journal = (await get(c, `/journals/${t.journalId}`)).json();
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.lines.find((l) => l.accountId === '250505').credit).toBe(t.net);
    expect(journal.lines.find((l) => l.accountId === '236505').credit).toBe(cop(50_000));
    expect(journal.lines.find((l) => l.accountId === '510548').debit).toBe(cop(1_000_000)); // indemnización
    for (const account of ['261005', '261010', '261020', '261015']) expect(await net(c, account), account).toBe(0);
    const employee = (await get(c, `/payroll/employees/${ana._id}`)).json();
    expect(employee).toMatchObject({ active: false, terminationId: t._id });
    expect(employee.endDate.slice(0, 10)).toBe(END);
    // No se liquida dos veces.
    expect((await terminate(c, { employeeId: ana._id })).statusCode).toBe(409);
    // Se paga una sola vez.
    const pay = (body) => post(c, `/payroll/terminations/${t._id}/pay`, body);
    expect((await pay({ date: '2099-01-01', account: '111005' })).statusCode).toBe(400);
    expect((await pay({ date: `${ym(0)}-05`, account: '111005' })).statusCode).toBe(200);
    expect((await pay({ date: `${ym(0)}-05`, account: '111005' })).statusCode).toBe(409);
    expect(await net(c, '111005')).toBe(-t.net);
    expect((await post(c, `/payroll/terminations/${t._id}/void`)).statusCode).toBe(409);
  });

  it('lo que ya entró en una liquidación de prima no se repite', async () => {
    const c = await company();
    const ana = await setup(c);
    expect((await call('POST', `${c.base}/payroll/benefits`, { cookie: c.cookie, body: { kind: 'prima', label: `${PY}-1` } })).statusCode).toBe(201);
    const r = (await terminate(c, { employeeId: ana._id }, '/payroll/terminations/preview')).json();
    expect(r.lines.prima).toMatchObject({ amount: 0, accrued: 0, skipped: true });
    expect(r.lines.cesantias.skipped).toBe(false);
  });

  it('exige la nómina del mes del retiro, un contrato sin liquidar y datos válidos', async () => {
    const c = await company();
    expect((await put(c, `/payroll/config/years/${PY}`, { params: PARAMS })).statusCode).toBe(200);
    const ana = await hire(c);
    const noRun = await terminate(c, { employeeId: ana._id }, '/payroll/terminations/preview');
    expect(noRun.statusCode).toBe(409);
    expect(noRun.json().message).toMatch(/primero liquida la nómina/);
    await run(c, `${PY}-03`);
    const bad = async (patch) => (await terminate(c, { employeeId: ana._id, ...patch }, '/payroll/terminations/preview')).statusCode;
    expect(await bad({ endDate: '2020-01-01' })).toBe(400); // antes del ingreso
    expect(await bad({ endDate: '2026-02-30' })).toBe(400);
    expect(await bad({ vacationDaysPending: -1 })).toBe(400);
    expect(await bad({ severance: 1.5 })).toBe(400);
    expect(await bad({ withholding: cop(999_999_999) })).toBe(400); // más que la liquidación
    expect((await terminate(c, { employeeId: String(new ObjectId()) }, '/payroll/terminations/preview')).statusCode).toBe(404);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: c.tenantId, docType: 'LC' })).toBe(0);
  });

  it('se anula mientras no esté pagada y el empleado vuelve a estar activo; la nómina del mes no se anula con ella vigente', async () => {
    const c = await company();
    const ana = await setup(c);
    const t = (await terminate(c, { employeeId: ana._id })).json().termination;
    const march = (await get(c, '/payroll/runs')).json().items.find((r) => r.period === `${PY}-03`);
    expect((await post(c, `/payroll/runs/${march._id}/void`)).statusCode).toBe(409);
    const voided = await post(c, `/payroll/terminations/${t._id}/void`);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().termination.status).toBe('void');
    const employee = (await get(c, `/payroll/employees/${ana._id}`)).json();
    expect(employee.active).toBe(true);
    expect(employee.endDate).toBeUndefined();
    for (const account of ['261005', '261010', '261020', '261015']) expect(await net(c, account), account).toBeLessThan(0); // las provisiones vuelven
    expect((await terminate(c, { employeeId: ana._id }, '/payroll/terminations/preview')).statusCode).toBe(200);
  });

  it('el lector no ve las liquidaciones y otra empresa no las ve', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const ana = await setup(a);
    const t = (await terminate(a, { employeeId: ana._id })).json().termination;
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    expect((await get(a, '/payroll/terminations', viewer)).statusCode).toBe(403);
    expect((await terminate(a, { employeeId: ana._id }, '/payroll/terminations/preview', viewer)).statusCode).toBe(403);
    expect((await get(b, `/payroll/terminations/${t._id}`)).statusCode).toBe(404);
    expect((await get(b, '/payroll/terminations')).json().items).toEqual([]);
    expect((await get(a, '/payroll/terminations')).json().items).toHaveLength(1);
  });
});
