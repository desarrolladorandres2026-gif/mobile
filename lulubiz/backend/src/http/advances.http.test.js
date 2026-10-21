import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const DAY_MS = 86_400_000;
const iso = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const TODAY = iso(0);
const YESTERDAY = iso(-1);
const YEAR = new Date().getUTCFullYear();

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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `adv-${(counter += 1)}-aaaaaaaa` : key } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

const ACCOUNTS = { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', cash: '110505', customerAdvance: '280505', supplierAdvance: '133005' };

async function company(name = 'Andina SAS', email = 'ana@andina.co', accounts = ACCOUNTS) {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = await login(email);
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const c = { cookie, base };
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '111005', name: 'Bancos', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '133005', name: 'Anticipos a proveedores', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '280505', name: 'Anticipos de clientes', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  const saved = await call('PUT', `${base}/invoicing/settings`, {
    cookie,
    body: {
      issuer: { name, taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
      accounts,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    expect((await call('POST', `${base}/invoicing/resolutions`, { cookie, body: { docType, prefix, number: '18760000001', from: 1, to: 100, validFrom: `${YEAR - 1}-01-01`, validTo: `${YEAR + 1}-12-31` } })).statusCode).toBe(201);
  }
  const party = async (name2, roles, taxId, checkDigit) => (await call('POST', `${base}/parties`, { cookie, body: { name: name2, roles, taxIdType: 'NIT', taxId, checkDigit } })).json()._id;
  c.cust1 = await party('Droguería Los Andes', ['customer'], '800197268', 4);
  c.cust2 = await party('Papelería Central', ['customer'], '800250119', 1);
  c.supplier = await party('Aseo Total SAS', ['supplier'], '900123456', 8);
  return c;
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const invoice = async (c, customerId, method = 'credit', price = 1_000_000) =>
  (await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: { customerId, issueDate: YESTERDAY, paymentMethod: method, ...(method === 'credit' ? { dueDate: iso(30) } : {}), lines: [{ description: 'Mercancía', quantity: 1000, unitPrice: price, vatBps: 1900 }] } })).json().invoice;
const purchase = async (c, price = 1_000_000) =>
  (await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: { supplierId: c.supplier, supplierDocNumber: `SA-${(counter += 1)}`, issueDate: YESTERDAY, lines: [{ description: 'Aseo', quantity: 1000, unitPrice: price, vatBps: 1900, accountId: '519595' }] } })).json().purchase;
const advance = async (c, patch = {}) => {
  const res = await call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, amount: 500_000, account: '110505', ...patch } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().advance;
};
const supplierAdvance = async (c, patch = {}) => {
  const res = await call('POST', `${c.base}/supplier-advances`, { cookie: c.cookie, key: true, body: { partyId: c.supplier, date: TODAY, amount: 400_000, account: '110505', ...patch } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().advance;
};
const applyTo = (c, path, id, allocations, key = true, cookie = c.cookie) => call('POST', `${c.base}/${path}/${id}/applications`, { cookie, key, body: { date: TODAY, allocations } });
const net = async (c, account) => {
  // Los documentos van de ayer y hoy: pueden caer en meses distintos.
  let total = 0;
  for (const period of new Set([YESTERDAY.slice(0, 7), TODAY.slice(0, 7)])) {
    const res = await call('GET', `${c.base}/balances?account=${account}&period=${period}&currency=COP`, { cookie: c.cookie });
    expect(res.statusCode, res.body).toBe(200);
    total += res.json().debit - res.json().credit;
  }
  return total;
};
const journalOf = async (id) => (await call('GET', `${id.base}/journals/${id.id}`, { cookie: id.cookie })).json();
const statement = async (c, path, partyId) =>
  (await call('GET', `${c.base}/reports/${path}?${new URLSearchParams({ from: `${YEAR}-01-01`, to: TODAY, currency: 'COP', partyId })}`, { cookie: c.cookie })).json();

beforeAll(async () => {
  mongo = await startMongo('lulubiz_advances_http_test');
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

describe('anticipo de cliente', () => {
  it('se registra como recibo de caja contra la cuenta de anticipos recibidos, y repetir la clave no lo duplica', async () => {
    const c = await company();
    const key = 'anticipo-1-aaaaaaaa';
    const first = await call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, key, body: { partyId: c.cust1, date: TODAY, amount: 500_000, account: '110505', notes: 'Pedido 77' } });
    expect(first.statusCode, first.body).toBe(201);
    const adv = first.json().advance;
    expect(adv).toMatchObject({ kind: 'customer', fullNumber: 'RC1', status: 'posted', amount: 500_000, applied: 0, balance: 500_000, party: { name: 'Droguería Los Andes' }, advanceAccount: '280505', account: '110505', notes: 'Pedido 77' });
    const journal = await journalOf({ base: c.base, id: adv.journalId, cookie: c.cookie });
    expect(journal).toMatchObject({ docType: 'RC', totalDebit: 500_000, source: { kind: 'customer_advance' } });
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '110505', debit: 500_000 }), expect.objectContaining({ accountId: '280505', credit: 500_000 })]));

    const again = await call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, key, body: { partyId: c.cust1, date: TODAY, amount: 500_000, account: '110505' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect((await call('GET', `${c.base}/customer-advances`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/customer-advances/${adv._id}`, { cookie: c.cookie })).json()).toMatchObject({ fullNumber: 'RC1', applications: [] });
  });

  it('valida la configuración, el tercero, la cuenta, el importe y la fecha', async () => {
    const c = await company();
    const post = (body) => call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, amount: 100_000, account: '110505', ...body } });
    expect((await post({ partyId: c.supplier })).statusCode).toBe(400);
    expect((await post({ partyId: 'a'.repeat(24) })).statusCode).toBe(404);
    expect((await post({ amount: 0 })).statusCode).toBe(400);
    expect((await post({ amount: 1.5 })).statusCode).toBe(400);
    expect((await post({ account: '413505' })).statusCode).toBe(400); // ingresos: no es caja ni bancos
    expect((await post({ account: '280505' })).statusCode).toBe(400); // la misma de anticipos
    expect((await post({ account: '999999' })).statusCode).toBe(400);
    expect((await post({ date: '2999-01-01' })).statusCode).toBe(400);
    expect((await post({ extra: 1 })).statusCode).toBe(400);
    expect((await call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, body: { partyId: c.cust1, date: TODAY, amount: 1, account: '110505' } })).statusCode).toBe(400); // sin clave

    const bare = await company('Boreal SAS', 'bea@boreal.co', { receivable: '130505', income: '413505', vatPayable: '240805' });
    const res = await call('POST', `${bare.base}/customer-advances`, { cookie: bare.cookie, key: true, body: { partyId: bare.cust1, date: TODAY, amount: 100_000, account: '110505' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SETTINGS_INCOMPLETE');

    const wrongType = await company('Cima SAS', 'cima@cima.co', { ...ACCOUNTS, customerAdvance: '133005' }); // un activo no sirve para anticipos recibidos
    const bad = await call('POST', `${wrongType.base}/customer-advances`, { cookie: wrongType.cookie, key: true, body: { partyId: wrongType.cust1, date: TODAY, amount: 100_000, account: '110505' } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().message).toMatch(/pasivo/);
  });

  it('se aplica a una factura a crédito: baja su saldo y el del anticipo, sin mover dinero', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    const cashBefore = await net(c, '110505');
    const res = await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 300_000 }], 'aplica-1-aaaaaaaa');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().application).toMatchObject({ fullNumber: 'AA1', total: 300_000, allocations: [{ fullNumber: inv.fullNumber, amount: 300_000 }] });
    expect(res.json().advance).toMatchObject({ applied: 300_000, balance: 200_000 });
    const journal = await journalOf({ base: c.base, id: res.json().application.journalId, cookie: c.cookie });
    expect(journal).toMatchObject({ docType: 'AA', totalDebit: 300_000 });
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '280505', debit: 300_000 }), expect.objectContaining({ accountId: '130505', credit: 300_000 })]));
    expect((await call('GET', `${c.base}/invoices/${inv._id}`, { cookie: c.cookie })).json()).toMatchObject({ paidTotal: 300_000, balance: 1_190_000 - 300_000 });
    expect(await net(c, '110505')).toBe(cashBefore); // no entra ni sale dinero
    expect(await net(c, '280505')).toBe(-200_000);

    const again = await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 300_000 }], 'aplica-1-aaaaaaaa');
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect((await call('GET', `${c.base}/customer-advances/${adv._id}`, { cookie: c.cookie })).json()).toMatchObject({ balance: 200_000, applications: [{ fullNumber: 'AA1' }] });
  });

  it('un anticipo se agota en varias aplicaciones y a varias facturas, y no se pasa de su saldo ni del de la factura', async () => {
    const c = await company();
    const a = await invoice(c, c.cust1);
    const b = await invoice(c, c.cust1, 'credit', 200_000);
    const adv = await advance(c, { amount: 1_000_000 });
    expect((await applyTo(c, 'customer-advances', adv._id, [{ documentId: a._id, amount: 700_000 }, { documentId: b._id, amount: 100_000 }])).statusCode).toBe(201);
    expect((await applyTo(c, 'customer-advances', adv._id, [{ documentId: a._id, amount: 200_000 }])).statusCode).toBe(201);
    // Ya no queda anticipo: 1.000.000 − 700.000 − 100.000 − 200.000 = 0.
    const empty = await applyTo(c, 'customer-advances', adv._id, [{ documentId: a._id, amount: 1 }]);
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe('OVER_PAYMENT');
    expect((await call('GET', `${c.base}/customer-advances?open=true`, { cookie: c.cookie })).json().items).toHaveLength(0);
    // Más que lo que debe la factura.
    const big = await advance(c, { amount: 5_000_000 });
    const over = await applyTo(c, 'customer-advances', big._id, [{ documentId: b._id, amount: 200_000 }]);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('OVER_PAYMENT');
  });

  it('rechaza facturas de contado, de otro cliente, repetidas o inexistentes, y fechas anteriores', async () => {
    const c = await company();
    const credit = await invoice(c, c.cust1);
    const cash = await invoice(c, c.cust1, 'cash');
    const other = await invoice(c, c.cust2);
    const adv = await advance(c);
    const apply = (allocations, date = TODAY) => call('POST', `${c.base}/customer-advances/${adv._id}/applications`, { cookie: c.cookie, key: true, body: { date, allocations } });
    expect((await apply([{ documentId: cash._id, amount: 100 }])).statusCode).toBe(409);
    expect((await apply([{ documentId: other._id, amount: 100 }])).statusCode).toBe(400);
    expect((await apply([{ documentId: credit._id, amount: 100 }, { documentId: credit._id, amount: 100 }])).statusCode).toBe(400);
    expect((await apply([{ documentId: 'a'.repeat(24), amount: 100 }])).statusCode).toBe(404);
    expect((await apply([{ documentId: credit._id, amount: 100 }], iso(-3))).statusCode).toBe(400); // antes del anticipo
    expect((await apply([])).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/customer-advances/${adv._id}`, { cookie: c.cookie })).json().balance).toBe(500_000);
  });

  it('dos aplicaciones simultáneas del mismo dinero: una sola pasa y nada queda en negativo', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    const results = await Promise.all([
      applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 300_000 }]),
      applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 300_000 }]),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await call('GET', `${c.base}/customer-advances/${adv._id}`, { cookie: c.cookie })).json()).toMatchObject({ applied: 300_000, balance: 200_000 });
    expect((await call('GET', `${c.base}/invoices/${inv._id}`, { cookie: c.cookie })).json().balance).toBe(890_000);
  });

  it('anular una aplicación devuelve los saldos; el anticipo se anula solo sin aplicaciones vigentes', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    const applied = (await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 500_000 }])).json().application;

    const blocked = await call('POST', `${c.base}/customer-advances/${adv._id}/void`, { cookie: c.cookie });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/aplicaciones/);

    const undone = await call('POST', `${c.base}/customer-advances/applications/${applied._id}/void`, { cookie: c.cookie });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().application.status).toBe('void');
    expect((await call('GET', `${c.base}/invoices/${inv._id}`, { cookie: c.cookie })).json().balance).toBe(1_190_000);
    expect((await call('GET', `${c.base}/customer-advances/${adv._id}`, { cookie: c.cookie })).json()).toMatchObject({ applied: 0, balance: 500_000 });
    expect((await call('POST', `${c.base}/customer-advances/applications/${applied._id}/void`, { cookie: c.cookie })).json().replayed).toBe(true);

    const voided = await call('POST', `${c.base}/customer-advances/${adv._id}/void`, { cookie: c.cookie });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().advance).toMatchObject({ status: 'void', balance: 0 });
    expect(await net(c, '280505')).toBe(0);
    expect((await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 100 }])).statusCode).toBe(409);
    expect((await call('GET', `${c.base}/customer-advances?open=true`, { cookie: c.cookie })).json().items).toHaveLength(0);
  });

  it('el estado de cuenta del cliente cuenta el anticipo, y aplicarlo no lo cuenta dos veces', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    let st = await statement(c, 'customer-statement', c.cust1);
    expect(st.rows.map((r) => [r.kind, r.debit, r.credit, r.balance])).toEqual([['invoice', 1_190_000, 0, 1_190_000], ['advance', 0, 500_000, 690_000]]);
    expect(st.closing).toBe(690_000);
    await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 300_000 }]);
    st = await statement(c, 'customer-statement', c.cust1);
    // Lo que debe de verdad (la factura) menos el anticipo que todavía no se ha usado.
    const balance = (await call('GET', `${c.base}/invoices/${inv._id}`, { cookie: c.cookie })).json().balance;
    expect(st.closing).toBe(balance - 200_000);
    expect(st.rows).toHaveLength(2);
  });

  it('antes de ver un anticipo sin saldo en el estado de otro cliente: no aparece', async () => {
    const c = await company();
    await advance(c);
    expect((await statement(c, 'customer-statement', c.cust2)).rows).toEqual([]);
  });
});

