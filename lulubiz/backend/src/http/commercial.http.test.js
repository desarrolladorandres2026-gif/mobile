import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextOccurrence } from '../commercial/commercial.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

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

const call = (method, url, { cookie, body } = {}) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body } : {}) });
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
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  const saved = await call('PUT', `${base}/invoicing/settings`, {
    cookie,
    body: {
      issuer: { name, taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505' },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    expect((await call('POST', `${base}/invoicing/resolutions`, { cookie, body: { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` } })).statusCode).toBe(201);
  }
  const party = async (partyName, roles, taxId, checkDigit) => (await call('POST', `${base}/parties`, { cookie, body: { name: partyName, roles, taxIdType: 'NIT', taxId, checkDigit } })).json()._id;
  return { cookie, base, tenantId: new ObjectId(reg.json().tenantId), customer: await party('Droguería Los Andes', ['customer'], '800197268', 4), supplier: await party('Aseo Total SAS', ['supplier'], '900123456', 8) };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const saleLines = (extra = {}) => [{ description: 'Mercancía', quantity: 2000, unitPrice: 500_000, vatBps: 1900, ...extra }]; // 2 × 5.000,00 + 19 %
const purchaseLines = (extra = {}) => [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595', ...extra }];
const post = (c, path, body, cookie = c.cookie) => call('POST', `${c.base}${path}`, { cookie, body });
const get = (c, path) => call('GET', `${c.base}${path}`, { cookie: c.cookie });
const countOf = (c, collection, filter = {}) => db.collection(collection).countDocuments({ tenantId: c.tenantId, ...filter });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_commercial_http_test');
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

describe('próxima fecha de una plantilla', () => {
  const d = (s) => new Date(`${s}T12:00:00.000Z`);
  const next = (s, frequency, anchor) => nextOccurrence(d(s), frequency, anchor).toISOString().slice(0, 10);

  it('semanal suma siete días', () => {
    expect(next('2026-10-25', 'weekly', 25)).toBe('2026-11-01');
  });

  it('mensual conserva el día de inicio aunque el mes sea más corto', () => {
    expect(next('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(next('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(next('2028-01-31', 'monthly', 31)).toBe('2028-02-29');
    expect(next('2026-04-30', 'monthly', 31)).toBe('2026-05-31');
    expect(next('2026-12-15', 'monthly', 15)).toBe('2027-01-15');
  });

  it('trimestral y anual', () => {
    expect(next('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
    expect(next('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
    expect(next('2026-06-10', 'yearly', 10)).toBe('2027-06-10');
  });

  it('rechaza una frecuencia desconocida', () => {
    expect(() => nextOccurrence(d('2026-01-01'), 'daily', 1)).toThrow(/frecuencia/);
  });
});

describe('cotizaciones', () => {
  const create = (c, patch = {}) => post(c, '/quotes', { customerId: c.customer, issueDate: iso(-2), validUntil: iso(10), lines: saleLines(), ...patch });

  it('se crean con totales calculados y numeración consecutiva', async () => {
    const c = await company();
    const first = await create(c, { notes: 'Entrega en 5 días' });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ fullNumber: 'COT-1', status: 'open', expired: false, notes: 'Entrega en 5 días', customer: { name: 'Droguería Los Andes' }, totals: { subtotal: 1_000_000, tax: 190_000, total: 1_190_000 } });
    expect((await create(c)).json().fullNumber).toBe('COT-2');
    const listed = (await get(c, '/quotes')).json();
    expect(listed.items.map((q) => q.fullNumber)).toEqual(['COT-2', 'COT-1']);
    expect((await get(c, `/quotes/${first.json()._id}`)).json().totals.total).toBe(1_190_000);
    expect((await get(c, `/quotes?customerId=${c.supplier}`)).json().items).toEqual([]);
    expect((await get(c, `/quotes/${new ObjectId()}`)).statusCode).toBe(404);
  });

  it('rechazan lo que no es una oferta válida', async () => {
    const c = await company();
    expect((await create(c, { lines: [] })).statusCode).toBe(400);
    expect((await create(c, { validUntil: iso(-5) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await create(c, { customerId: c.supplier })).statusCode).toBe(400); // no es cliente
    expect((await create(c, { customerId: String(new ObjectId()) })).statusCode).toBe(404);
    expect((await create(c, { lines: saleLines({ vatBps: 1234 }) })).statusCode).toBe(400);
    expect((await create(c, { lines: saleLines({ costCenter: 'NOPE' }) })).statusCode).toBe(400);
    expect(await countOf(c, COLLECTIONS.quotes)).toBe(0);
  });

  it('se acepta, se rechaza y se anula; la factura no admite más cambios', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    expect((await post(c, `/quotes/${id}/reject`)).json().status).toBe('rejected');
    expect((await post(c, `/quotes/${id}/accept`)).json().status).toBe('accepted');
    expect((await post(c, `/quotes/${id}/void`)).json().status).toBe('void');
    expect((await post(c, `/quotes/${id}/accept`)).statusCode).toBe(409);
    expect((await post(c, `/quotes/${new ObjectId()}/accept`)).statusCode).toBe(404);
  });

  it('se convierte en factura con las mismas líneas y no se factura dos veces, ni a la vez', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    const results = await Promise.all([1, 2, 3].map(() => post(c, `/quotes/${id}/invoice`, { paymentMethod: 'credit', dueDate: iso(30) })));
    expect(results.map((r) => r.statusCode).filter((s) => s === 201 || s === 200 || s === 202).length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([200, 201, 202, 409]).toContain(r.statusCode);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(1);
    const quote = (await get(c, `/quotes/${id}`)).json();
    expect(quote.status).toBe('invoiced');
    expect(quote.invoiceNumber).toMatch(/^FE/);
    const invoice = (await get(c, `/invoices/${quote.invoiceId}`)).json();
    expect(invoice).toMatchObject({ paymentMethod: 'credit', totals: { total: 1_190_000 }, balance: 1_190_000 });
    expect(invoice.notes).toBe(`Según cotización ${quote.fullNumber}`);
    expect((await post(c, `/quotes/${id}/invoice`, { paymentMethod: 'cash' })).statusCode).toBe(409);
    expect((await post(c, `/quotes/${id}/void`)).statusCode).toBe(409);
  });

  it('una cotización vencida no se acepta ni se factura', async () => {
    const c = await company();
    const created = (await create(c, { issueDate: iso(-10), validUntil: iso(-1) })).json();
    expect(created.expired).toBe(true);
    expect((await get(c, `/quotes/${created._id}`)).json().expired).toBe(true);
    expect((await post(c, `/quotes/${created._id}/accept`)).statusCode).toBe(409);
    expect((await post(c, `/quotes/${created._id}/invoice`, { paymentMethod: 'cash' })).statusCode).toBe(409);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(0);
  });

  it('si la factura no se puede emitir, la cotización queda como estaba y se puede reintentar', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    await post(c, `/quotes/${id}/accept`);
    await db.collection(COLLECTIONS.parties).updateOne({ _id: new ObjectId(c.customer) }, { $set: { active: false } });
    expect((await post(c, `/quotes/${id}/invoice`, { paymentMethod: 'cash' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(c, `/quotes/${id}`)).json().status).toBe('accepted');
    await db.collection(COLLECTIONS.parties).updateOne({ _id: new ObjectId(c.customer) }, { $set: { active: true } });
    expect((await post(c, `/quotes/${id}/invoice`, { paymentMethod: 'cash' })).statusCode).toBe(201);
    expect((await get(c, `/quotes/${id}`)).json().status).toBe('invoiced');
  });

  it('el lector las ve pero no las crea; otra empresa no las ve', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const id = (await create(a)).json()._id;
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    expect((await call('GET', `${a.base}/quotes`, { cookie: viewer })).statusCode).toBe(200);
    expect((await post(a, '/quotes', { customerId: a.customer, validUntil: iso(5), lines: saleLines() }, viewer)).statusCode).toBe(403);
    expect((await post(a, `/quotes/${id}/accept`, undefined, viewer)).statusCode).toBe(403);
    expect((await get(b, `/quotes/${id}`)).statusCode).toBe(404);
    expect((await get(b, '/quotes')).json().items).toEqual([]);
  });
});

describe('órdenes de compra', () => {
  const create = (c, patch = {}) => post(c, '/purchase-orders', { supplierId: c.supplier, lines: purchaseLines(), expectedDate: iso(7), ...patch });

  it('se crean con totales y cuenta obligatoria', async () => {
    const c = await company();
    const first = await create(c);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ fullNumber: 'OC-1', status: 'open', supplier: { name: 'Aseo Total SAS' }, totals: { total: 1_190_000 } });
    expect((await create(c)).json().fullNumber).toBe('OC-2');
    expect((await create(c, { lines: purchaseLines({ accountId: undefined }) })).statusCode).toBe(400);
    expect((await create(c, { supplierId: c.customer })).statusCode).toBe(400);
    expect((await create(c, { expectedDate: iso(-30) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(c, '/purchase-orders')).json().items.map((o) => o.fullNumber)).toEqual(['OC-2', 'OC-1']);
  });

  it('al recibirse se convierte en la factura de compra y no se recibe dos veces', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    const received = await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'sa-501', issueDate: iso(-1), dueDate: iso(30) });
    expect(received.statusCode, received.body).toBe(201);
    expect(received.json().purchase).toMatchObject({ supplierDocNumber: 'SA-501', fullNumber: 'FC1', payable: 1_190_000, balance: 1_190_000 });
    expect(received.json().purchase.notes).toBe('Según orden OC-1');
    expect(received.json().order).toMatchObject({ status: 'received', purchaseNumber: 'FC1' });
    expect((await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'sa-502' })).statusCode).toBe(409);
    expect((await post(c, `/purchase-orders/${id}/void`)).statusCode).toBe(409);
    expect(await countOf(c, COLLECTIONS.purchases)).toBe(1);
  });

  it('dos recepciones a la vez registran una sola compra', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    const results = await Promise.all([1, 2, 3].map(() => post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'SA-777', issueDate: iso(-1) })));
    for (const r of results) expect([200, 201, 409]).toContain(r.statusCode);
    expect(await countOf(c, COLLECTIONS.purchases)).toBe(1);
    expect((await get(c, `/purchase-orders/${id}`)).json().status).toBe('received');
  });

  it('si la compra no se puede registrar, la orden sigue abierta', async () => {
    const c = await company();
    const taken = await app.inject({ method: 'POST', url: `${c.base}/purchases`, headers: { cookie: c.cookie, 'idempotency-key': 'taken-purchase-aaaa' }, payload: { supplierId: c.supplier, supplierDocNumber: 'SA-9', issueDate: iso(-1), lines: purchaseLines() } });
    expect(taken.statusCode).toBe(201);
    const id = (await create(c)).json()._id;
    const clash = await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'SA-9', issueDate: iso(-1) });
    expect(clash.statusCode).toBe(409);
    expect((await get(c, `/purchase-orders/${id}`)).json().status).toBe('open');
    expect((await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'SA-10', issueDate: iso(-1) })).statusCode).toBe(201);
  });

  it('una orden abierta se anula; el lector no la crea ni la recibe', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await post(c, `/purchase-orders/${id}/void`, undefined, viewer)).statusCode).toBe(403);
    expect((await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'X' }, viewer)).statusCode).toBe(403);
    expect((await post(c, `/purchase-orders/${id}/void`)).json().status).toBe('void');
    expect((await post(c, `/purchase-orders/${id}/void`)).statusCode).toBe(409);
    expect((await post(c, `/purchase-orders/${id}/receive`, { supplierDocNumber: 'X1' })).statusCode).toBe(409);
  });
});

