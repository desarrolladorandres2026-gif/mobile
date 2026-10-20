import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;
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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `rch-${(counter += 1)}-aaaaaaaa` : key } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company() {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email: 'ana@andina.co', password: PASSWORD } });
  expect(reg.statusCode).toBe(201);
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last('ana@andina.co')) } })).statusCode).toBe(204);
  const cookie = await login('ana@andina.co');
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  const party = await call('POST', `${base}/parties`, { cookie, body: { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } });
  expect((await call('PUT', `${base}/invoicing/settings`, {
    cookie,
    body: {
      issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
    },
  })).statusCode).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    expect((await call('POST', `${base}/invoicing/resolutions`, { cookie, body: { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: LAST_YEAR, validTo: NEXT_YEAR } })).statusCode).toBe(201);
  }
  const customerId = party.json()._id;
  const inv = await call('POST', `${base}/invoices`, {
    cookie,
    key: true,
    body: { customerId, issueDate: TODAY, dueDate: NEXT_YEAR, paymentMethod: 'credit', lines: [{ description: 'Servicio', quantity: 1000, unitPrice: 100_000, vatBps: 0 }] },
  });
  expect(inv.statusCode).toBe(201);
  return { cookie, base, customerId, invoiceId: inv.json().invoice._id, journalId: inv.json().invoice.accounting.journalId };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const receiptBody = (c, amount, patch = {}) => ({ partyId: c.customerId, date: TODAY, depositAccount: '110505', allocations: [{ invoiceId: c.invoiceId, amount }], ...patch });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_receivables_http_test');
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

describe('recibos de caja por la API', () => {
  it('crea, repite con la misma clave, consulta, lista y anula', async () => {
    const c = await company();
    const key = 'recibo-1-aaaaaaaa';
    const created = await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key, body: receiptBody(c, 60_000) });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().receipt).toMatchObject({ fullNumber: 'RC1', total: 60_000, status: 'posted' });
    const id = created.json().receipt._id;

    const again = await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key, body: receiptBody(c, 60_000) });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, receipt: { _id: id } });

    expect((await call('GET', `${c.base}/receipts/${id}`, { cookie: c.cookie })).json()).toMatchObject({ fullNumber: 'RC1' });
    expect((await call('GET', `${c.base}/receipts`, { cookie: c.cookie })).json().items).toHaveLength(1);

    const open = await call('GET', `${c.base}/receivables/open?partyId=${c.customerId}&currency=COP`, { cookie: c.cookie });
    expect(open.json().items).toMatchObject([{ total: 100_000, paid: 60_000, balance: 40_000 }]);
    const aging = await call('GET', `${c.base}/receivables/aging?currency=COP`, { cookie: c.cookie });
    expect(aging.json()).toMatchObject({ customers: 1, totals: { total: 40_000, current: 40_000 } });

    const voided = await call('POST', `${c.base}/receipts/${id}/void`, { cookie: c.cookie });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().receipt.status).toBe('void');
    const after = await call('GET', `${c.base}/receivables/aging?currency=COP`, { cookie: c.cookie });
    expect(after.json().totals.total).toBe(100_000);
  });

  it('responde 409 al cobrar de más y 404 a recibos que no existen', async () => {
    const c = await company();
    const over = await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: receiptBody(c, 100_001) });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('OVER_PAYMENT');
    expect((await call('GET', `${c.base}/receipts/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('POST', `${c.base}/receipts/${'a'.repeat(24)}/void`, { cookie: c.cookie })).statusCode).toBe(404);
  });

  it('valida el cuerpo, exige clave y no acepta campos extra', async () => {
    const c = await company();
    const post = (body, key = true) => call('POST', `${c.base}/receipts`, { cookie: c.cookie, key, body });
    expect((await post(receiptBody(c, 1_000), false)).statusCode).toBe(400);
    expect((await post(receiptBody(c, 1_000, { extra: 1 }))).statusCode).toBe(400);
    expect((await post(receiptBody(c, 0))).statusCode).toBe(400);
    expect((await post(receiptBody(c, 1.5))).statusCode).toBe(400);
    expect((await post(receiptBody(c, 100, { allocations: [] }))).statusCode).toBe(400);
    expect((await post(receiptBody(c, 100, { date: '2026-13-45' }))).statusCode).toBe(400);
    expect((await post(receiptBody(c, 100, { depositAccount: 'abc' }))).statusCode).toBe(400);
  });

  it('un lector puede ver la cartera pero no cobrar ni anular; sin sesión no se ve nada', async () => {
    const c = await company();
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await call('GET', `${c.base}/receivables/aging?currency=COP`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/receipts`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/receipts`, { cookie: viewer, key: true, body: receiptBody(c, 1_000) })).statusCode).toBe(403);
    const created = await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: receiptBody(c, 1_000) });
    expect((await call('POST', `${c.base}/receipts/${created.json().receipt._id}/void`, { cookie: viewer })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/receipts`)).statusCode).toBe(401);
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    expect((await call('POST', `${c.base}/receipts`, { cookie: accountant, key: true, body: receiptBody(c, 1_000) })).statusCode).toBe(201);
  });

  it('otra empresa no ve ni cobra estas facturas', async () => {
    const c = await company();
    const foreign = await call('POST', '/v1/auth/register', { body: { companyName: 'Otra SAS', country: 'CO', currency: 'COP', ownerName: 'Luis', email: 'luis@otra.co', password: PASSWORD } });
    const stranger = await login('luis@otra.co');
    expect(foreign.statusCode).toBe(201);
    expect((await call('GET', `${c.base}/receipts`, { cookie: stranger })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/receipts`, { cookie: stranger, key: true, body: receiptBody(c, 1_000) })).statusCode).toBe(403);
  });
});

describe('asientos generados por documentos', () => {
  it('no se revierten a mano: se corrigen desde su documento', async () => {
    const c = await company();
    const res = await call('POST', `${c.base}/journals/${c.journalId}/reverse`, { cookie: c.cookie, key: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/lo generó un documento/);

    const created = await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: receiptBody(c, 1_000) });
    const receiptJournal = created.json().receipt.journalId;
    expect((await call('POST', `${c.base}/journals/${receiptJournal}/reverse`, { cookie: c.cookie, key: true })).statusCode).toBe(422);
  });

  it('un asiento manual no puede usar los tipos de documento reservados, pero sí otros', async () => {
    const c = await company();
    const entry = (docType) => ({ docType, date: `${TODAY}T12:00:00Z`, currency: 'COP', lines: [{ accountId: '110505', debit: 100 }, { accountId: '413505', credit: 100 }] });
    for (const docType of ['RC', 'fv', 'NC', 'CE']) {
      const res = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: entry(docType) });
      expect(res.statusCode, docType).toBe(422);
    }
    expect((await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: entry('CC') })).statusCode).toBe(201);
  });
});