describe('anticipo a proveedor', () => {
  it('se registra como comprobante de egreso y se aplica a una compra: baja lo que se le debe sin mover dinero', async () => {
    const c = await company();
    const pur = await purchase(c);
    const adv = await supplierAdvance(c);
    expect(adv).toMatchObject({ kind: 'supplier', fullNumber: 'CE1', balance: 400_000, advanceAccount: '133005' });
    const created = await journalOf({ base: c.base, id: adv.journalId, cookie: c.cookie });
    expect(created).toMatchObject({ docType: 'CE', totalDebit: 400_000 });
    expect(created.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '133005', debit: 400_000 }), expect.objectContaining({ accountId: '110505', credit: 400_000 })]));

    const cashBefore = await net(c, '110505');
    const res = await applyTo(c, 'supplier-advances', adv._id, [{ documentId: pur._id, amount: 250_000 }]);
    expect(res.statusCode, res.body).toBe(201);
    const journal = await journalOf({ base: c.base, id: res.json().application.journalId, cookie: c.cookie });
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '220505', debit: 250_000 }), expect.objectContaining({ accountId: '133005', credit: 250_000 })]));
    expect((await call('GET', `${c.base}/purchases/${pur._id}`, { cookie: c.cookie })).json()).toMatchObject({ paidTotal: 250_000, balance: pur.payable - 250_000 });
    expect(await net(c, '110505')).toBe(cashBefore);
    expect(await net(c, '133005')).toBe(150_000);

    const st = await statement(c, 'supplier-statement', c.supplier);
    expect(st.rows.map((r) => r.kind)).toEqual(['purchase', 'advance']);
    expect(st.closing).toBe(pur.payable - 400_000);
  });

  it('no se aplica a compras anuladas ni a más de lo que se debe, y se anula igual que el de cliente', async () => {
    const c = await company();
    const live = await purchase(c, 100_000);
    const dead = await purchase(c, 100_000);
    await call('POST', `${c.base}/purchases/${dead._id}/void`, { cookie: c.cookie });
    const adv = await supplierAdvance(c, { amount: 1_000_000 });
    expect((await applyTo(c, 'supplier-advances', adv._id, [{ documentId: dead._id, amount: 100 }])).statusCode).toBe(409);
    expect((await applyTo(c, 'supplier-advances', adv._id, [{ documentId: live._id, amount: 999_999 }])).json().error).toBe('OVER_PAYMENT');
    const done = (await applyTo(c, 'supplier-advances', adv._id, [{ documentId: live._id, amount: 119_000 }])).json().application;
    expect((await call('GET', `${c.base}/purchases/${live._id}`, { cookie: c.cookie })).json().balance).toBe(0);
    expect((await call('POST', `${c.base}/supplier-advances/applications/${done._id}/void`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/purchases/${live._id}`, { cookie: c.cookie })).json().balance).toBe(119_000);
    expect((await call('POST', `${c.base}/supplier-advances/${adv._id}/void`, { cookie: c.cookie })).statusCode).toBe(200);
    expect(await net(c, '133005')).toBe(0);
  });

  it('un anticipo de cliente no se aplica por la ruta de proveedores ni al revés', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    expect((await call('GET', `${c.base}/supplier-advances/${adv._id}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await applyTo(c, 'supplier-advances', adv._id, [{ documentId: inv._id, amount: 100 }])).statusCode).toBe(404);
    expect((await call('POST', `${c.base}/supplier-advances/${adv._id}/void`, { cookie: c.cookie })).statusCode).toBe(404);
  });
});

