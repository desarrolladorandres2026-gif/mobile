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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `pos-${(counter += 1)}-aaaaaaaa` : key } : {}) },
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
  await make({ code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
  await make({ code: '112005', name: 'Datáfono por cobrar', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '429595', name: 'Sobrantes de caja', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '530595', name: 'Faltantes de caja', type: 'expense', parentCode: '5' });
  const saved = await call('PUT', `${base}/invoicing/settings`, {
    cookie,
    body: {
      issuer: { name: name, taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return { cookie, base };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const newRegister = async (c, patch = {}) => {
  const res = await call('POST', `${c.base}/pos/registers`, { cookie: c.cookie, body: { code: 'caja1', name: 'Mostrador', accounts: { cash: '110505', card: '112005' }, ...patch } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const saleBody = (register, patch = {}) => ({
  registerId: register._id,
  date: TODAY,
  lines: [{ description: 'Servicio de armado', quantity: 1000, unitPrice: 10_000, vatBps: 1900 }],
  payments: [{ method: 'cash', amount: 11_900 }],
  ...patch,
});

beforeAll(async () => {
  mongo = await startMongo('lulubiz_pos_http_test');
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

describe('punto de venta por la API', () => {
  it('cajas: crea, valida, no repite códigos, edita y lista con su turno abierto', async () => {
    const c = await company();
    const register = await newRegister(c);
    expect(register).toMatchObject({ code: 'CAJA1', active: true, accounts: { cash: '110505', card: '112005' } });
    const post = (body) => call('POST', `${c.base}/pos/registers`, { cookie: c.cookie, body });
    expect((await post({ code: 'CAJA1', name: 'Otra', accounts: { cash: '110505' } })).json().error).toBe('DUPLICATE');
    expect((await post({ code: 'X', name: 'Sin efectivo', accounts: { card: '112005' } })).statusCode).toBe(400);
    expect((await post({ code: 'X', name: 'Mala', accounts: { cash: '413505' } })).statusCode).toBe(400);
    expect((await post({ code: 'X', name: 'Extra', accounts: { cash: '110505' }, extra: 1 })).statusCode).toBe(400);

    const patched = await call('PATCH', `${c.base}/pos/registers/${register._id}`, { cookie: c.cookie, body: { name: 'Mostrador 1' } });
    expect(patched.json().name).toBe('Mostrador 1');
    expect((await call('PATCH', `${c.base}/pos/registers/${register._id}`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);

    const shift = await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: c.cookie, body: { openingCash: 50_000 } });
    expect(shift.statusCode, shift.body).toBe(201);
    const list = (await call('GET', `${c.base}/pos/registers`, { cookie: c.cookie })).json().items;
    expect(list[0].openShift._id).toBe(shift.json()._id);
    const blocked = await call('PATCH', `${c.base}/pos/registers/${register._id}`, { cookie: c.cookie, body: { active: false } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('SHIFT_OPEN');
  });

  it('recorrido: abrir turno, vender, anular, cerrar con faltante y consultar', async () => {
    const c = await company();
    const register = await newRegister(c);
    const noShift = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key: true, body: saleBody(register) });
    expect(noShift.statusCode).toBe(409);
    expect(noShift.json().error).toBe('NO_SHIFT');

    const shift = (await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: c.cookie, body: { openingCash: 50_000 } })).json();
    const again = await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: c.cookie, body: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('SHIFT_OPEN');

    const key = 'venta-1-aaaaaaaa';
    const first = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key, body: saleBody(register, { cashTendered: 20_000 }) });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().sale).toMatchObject({ fullNumber: 'CAJA1-000001', totals: { total: 11_900 }, change: 8_100 });
    const replay = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key, body: saleBody(register, { cashTendered: 20_000 }) });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);

    const mixed = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key: true, body: saleBody(register, { payments: [{ method: 'cash', amount: 5_000 }, { method: 'card', amount: 6_900 }] }) });
    expect(mixed.statusCode, mixed.body).toBe(201);
    const wrong = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key: true, body: saleBody(register, { payments: [{ method: 'cash', amount: 1_000 }] }) });
    expect(wrong.statusCode).toBe(400);
    const noTransfer = await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key: true, body: saleBody(register, { payments: [{ method: 'transfer', amount: 11_900 }] }) });
    expect(noTransfer.statusCode).toBe(400);

    const live = (await call('GET', `${c.base}/pos/shifts/${shift._id}`, { cookie: c.cookie })).json();
    expect(live).toMatchObject({ salesCount: 2, salesTotal: 23_800, cashTotal: 16_900, cardTotal: 6_900, expectedCash: 66_900 });

    const voided = await call('POST', `${c.base}/pos/sales/${mixed.json().sale._id}/void`, { cookie: c.cookie, body: { reason: 'Cliente se arrepintió' } });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().sale.status).toBe('void');
    expect((await call('POST', `${c.base}/pos/sales/${mixed.json().sale._id}/void`, { cookie: c.cookie, body: {} })).statusCode).toBe(400); // exige motivo

    const sales = (await call('GET', `${c.base}/pos/sales?shiftId=${shift._id}`, { cookie: c.cookie })).json();
    expect(sales.items.map((s) => s.status)).toEqual(['void', 'posted']);
    expect((await call('GET', `${c.base}/pos/sales?status=posted`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/pos/sales/${first.json().sale._id}`, { cookie: c.cookie })).json().fullNumber).toBe('CAJA1-000001');

    const noAccount = await call('POST', `${c.base}/pos/shifts/${shift._id}/close`, { cookie: c.cookie, body: { countedCash: 60_000, date: TODAY } });
    expect(noAccount.statusCode).toBe(400);
    const closed = await call('POST', `${c.base}/pos/shifts/${shift._id}/close`, { cookie: c.cookie, body: { countedCash: 60_000, counterAccount: '530595', date: TODAY } });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().shift).toMatchObject({ status: 'closed', expectedCash: 61_900, countedCash: 60_000, difference: -1_900, voidedCount: 1 });
    const afterClose = await call('POST', `${c.base}/pos/sales/${first.json().sale._id}/void`, { cookie: c.cookie, body: { reason: 'tarde' } });
    expect(afterClose.statusCode).toBe(409);
    expect(afterClose.json().error).toBe('SHIFT_CLOSED');
    expect((await call('GET', `${c.base}/pos/shifts?status=closed`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/pos/shifts/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${c.base}/pos/sales/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);

    // Los asientos quedaron en el libro con sus tipos.
    const journals = (await call('GET', `${c.base}/journals`, { cookie: c.cookie })).json().items;
    expect(journals.map((j) => j.docType).sort()).toEqual(['CJ', 'PV', 'PV', 'PV']);
  });

  it('el cajero abre, vende y cierra, pero no anula ni configura; el lector solo consulta', async () => {
    const c = await company();
    const register = await newRegister(c, { accounts: { cash: '110505', card: '112005', shortage: '530595', surplus: '429595' } });
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');

    expect((await call('GET', `${c.base}/pos/registers`, { cookie: cashier })).statusCode).toBe(200);
    const shift = await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: cashier, body: { openingCash: 10_000 } });
    expect(shift.statusCode, shift.body).toBe(201);
    const sale = await call('POST', `${c.base}/pos/sales`, { cookie: cashier, key: true, body: saleBody(register) });
    expect(sale.statusCode, sale.body).toBe(201);

    expect((await call('POST', `${c.base}/pos/sales/${sale.json().sale._id}/void`, { cookie: cashier, body: { reason: 'x' } })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/pos/registers`, { cookie: cashier, body: { code: 'C2', name: 'x', accounts: { cash: '110505' } } })).statusCode).toBe(403);
    expect((await call('PATCH', `${c.base}/pos/registers/${register._id}`, { cookie: cashier, body: { name: 'x' } })).statusCode).toBe(403);
    // El cajero no ve la contabilidad.
    expect((await call('GET', `${c.base}/journals`, { cookie: cashier })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/reports/trial-balance?from=2026-01&to=2026-12&currency=COP`, { cookie: cashier })).statusCode).toBe(403);

    // Elegir la cuenta de la diferencia no es del cajero: con la de la caja cierra, con otra no.
    const choosing = await call('POST', `${c.base}/pos/shifts/${shift.json()._id}/close`, { cookie: cashier, body: { countedCash: 20_000, counterAccount: '429595', date: TODAY } });
    expect(choosing.statusCode).toBe(403);
    const closed = await call('POST', `${c.base}/pos/shifts/${shift.json()._id}/close`, { cookie: cashier, body: { countedCash: 20_000, date: TODAY } });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().shift).toMatchObject({ expectedCash: 21_900, difference: -1_900 });

    expect((await call('GET', `${c.base}/pos/sales`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/pos/shifts`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: viewer, body: {} })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/pos/sales`, { cookie: viewer, key: true, body: saleBody(register) })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/pos/registers`)).statusCode).toBe(401);
  });

  it('valida el cuerpo y exige clave de idempotencia', async () => {
    const c = await company();
    const register = await newRegister(c);
    await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: c.cookie, body: {} });
    const post = (body, key = true) => call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key, body });
    expect((await post(saleBody(register), false)).statusCode).toBe(400);
    expect((await post(saleBody(register, { lines: [] }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { payments: [] }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { payments: [{ method: 'cash', amount: 0 }] }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { extra: 1 }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { registerId: 'nope' }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { date: '2026-13-40' }))).statusCode).toBe(400);
    expect((await post(saleBody(register, { registerId: 'a'.repeat(24) }))).statusCode).toBe(404);
  });

  it('una empresa no ve ni toca las cajas, turnos y ventas de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const register = await newRegister(a);
    const shift = (await call('POST', `${a.base}/pos/registers/${register._id}/shifts`, { cookie: a.cookie, body: {} })).json();
    const sale = (await call('POST', `${a.base}/pos/sales`, { cookie: a.cookie, key: true, body: saleBody(register) })).json().sale;

    expect((await call('GET', `${a.base}/pos/registers`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/pos/sales`, { cookie: b.cookie, key: true, body: saleBody(register) })).statusCode).toBe(403);
    expect((await call('GET', `${b.base}/pos/registers`, { cookie: b.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${b.base}/pos/shifts/${shift._id}`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${b.base}/pos/sales/${sale._id}`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('POST', `${b.base}/pos/sales`, { cookie: b.cookie, key: true, body: saleBody(register) })).statusCode).toBe(404);
    expect((await call('POST', `${b.base}/pos/sales/${sale._id}/void`, { cookie: b.cookie, body: { reason: 'x' } })).statusCode).toBe(404);
    expect((await call('POST', `${b.base}/pos/shifts/${shift._id}/close`, { cookie: b.cookie, body: { countedCash: 0, date: TODAY } })).statusCode).toBe(404);
    expect((await call('GET', `${b.base}/pos/sales`, { cookie: b.cookie })).json().items).toHaveLength(0);
  });
});
