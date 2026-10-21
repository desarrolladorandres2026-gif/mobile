import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';

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
  app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': `ye-${(counter += 1)}-aaaaaaaa` } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
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
  await make({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await make({ code: '360505', name: 'Utilidad del ejercicio', type: 'equity', parentCode: '3' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '510506', name: 'Sueldos', type: 'expense', parentCode: '5' });
  return { cookie, base };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const journal = (c, date, lines, docType = 'AJ') => call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType, date: `${date}T12:00:00Z`, currency: 'COP', lines } });
async function seedYear(c, y = 2025) {
  expect((await journal(c, `${y}-03-10`, [{ accountId: '110505', debit: 1_000_000 }, { accountId: '413505', credit: 1_000_000 }])).statusCode).toBe(201);
  expect((await journal(c, `${y}-04-10`, [{ accountId: '510506', debit: 400_000 }, { accountId: '110505', credit: 400_000 }])).statusCode).toBe(201);
}
const closeBody = (patch = {}) => ({ year: 2025, currency: 'COP', profitAccount: '360505', ...patch });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_yearend_http_test');
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

describe('cierre de ejercicio por la API', () => {
  it('vista previa, cierre, lista, informes y reapertura', async () => {
    const c = await company();
    await seedYear(c);
    const preview = (await call('GET', `${c.base}/year-end/preview?year=2025&currency=COP`, { cookie: c.cookie })).json();
    expect(preview).toMatchObject({ year: 2025, totals: { income: 1_000_000, expense: 400_000, result: 600_000 }, blockers: [], closed: null });
    expect(preview.lines.map((l) => l.code)).toEqual(['413505', '510506']);

    const closed = await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: closeBody() });
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json()).toMatchObject({ replayed: false, pendingCurrencies: [], journal: { docType: 'CA', source: { year: 2025, result: 600_000 } } });
    expect(closed.json().periodsClosed).toHaveLength(12);

    const again = await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: closeBody() });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect((await call('GET', `${c.base}/year-end`, { cookie: c.cookie })).json().items).toMatchObject([{ year: 2025, currency: 'COP', result: 600_000 }]);
    expect((await call('GET', `${c.base}/year-end/preview?year=2025&currency=COP`, { cookie: c.cookie })).json().closed).not.toBeNull();

    const sheet = (await call('GET', `${c.base}/reports/balance-sheet?to=2025-12&currency=COP`, { cookie: c.cookie })).json();
    expect(sheet.totals).toMatchObject({ equity: 600_000, result: 0 });
    const income = (await call('GET', `${c.base}/reports/income-statement?from=2025-01&to=2025-12&currency=COP`, { cookie: c.cookie })).json();
    expect(income.totals).toMatchObject({ income: 1_000_000, expense: 400_000, net: 600_000 });

    // Un asiento tardío en el año cerrado ya no entra, y el período no se reabre suelto.
    const late = await journal(c, '2025-06-10', [{ accountId: '110505', debit: 5 }, { accountId: '413505', credit: 5 }]);
    expect(late.statusCode).toBe(409);
    const single = await call('POST', `${c.base}/periods/2025-06/reopen`, { cookie: c.cookie });
    expect(single.statusCode).toBe(409);
    expect(single.json().error).toBe('INVALID_STATE');
    expect(single.json().message).toMatch(/reabre el ejercicio/);

    const reopened = await call('POST', `${c.base}/year-end/reopen`, { cookie: c.cookie, body: { year: 2025, currency: 'COP' } });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().periodsReopened).toHaveLength(12);
    expect((await call('GET', `${c.base}/year-end`, { cookie: c.cookie })).json().items).toEqual([]);
    expect((await journal(c, '2025-06-10', [{ accountId: '110505', debit: 5 }, { accountId: '413505', credit: 5 }])).statusCode).toBe(201);
    expect((await call('POST', `${c.base}/periods/2025-06/reopen`, { cookie: c.cookie })).statusCode).toBe(409); // ya está abierto: NOT_CLOSED
    expect((await call('POST', `${c.base}/year-end/reopen`, { cookie: c.cookie, body: { year: 2025, currency: 'COP' } })).statusCode).toBe(404);
  });

  it('un asiento manual no puede usar el tipo de documento del cierre', async () => {
    const c = await company();
    const res = await journal(c, '2025-03-10', [{ accountId: '110505', debit: 5 }, { accountId: '413505', credit: 5 }], 'CA');
    expect(res.statusCode).toBe(422);
  });

  it('el asiento de cierre no se revierte a mano', async () => {
    const c = await company();
    await seedYear(c);
    const closed = (await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: closeBody() })).json();
    const res = await call('POST', `${c.base}/journals/${closed.journal._id}/reverse`, { cookie: c.cookie, key: true, body: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('IMMUTABLE');
  });

  it('valida el cuerpo y explica lo que impide el cierre', async () => {
    const c = await company();
    await seedYear(c);
    const close = (body) => call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body });
    expect((await close({ year: 2025, currency: 'COP' })).statusCode).toBe(400); // falta la cuenta
    expect((await close(closeBody({ year: 1999 }))).statusCode).toBe(400);
    expect((await close(closeBody({ extra: 1 }))).statusCode).toBe(400);
    expect((await close(closeBody({ profitAccount: '413505' }))).statusCode).toBe(400); // no es patrimonio
    expect((await close(closeBody({ year: 2099 }))).statusCode).toBe(400); // no ha terminado
    expect((await close(closeBody({ year: 2023 }))).statusCode).toBe(409); // sin movimiento
    expect((await call('GET', `${c.base}/year-end/preview?year=abc&currency=COP`, { cookie: c.cookie })).statusCode).toBe(400);
    await seedYear(c, 2024);
    const blocked = await close(closeBody());
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/cierra primero el ejercicio 2024/);
    expect((await call('GET', `${c.base}/year-end/preview?year=2025&currency=COP`, { cookie: c.cookie })).json().blockers).toEqual(['cierra primero el ejercicio 2024']);
  });

  it('el contador cierra pero no reabre; el lector solo mira; sin sesión nada', async () => {
    const c = await company();
    await seedYear(c);
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    expect((await call('GET', `${c.base}/year-end/preview?year=2025&currency=COP`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/year-end`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/year-end/close`, { cookie: viewer, body: closeBody() })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/year-end`, { cookie: cashier })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/year-end/close`, { cookie: accountant, body: closeBody() })).statusCode).toBe(201);
    expect((await call('POST', `${c.base}/year-end/reopen`, { cookie: accountant, body: { year: 2025, currency: 'COP' } })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/year-end/reopen`, { cookie: c.cookie, body: { year: 2025, currency: 'COP' } })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/year-end`)).statusCode).toBe(401);
    expect((await call('POST', `${c.base}/year-end/close`, { body: closeBody() })).statusCode).toBe(401);
  });

  it('una empresa no ve ni cierra el ejercicio de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await seedYear(a);
    await call('POST', `${a.base}/year-end/close`, { cookie: a.cookie, body: closeBody() });
    expect((await call('GET', `${a.base}/year-end`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('GET', `${b.base}/year-end`, { cookie: b.cookie })).json().items).toEqual([]);
    expect((await call('POST', `${b.base}/year-end/close`, { cookie: b.cookie, body: closeBody() })).statusCode).toBe(409); // la suya no tiene movimiento
    expect((await call('POST', `${b.base}/year-end/reopen`, { cookie: b.cookie, body: { year: 2025, currency: 'COP' } })).statusCode).toBe(404);
  });
});
