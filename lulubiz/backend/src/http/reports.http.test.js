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

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true } });
};

const call = (method, url, { cookie, body } = {}) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
let counter = 0;

async function company(email) {
  const res = await call('POST', '/v1/auth/register', { body: { companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));
  const base = `/v1/tenants/${res.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413535', name: 'Ventas', type: 'income', parentCode: '4' });
  return { cookie, base };
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_reports_http_test');
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

/** Asienta por la API con su clave de idempotencia. */
async function post(c, date, amount) {
  const res = await app.inject({
    method: 'POST',
    url: `${c.base}/journals`,
    headers: { cookie: c.cookie, 'idempotency-key': `rep-${(counter += 1)}-aaaaaaaa` },
    payload: {
      docType: 'CG',
      date,
      currency: 'COP',
      lines: [
        { accountId: '110505', debit: amount },
        { accountId: '413535', credit: amount },
      ],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
}

describe('rutas de reportes', () => {
  it('devuelven balance de prueba, resultados, balance general y libro auxiliar', async () => {
    const c = await company('ana@andina.co');
    await post(c, '2026-10-05T12:00:00Z', 1_000_000);
    await post(c, '2026-10-09T12:00:00Z', 250_000);

    const trial = await call('GET', `${c.base}/reports/trial-balance?from=2026-10&to=2026-10&currency=COP`, { cookie: c.cookie });
    expect(trial.statusCode).toBe(200);
    expect(trial.json()).toMatchObject({ balanced: true, totals: { debit: 1_250_000, credit: 1_250_000 } });
    expect(trial.json().rows.find((r) => r.code === '1')).toMatchObject({ postable: false, closing: 1_250_000 });

    const income = await call('GET', `${c.base}/reports/income-statement?from=2026-10&to=2026-10&currency=COP`, { cookie: c.cookie });
    expect(income.json().totals).toMatchObject({ income: 1_250_000, net: 1_250_000 });

    const sheet = await call('GET', `${c.base}/reports/balance-sheet?to=2026-10&currency=COP`, { cookie: c.cookie });
    expect(sheet.json()).toMatchObject({ balanced: true, totals: { assets: 1_250_000, result: 1_250_000 } });

    const first = await call('GET', `${c.base}/reports/general-ledger?account=110505&from=2026-10&to=2026-10&currency=COP&limit=1`, { cookie: c.cookie });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    const cursor = first.json().nextCursor;
    expect(cursor).toBeTruthy();
    const second = await call('GET', `${c.base}/reports/general-ledger?account=110505&from=2026-10&to=2026-10&currency=COP&limit=1&cursor=${encodeURIComponent(cursor)}`, { cookie: c.cookie });
    expect(second.json()).toMatchObject({ nextCursor: null, closing: { balance: 1_250_000 } });
  });

  it('exigen sesión, validan los parámetros y no cruzan empresas', async () => {
    const c = await company('ana@andina.co');
    const other = await company('luis@otra.co');
    const url = `${c.base}/reports/trial-balance?from=2026-10&to=2026-10&currency=COP`;

    expect((await call('GET', url)).statusCode).toBe(401);
    expect((await call('GET', url, { cookie: other.cookie })).statusCode).toBe(403);

    expect((await call('GET', `${c.base}/reports/trial-balance?from=2026-13&to=2026-10&currency=COP`, { cookie: c.cookie })).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/reports/trial-balance?from=2026-10&to=2026-10`, { cookie: c.cookie })).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/reports/trial-balance?from=2026-10&to=2026-10&currency=COP&x=1`, { cookie: c.cookie })).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/reports/trial-balance?from=2026-11&to=2026-10&currency=COP`, { cookie: c.cookie })).statusCode).toBe(422);
    expect((await call('GET', `${c.base}/reports/general-ledger?account=999&from=2026-10&to=2026-10&currency=COP`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${c.base}/reports/general-ledger?account=110505&from=2026-10&to=2026-10&currency=COP&cursor=basura`, { cookie: c.cookie })).statusCode).toBe(422);
  });
});
