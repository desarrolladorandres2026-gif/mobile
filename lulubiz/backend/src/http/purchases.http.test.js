import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const TODAY = new Date().toISOString().slice(0, 10);

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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `pu-${(counter += 1)}-aaaaaaaa` : key } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company() {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email: 'ana@andina.co', password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last('ana@andina.co')) } })).statusCode).toBe(204);
  const cookie = await login('ana@andina.co');
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '236540', name: 'Retención en la fuente', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  const party = await call('POST', `${base}/parties`, { cookie, body: { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 } });
  const supplierId = party.json()._id;
  const saveSettings = (accounts) =>
    call('PUT', `${base}/invoicing/settings`, {
      cookie,
      body: {
        issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
        accounts: { receivable: '130505', income: '413505', vatPayable: '240805', ...accounts },
      },
    });
  return { cookie, base, supplierId, saveSettings };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const purchaseBody = (c, patch = {}) => ({
  supplierId: c.supplierId,
  supplierDocNumber: `SA-${(counter += 1)}`,
  issueDate: TODAY,
  dueDate: TODAY,
  lines: [{ description: 'Servicio de aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }],
  withholdings: [{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }],
  ...patch,
});

beforeAll(async () => {
  mongo = await startMongo('lulubiz_purchases_http_test');
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

async function ready() {
  const c = await company();
  expect((await c.saveSettings({ payable: '220505', vatDeductible: '240810' })).statusCode).toBe(200);
  return c;
}

describe('compras por la API', () => {
  it('dice qué falta configurar y luego registra la factura con sus retenciones', async () => {
    const c = await company();
    expect((await c.saveSettings({})).statusCode).toBe(200);
    const before = await call('GET', `${c.base}/purchasing/status`, { cookie: c.cookie });
    expect(before.json()).toMatchObject({ ready: false, missing: ['la cuenta de proveedores', 'la cuenta de IVA descontable'] });
    const refused = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: purchaseBody(c) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('SETTINGS_INCOMPLETE');

    expect((await c.saveSettings({ payable: '220505', vatDeductible: '240810' })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/purchasing/status`, { cookie: c.cookie })).json()).toMatchObject({ ready: true, vatRatesBps: [0, 500, 1900] });
    const key = 'compra-1-aaaaaaaa';
    const created = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key, body: purchaseBody(c, { supplierDocNumber: 'SA-1' }) });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().purchase).toMatchObject({ fullNumber: 'FC1', payable: 1_165_000, balance: 1_165_000, withheld: 25_000 });
    const again = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key, body: purchaseBody(c, { supplierDocNumber: 'SA-1' }) });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);

    const duplicate = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: purchaseBody(c, { supplierDocNumber: 'SA-1' }) });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('DUPLICATE');
  });

  it('crea, consulta, lista, acredita, paga y anula de punta a punta', async () => {
    const c = await ready();
    const created = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: purchaseBody(c) });
    const id = created.json().purchase._id;
    expect((await call('GET', `${c.base}/purchases/${id}`, { cookie: c.cookie })).json()).toMatchObject({ fullNumber: 'FC1', creditStatus: 'none' });
    expect((await call('GET', `${c.base}/purchases?supplierId=${c.supplierId}`, { cookie: c.cookie })).json().items).toHaveLength(1);

    const note = await call('POST', `${c.base}/purchases/${id}/credit-notes`, {
      cookie: c.cookie,
      key: true,
      body: { reason: 'Devolución parcial', supplierDocNumber: 'NC-1', lines: [{ lineIndex: 0, quantity: 500 }] },
    });
    expect(note.statusCode, note.body).toBe(201);
    expect(note.json().note).toMatchObject({ fullNumber: 'NP1', totals: { subtotal: 500_000, total: 595_000 } });
    expect((await call('GET', `${c.base}/supplier-notes`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/purchases/${id}`, { cookie: c.cookie })).json().creditStatus).toBe('partial');

    const open = (await call('GET', `${c.base}/payables/open?partyId=${c.supplierId}&currency=COP`, { cookie: c.cookie })).json().items;
    expect(open).toHaveLength(1);
    const pay = await call('POST', `${c.base}/payments`, {
      cookie: c.cookie,
      key: true,
      body: { partyId: c.supplierId, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: id, amount: open[0].balance }] },
    });
    expect(pay.statusCode, pay.body).toBe(201);
    expect(pay.json().payment).toMatchObject({ fullNumber: 'CE1', status: 'posted' });
    expect((await call('GET', `${c.base}/payments/${pay.json().payment._id}`, { cookie: c.cookie })).json().fullNumber).toBe('CE1');
    expect((await call('GET', `${c.base}/payables/aging?currency=COP`, { cookie: c.cookie })).json().totals.total).toBe(0);

    const over = await call('POST', `${c.base}/payments`, { cookie: c.cookie, key: true, body: { partyId: c.supplierId, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: id, amount: 1 }] } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('OVER_PAYMENT');

    expect((await call('POST', `${c.base}/purchases/${id}/void`, { cookie: c.cookie })).statusCode).toBe(409);
    expect((await call('POST', `${c.base}/payments/${pay.json().payment._id}/void`, { cookie: c.cookie })).json().payment.status).toBe('void');
    expect((await call('POST', `${c.base}/supplier-notes/${note.json().note._id}/void`, { cookie: c.cookie })).json().note.status).toBe('void');
    expect((await call('POST', `${c.base}/purchases/${id}/void`, { cookie: c.cookie })).json().purchase.status).toBe('void');
    expect((await call('GET', `${c.base}/payables/aging?currency=COP`, { cookie: c.cookie })).json().totals.total).toBe(0);
  });

  it('valida el cuerpo y exige clave', async () => {
    const c = await ready();
    const post = (body, key = true) => call('POST', `${c.base}/purchases`, { cookie: c.cookie, key, body });
    expect((await post(purchaseBody(c), false)).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { extra: 1 }))).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { lines: [] }))).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100 }] }))).statusCode).toBe(400); // sin cuenta
    expect((await post(purchaseBody(c, { withholdings: [{ name: 'x', accountId: '236540', basis: 'otra', rateBps: 100 }] }))).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { issueDate: '2026-13-01' }))).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100, vatBps: 1600, accountId: '519595' }] }))).statusCode).toBe(400);
    expect((await post(purchaseBody(c, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100, vatBps: 0, accountId: '413505' }] }))).statusCode).toBe(400);
  });

  it('un lector ve las compras pero no registra ni paga; un contador sí; sin sesión nada', async () => {
    const c = await ready();
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    expect((await call('GET', `${c.base}/purchases`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/payables/aging?currency=COP`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/purchases`, { cookie: viewer, key: true, body: purchaseBody(c) })).statusCode).toBe(403);
    const created = await call('POST', `${c.base}/purchases`, { cookie: accountant, key: true, body: purchaseBody(c) });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().purchase._id;
    const pay = { partyId: c.supplierId, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: id, amount: 1_000 }] };
    expect((await call('POST', `${c.base}/payments`, { cookie: viewer, key: true, body: pay })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/purchases/${id}/void`, { cookie: viewer })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/purchases`)).statusCode).toBe(401);
    expect((await call('POST', `${c.base}/payments`, { cookie: accountant, key: true, body: pay })).statusCode).toBe(201);
  });

  it('otra empresa no ve ni toca las compras; ids inexistentes dan 404', async () => {
    const c = await ready();
    const created = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: purchaseBody(c) });
    await call('POST', '/v1/auth/register', { body: { companyName: 'Otra SAS', country: 'CO', currency: 'COP', ownerName: 'Luis', email: 'luis@otra.co', password: PASSWORD } });
    const stranger = await login('luis@otra.co');
    expect((await call('GET', `${c.base}/purchases/${created.json().purchase._id}`, { cookie: stranger })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/purchases/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${c.base}/payments/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${c.base}/supplier-notes/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('POST', `${c.base}/purchases/${'a'.repeat(24)}/void`, { cookie: c.cookie })).statusCode).toBe(404);
  });

  it('los asientos de compras y pagos no se revierten a mano', async () => {
    const c = await ready();
    const created = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: purchaseBody(c) });
    const res = await call('POST', `${c.base}/journals/${created.json().purchase.journalId}/reverse`, { cookie: c.cookie, key: true });
    expect(res.statusCode).toBe(422);
  });
});