describe('permisos y aislamiento', () => {
  it('el lector consulta; el contador registra y aplica; el cajero no ve ni toca; sin sesión nada', async () => {
    const c = await company();
    const inv = await invoice(c, c.cust1);
    const adv = await advance(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    const body = { partyId: c.cust1, date: TODAY, amount: 100_000, account: '110505' };
    expect((await call('GET', `${c.base}/customer-advances`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/supplier-advances`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/customer-advances`, { cookie: viewer, key: true, body })).statusCode).toBe(403);
    expect((await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 100 }], true, viewer)).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/customer-advances/${adv._id}/void`, { cookie: viewer })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/customer-advances`, { cookie: accountant, key: true, body })).statusCode).toBe(201);
    expect((await applyTo(c, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 100 }], true, accountant)).statusCode).toBe(201);
    expect((await call('GET', `${c.base}/customer-advances`, { cookie: cashier })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/customer-advances`, { cookie: cashier, key: true, body })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/customer-advances`)).statusCode).toBe(401);
  });

  it('una empresa no ve ni usa los anticipos ni las facturas de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const inv = await invoice(a, a.cust1);
    const adv = await advance(a);
    expect((await call('GET', `${b.base}/customer-advances`, { cookie: b.cookie })).json().items).toEqual([]);
    expect((await call('GET', `${b.base}/customer-advances/${adv._id}`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await applyTo(b, 'customer-advances', adv._id, [{ documentId: inv._id, amount: 100 }], true, b.cookie)).statusCode).toBe(404);
    expect((await call('POST', `${b.base}/customer-advances/${adv._id}/void`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${a.base}/customer-advances`, { cookie: b.cookie })).statusCode).toBe(403);
  });
});
