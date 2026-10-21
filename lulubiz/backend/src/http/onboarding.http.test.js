import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createSandboxProvider } from '../invoicing/provider.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const YEAR = new Date().getUTCFullYear();

let mongo;
let db;
let app;
let mailer;

const makeApp = (extra = {}) => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true }, ...extra });
};

const call = (method, url, { cookie, body } = {}) =>
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company(name = 'Andina SAS', email = 'ana@andina.co') {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  return { cookie: await login(email), base: `/v1/tenants/${reg.json().tenantId}` };
}

const steps = async (c) => {
  const res = await call('GET', `${c.base}/onboarding`, { cookie: c.cookie });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const byKey = (data) => Object.fromEntries(data.steps.map((s) => [s.key, s]));

async function configure(c) {
  const make = (body) => call('POST', `${c.base}/accounts`, { cookie: c.cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
}
const saveSettings = (c, accounts = {}) =>
  call('PUT', `${c.base}/invoicing/settings`, {
    cookie: c.cookie,
    body: {
      issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', ...accounts },
    },
  });
const resolution = (c, docType, prefix) =>
  call('POST', `${c.base}/invoicing/resolutions`, {
    cookie: c.cookie,
    body: { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` },
  });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_onboarding_http_test');
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

describe('primeros pasos', () => {
  it('una empresa nueva tiene todo lo obligatorio pendiente y cada paso dice qué falta y a dónde ir', async () => {
    const c = await company();
    const data = await steps(c);
    expect(data).toMatchObject({ ready: false, requiredPending: 5, sandbox: true });
    expect(data.steps.map((s) => s.key)).toEqual(['chart', 'invoicing-settings', 'resolutions', 'purchasing', 'provider', 'parties', 'items', 'pos']);
    expect(data.steps.every((s) => !s.done)).toBe(true);
    const k = byKey(data);
    expect(k.chart).toMatchObject({ required: true, path: 'cuentas' });
    expect(k.chart.detail).toMatch(/borrador/);
    expect(k.provider.detail).toMatch(/modo de pruebas/);
    expect(k.parties).toMatchObject({ required: false, path: 'importar' });
    expect(k.pos).toMatchObject({ required: false, path: 'cajas' });
  });

  it('avanza con la configuración: plan, emisor, resoluciones y compras', async () => {
    const c = await company();
    await configure(c);
    let k = byKey(await steps(c));
    expect(k.chart.done).toBe(true);
    expect(k['invoicing-settings'].done).toBe(false);

    expect((await saveSettings(c)).statusCode).toBe(200);
    k = byKey(await steps(c));
    expect(k['invoicing-settings'].done).toBe(true);
    expect(k.resolutions.done).toBe(false);
    expect(k.resolutions.detail).toMatch(/resolución de numeración vigente para facturas/);
    expect(k.purchasing.done).toBe(false);
    expect(k.purchasing.detail).toMatch(/proveedores/);

    expect((await resolution(c, 'invoice', 'FE')).statusCode).toBe(201);
    k = byKey(await steps(c));
    expect(k.resolutions.done).toBe(false); // falta la de notas crédito
    expect(k.resolutions.detail).toMatch(/notas crédito/);
    expect((await resolution(c, 'credit_note', 'NC')).statusCode).toBe(201);
    expect((await saveSettings(c, { payable: '220505', vatDeductible: '240810' })).statusCode).toBe(200);
    const data = await steps(c);
    k = byKey(data);
    expect(k.resolutions.done).toBe(true);
    expect(k.purchasing.done).toBe(true);
    // Todo configurado, pero el proveedor sigue siendo el simulador: no está listo para facturar de verdad.
    expect(k.provider.done).toBe(false);
    expect(data).toMatchObject({ ready: false, requiredPending: 1, sandbox: true });
  });

  it('con un proveedor real conectado y todo configurado, queda listo', async () => {
    await app.close();
    app = await makeApp({ invoicingProvider: { ...createSandboxProvider(), name: 'proveedor-real', sandbox: false } });
    const c = await company();
    await configure(c);
    await saveSettings(c, { payable: '220505', vatDeductible: '240810' });
    await resolution(c, 'invoice', 'FE');
    await resolution(c, 'credit_note', 'NC');
    const data = await steps(c);
    expect(data).toMatchObject({ ready: true, requiredPending: 0, sandbox: false });
    expect(byKey(data).provider).toMatchObject({ done: true, detail: 'Conectado: proveedor-real.' });
  });

  it('sin proveedor configurado dice que no se puede facturar', async () => {
    await app.close();
    app = await makeApp({ invoicingProvider: null });
    const c = await company();
    const data = await steps(c);
    expect(byKey(data).provider.detail).toMatch(/no tiene un proveedor/);
    expect(data.sandbox).toBe(false);
  });

  it('los pasos recomendables se marcan al registrar terceros, artículos y cajas', async () => {
    const c = await company();
    await configure(c);
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '143505', name: 'Mercancías', type: 'asset', parentCode: '1' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '6', name: 'Costos', type: 'cost', postable: false } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '613505', name: 'Costo', type: 'cost', parentCode: '6' } });
    await call('POST', `${c.base}/parties`, { cookie: c.cookie, body: { name: 'Cliente', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } });
    await call('POST', `${c.base}/items`, { cookie: c.cookie, body: { sku: 'A1', name: 'Artículo', type: 'goods', inventoryAccount: '143505', cogsAccount: '613505' } });
    await call('POST', `${c.base}/pos/registers`, { cookie: c.cookie, body: { code: 'CAJA1', name: 'Mostrador', accounts: { cash: '110505' } } });
    const k = byKey(await steps(c));
    expect(k.parties).toMatchObject({ done: true, detail: '1 terceros registrados.' });
    expect(k.items).toMatchObject({ done: true, detail: '1 artículos registrados.' });
    expect(k.pos).toMatchObject({ done: true, detail: '1 cajas creadas.' });
  });

  it('cada empresa ve solo lo suyo, y exige sesión con permiso de lectura', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await configure(a);
    expect(byKey(await steps(a)).chart.done).toBe(true);
    expect(byKey(await steps(b)).chart.done).toBe(false);
    expect((await call('GET', `${a.base}/onboarding`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('GET', `${a.base}/onboarding`)).statusCode).toBe(401);
  });
});