describe('facturas recurrentes', () => {
  const create = (c, patch = {}) =>
    post(c, '/recurring-invoices', { name: 'Mantenimiento mensual', customerId: c.customer, frequency: 'monthly', startDate: iso(-70), paymentMethod: 'credit', dueDays: 30, lines: saleLines(), ...patch });
  const run = (c, body) => post(c, '/recurring-invoices/run', body);

  it('genera una factura por cada período vencido, con su fecha y su plazo, y no repite', async () => {
    const c = await company();
    const created = await create(c);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ active: true, runCount: 0, totals: { total: 1_190_000 } });
    const result = await run(c);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().failed).toEqual([]);
    expect(result.json().generated).toHaveLength(3);
    expect(result.json().generated.map((g) => g.date)).toEqual([iso(-70), expect.any(String), expect.any(String)]);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(3);
    const template = (await get(c, `/recurring-invoices/${created.json()._id}`)).json();
    expect(template.runCount).toBe(3);
    expect(template.lastRun.number).toMatch(/^FE/);
    expect(template.nextDate.slice(0, 10) > iso(0)).toBe(true);
    const first = (await get(c, '/invoices')).json().items.find((i) => i.issueDate.slice(0, 10) === iso(-70));
    expect(first).toMatchObject({ paymentMethod: 'credit', balance: 1_190_000 });
    expect(first.dueDate.slice(0, 10)).toBe(new Date(Date.parse(`${iso(-70)}T12:00:00Z`) + 30 * DAY_MS).toISOString().slice(0, 10));
    expect(first.notes).toBe('Mantenimiento mensual');
    expect((await run(c)).json().generated).toEqual([]);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(3);
  });

  it('dos generaciones a la vez emiten cada período una sola vez', async () => {
    const c = await company();
    await create(c);
    const results = await Promise.all([run(c), run(c), run(c)]);
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(3);
    expect((await get(c, '/recurring-invoices')).json().items[0].runCount).toBe(3);
  });

  it('si la plantilla se atrasó tras emitir, volver a generar reconoce las facturas ya emitidas', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    await run(c);
    await db.collection(COLLECTIONS.recurringInvoices).updateOne({ _id: new ObjectId(id) }, { $set: { nextDate: new Date(`${iso(-70)}T12:00:00.000Z`) } });
    const again = await run(c);
    expect(again.json().generated).toHaveLength(3);
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(3);
  });

  it('respeta la fecha final y se desactiva al terminar', async () => {
    const c = await company();
    const id = (await create(c, { endDate: iso(-35) })).json()._id;
    const result = (await run(c)).json();
    expect(result.generated).toHaveLength(2); // -70 y -40; el de -10 pasa de la fecha final
    expect((await get(c, `/recurring-invoices/${id}`)).json()).toMatchObject({ active: false });
    expect(await countOf(c, COLLECTIONS.invoices)).toBe(2);
  });

  it('una plantilla pausada no genera; reanudarla sí', async () => {
    const c = await company();
    const id = (await create(c)).json()._id;
    expect((await call('PATCH', `${c.base}/recurring-invoices/${id}`, { cookie: c.cookie, body: { active: false } })).json().active).toBe(false);
    expect((await run(c)).json().generated).toEqual([]);
    await call('PATCH', `${c.base}/recurring-invoices/${id}`, { cookie: c.cookie, body: { active: true } });
    expect((await run(c, { templateId: id })).json().generated).toHaveLength(3);
    expect((await call('PATCH', `${c.base}/recurring-invoices/${id}`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);
  });

  it('una factura que falla detiene esa plantilla con su error; saltarla deja seguir', async () => {
    const c = await company();
    const id = (await create(c, { startDate: iso(-35), frequency: 'monthly' })).json()._id;
    await db.collection(COLLECTIONS.parties).updateOne({ _id: new ObjectId(c.customer) }, { $set: { active: false } });
    const result = (await run(c)).json();
    expect(result.generated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: 'Mantenimiento mensual', date: iso(-35) });
    const stuck = (await get(c, `/recurring-invoices/${id}`)).json();
    expect(stuck.lastError.message).toMatch(/inactivo/);
    expect(stuck.nextDate.slice(0, 10)).toBe(iso(-35));
    // Saltarla avanza un período sin emitir.
    const skipped = await post(c, `/recurring-invoices/${id}/skip`);
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().nextDate.slice(0, 10)).not.toBe(iso(-35));
    expect(skipped.json().lastError).toBeUndefined();
    await db.collection(COLLECTIONS.parties).updateOne({ _id: new ObjectId(c.customer) }, { $set: { active: true } });
    expect((await run(c)).json().generated).toHaveLength(1);
  });

  it('valida la plantilla', async () => {
    const c = await company();
    expect((await create(c, { frequency: 'daily' })).statusCode).toBe(400);
    expect((await create(c, { dueDays: 0 })).statusCode).toBe(400); // crédito sin plazo
    expect((await create(c, { endDate: iso(-100) })).statusCode).toBe(400);
    expect((await create(c, { customerId: c.supplier })).statusCode).toBe(400);
    expect((await create(c, { lines: [] })).statusCode).toBe(400);
    expect((await create(c, { paymentMethod: 'cash', dueDays: 0 })).statusCode).toBe(201);
    expect((await run(c, { asOf: iso(5) })).statusCode).toBe(400);
  });

  it('el contador genera; el lector solo ve; otra empresa no ve nada', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const id = (await create(a)).json()._id;
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    expect((await call('GET', `${a.base}/recurring-invoices`, { cookie: viewer })).statusCode).toBe(200);
    expect((await post(a, '/recurring-invoices/run', undefined, viewer)).statusCode).toBe(403);
    expect((await get(b, `/recurring-invoices/${id}`)).statusCode).toBe(404);
    expect((await run(b)).json().generated).toEqual([]);
  });
});
