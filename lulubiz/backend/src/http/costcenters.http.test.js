import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
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
const MONTHS = [...new Set([YESTERDAY.slice(0, 7), TODAY.slice(0, 7)])].sort();

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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `cc-${(counter += 1)}-aaaaaaaa` : key } : {}) },
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
  const c = { cookie, base, tenantId: reg.json().tenantId };
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '130510', name: 'Deudores varios', type: 'asset', parentCode: '1' }); // no es cuenta de control: admite asientos manuales
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '280505', name: 'Anticipos de clientes', type: 'liability', parentCode: '2' });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '510506', name: 'Sueldos', type: 'expense', parentCode: '5' });
  await make({ code: '519595', name: 'Gastos diversos', type: 'expense', parentCode: '5' });
  await make({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await make({ code: '360505', name: 'Utilidad del ejercicio', type: 'equity', parentCode: '3' });
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

const center = async (c, code, name = `Centro ${code}`) => {
  const res = await call('POST', `${c.base}/cost-centers`, { cookie: c.cookie, body: { code, name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const journal = (c, lines, date = YESTERDAY, key = true) => call('POST', `${c.base}/journals`, { cookie: c.cookie, key, body: { docType: 'AJ', date: `${date}T12:00:00Z`, currency: 'COP', lines } });
const invoice = async (c, customerId, lines, method = 'credit') =>
  (await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: { customerId, issueDate: YESTERDAY, paymentMethod: method, ...(method === 'credit' ? { dueDate: iso(30) } : {}), lines } })).json();
const line = (price, extra = {}) => ({ description: 'Mercancía', quantity: 1000, unitPrice: price, vatBps: 1900, ...extra });
const dims = async (c, dimension, key, account, period) => {
  const doc = await db.collection(COLLECTIONS.dimBalances).findOne({ tenantId: new ObjectId(c.tenantId), dimension, key, accountId: account, period });
  return doc ? { debit: doc.debit, credit: doc.credit } : { debit: 0, credit: 0 };
};
const report = (c, path, query, cookie = c.cookie) => call('GET', `${c.base}/reports/${path}?${new URLSearchParams(query)}`, { cookie });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_costcenters_http_test');
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

describe('centros de costo', () => {
  it('se crean con código en mayúsculas, no se repiten, se editan y se desactivan', async () => {
    const c = await company();
    const created = await center(c, 'sede1', 'Sede Garzón');
    expect(created).toMatchObject({ code: 'SEDE1', name: 'Sede Garzón', active: true });
    const dup = await call('POST', `${c.base}/cost-centers`, { cookie: c.cookie, body: { code: 'SEDE1', name: 'Otra' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('DUPLICATE');
    for (const bad of [{ code: 'con espacio', name: 'x' }, { code: 'X', name: ' ' }, { code: 'X'.repeat(11), name: 'x' }, { code: 'A', name: 'x', extra: 1 }]) {
      expect((await call('POST', `${c.base}/cost-centers`, { cookie: c.cookie, body: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    await center(c, 'SEDE2');
    expect((await call('PATCH', `${c.base}/cost-centers/sede1`, { cookie: c.cookie, body: { name: 'Sede principal' } })).json().name).toBe('Sede principal');
    expect((await call('PATCH', `${c.base}/cost-centers/SEDE2`, { cookie: c.cookie, body: { active: false } })).json().active).toBe(false);
    expect((await call('GET', `${c.base}/cost-centers`, { cookie: c.cookie })).json().items.map((x) => x.code)).toEqual(['SEDE1', 'SEDE2']);
    expect((await call('GET', `${c.base}/cost-centers?activeOnly=true`, { cookie: c.cookie })).json().items.map((x) => x.code)).toEqual(['SEDE1']);
    expect((await call('PATCH', `${c.base}/cost-centers/NOPE`, { cookie: c.cookie, body: { name: 'x' } })).statusCode).toBe(404);
    expect((await call('PATCH', `${c.base}/cost-centers/SEDE1`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);
  });

  it('el lector ve los centros pero no los crea; el contador sí; una empresa no ve los de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await center(a, 'SEDE1');
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(a, 'contador@andina.co', 'accountant');
    expect((await call('GET', `${a.base}/cost-centers`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${a.base}/cost-centers`, { cookie: viewer, body: { code: 'X', name: 'x' } })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/cost-centers`, { cookie: accountant, body: { code: 'X', name: 'x' } })).statusCode).toBe(201);
    expect((await call('GET', `${b.base}/cost-centers`, { cookie: b.cookie })).json().items).toEqual([]);
    expect((await call('GET', `${a.base}/cost-centers`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('GET', `${a.base}/cost-centers`)).statusCode).toBe(401);
  });
});

describe('centro de costo y tercero en los asientos', () => {
  it('un asiento manual lleva el centro de costo en sus líneas y en sus saldos por dimensión', async () => {
    const c = await company();
    await center(c, 'SEDE1');
    const res = await journal(c, [{ accountId: '510506', debit: 300_000, costCenter: 'sede1' }, { accountId: '110505', credit: 300_000 }]);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().journal.lines[0]).toMatchObject({ accountId: '510506', debit: 300_000, costCenter: 'SEDE1' });
    expect(res.json().journal.lines[1].costCenter).toBeUndefined();
    expect(await dims(c, 'costCenter', 'SEDE1', '510506', YESTERDAY.slice(0, 7))).toEqual({ debit: 300_000, credit: 0 });
    expect(await dims(c, 'costCenter', 'SEDE1', '110505', YESTERDAY.slice(0, 7))).toEqual({ debit: 0, credit: 0 });
  });

  it('rechaza un centro que no existe, está inactivo o tiene un código inválido, sin dejar nada', async () => {
    const c = await company();
    await center(c, 'SEDE1');
    await call('PATCH', `${c.base}/cost-centers/SEDE1`, { cookie: c.cookie, body: { active: false } });
    const lines = (cc) => [{ accountId: '510506', debit: 100, costCenter: cc }, { accountId: '110505', credit: 100 }];
    expect((await journal(c, lines('NOPE'))).statusCode).toBe(422);
    expect((await journal(c, lines('SEDE1'))).statusCode).toBe(422); // inactivo
    expect((await journal(c, lines('con espacio'))).statusCode).toBe(400);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: new ObjectId(c.tenantId) })).toBe(0);
    expect(await db.collection(COLLECTIONS.dimBalances).countDocuments({ tenantId: new ObjectId(c.tenantId) })).toBe(0);
  });

  it('el tercero de una línea tiene que existir en la empresa', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const lines = (partyId) => [{ accountId: '130510', debit: 100, partyId }, { accountId: '413505', credit: 100 }];
    expect((await journal(a, lines(a.cust1))).statusCode).toBe(201);
    expect((await journal(a, lines('a'.repeat(24)))).statusCode).toBe(422);
    expect((await journal(a, lines(b.cust1))).statusCode).toBe(422); // de otra empresa
    expect((await journal(a, lines('nope'))).statusCode).toBe(400);
    expect(await dims(a, 'party', a.cust1, '130510', YESTERDAY.slice(0, 7))).toEqual({ debit: 100, credit: 0 });
  });

  it('reversar un asiento reversa también sus saldos por dimensión', async () => {
    const c = await company();
    await center(c, 'SEDE1');
    const res = await journal(c, [{ accountId: '510506', debit: 300_000, costCenter: 'SEDE1', partyId: c.supplier }, { accountId: '110505', credit: 300_000 }]);
    const id = res.json().journal._id;
    const reversed = await call('POST', `${c.base}/journals/${id}/reverse`, { cookie: c.cookie, key: true, body: { date: `${YESTERDAY}T12:00:00Z` } });
    expect(reversed.statusCode, reversed.body).toBe(201);
    expect(reversed.json().journal.lines[0]).toMatchObject({ costCenter: 'SEDE1', credit: 300_000 });
    const period = YESTERDAY.slice(0, 7);
    expect(await dims(c, 'costCenter', 'SEDE1', '510506', period)).toEqual({ debit: 300_000, credit: 300_000 });
    expect(await dims(c, 'party', c.supplier, '510506', period)).toEqual({ debit: 300_000, credit: 300_000 });
  });
});

describe('los documentos llevan el centro de costo y el tercero a su asiento', () => {
  it('una factura: ingresos por centro y el cliente en la cuenta por cobrar; la nota crédito lo mantiene', async () => {
    const c = await company();
    await center(c, 'NORTE');
    await center(c, 'SUR');
    const res = await invoice(c, c.cust1, [line(1_000_000, { costCenter: 'norte' }), line(500_000, { costCenter: 'SUR' }), line(100_000)]);
    expect(res.invoice.status, JSON.stringify(res)).toBe('issued');
    const journalDoc = (await call('GET', `${c.base}/journals/${res.invoice.accounting.journalId}`, { cookie: c.cookie })).json();
    const income = journalDoc.lines.filter((l) => l.accountId === '413505');
    expect(income.map((l) => [l.costCenter ?? null, l.credit]).sort()).toEqual([[null, 100_000], ['NORTE', 1_000_000], ['SUR', 500_000]].sort());
    expect(journalDoc.lines.find((l) => l.accountId === '130505')).toMatchObject({ debit: 1_904_000, partyId: c.cust1 });
    expect(journalDoc.lines.find((l) => l.accountId === '240805').partyId).toBeUndefined();

    const note = (await call('POST', `${c.base}/invoices/${res.invoice._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 500 }] } })).json().note;
    const noteJournal = (await call('GET', `${c.base}/journals/${note.accounting.journalId}`, { cookie: c.cookie })).json();
    expect(noteJournal.lines.find((l) => l.accountId === '413505')).toMatchObject({ debit: 500_000, costCenter: 'NORTE' });
    expect(noteJournal.lines.find((l) => l.accountId === '130505')).toMatchObject({ credit: 595_000, partyId: c.cust1 });
  });

  it('una factura con un centro que no existe se rechaza antes de gastar un número', async () => {
    const c = await company();
    const res = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: { customerId: c.cust1, issueDate: TODAY, paymentMethod: 'cash', lines: [line(1000, { costCenter: 'NOPE' })] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/NOPE/);
    expect((await call('GET', `${c.base}/invoices`, { cookie: c.cookie })).json().items).toEqual([]);
  });

  it('una compra, su nota, su pago y un recibo ponen el tercero en la cuenta correspondiente', async () => {
    const c = await company();
    await center(c, 'SEDE1');
    const purchase = (await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: { supplierId: c.supplier, supplierDocNumber: 'SA-1', issueDate: YESTERDAY, lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595', costCenter: 'SEDE1' }] } })).json().purchase;
    const doc = (await call('GET', `${c.base}/journals/${purchase.journalId}`, { cookie: c.cookie })).json();
    expect(doc.lines.find((l) => l.accountId === '519595')).toMatchObject({ debit: 1_000_000, costCenter: 'SEDE1' });
    expect(doc.lines.find((l) => l.accountId === '220505')).toMatchObject({ credit: 1_190_000, partyId: c.supplier });

    const note = (await call('POST', `${c.base}/purchases/${purchase._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reason: 'Devolución', supplierDocNumber: 'NC-1', lines: [{ lineIndex: 0, quantity: 500 }] } })).json().note;
    const noteDoc = (await call('GET', `${c.base}/journals/${note.journalId}`, { cookie: c.cookie })).json();
    expect(noteDoc.lines.find((l) => l.accountId === '519595')).toMatchObject({ credit: 500_000, costCenter: 'SEDE1' });
    expect(noteDoc.lines.find((l) => l.accountId === '220505')).toMatchObject({ debit: 595_000, partyId: c.supplier });

    const payment = (await call('POST', `${c.base}/payments`, { cookie: c.cookie, key: true, body: { partyId: c.supplier, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: purchase._id, amount: 100_000 }] } })).json().payment;
    expect((await call('GET', `${c.base}/journals/${payment.journalId}`, { cookie: c.cookie })).json().lines.find((l) => l.accountId === '220505')).toMatchObject({ debit: 100_000, partyId: c.supplier });

    const inv = (await invoice(c, c.cust1, [line(1_000_000)])).invoice;
    const receipt = (await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, depositAccount: '110505', allocations: [{ invoiceId: inv._id, amount: 200_000 }] } })).json().receipt;
    expect((await call('GET', `${c.base}/journals/${receipt.journalId}`, { cookie: c.cookie })).json().lines.find((l) => l.accountId === '130505')).toMatchObject({ credit: 200_000, partyId: c.cust1 });
  });

  it('un compra con un centro inactivo se rechaza', async () => {
    const c = await company();
    await center(c, 'SEDE1');
    await call('PATCH', `${c.base}/cost-centers/SEDE1`, { cookie: c.cookie, body: { active: false } });
    const res = await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: { supplierId: c.supplier, supplierDocNumber: 'SA-9', issueDate: YESTERDAY, lines: [{ description: 'x', quantity: 1000, unitPrice: 1000, vatBps: 0, accountId: '519595', costCenter: 'SEDE1' }] } });
    expect(res.statusCode).toBe(400);
  });

  it('una caja con centro de costo lo pone en los ingresos y el costo de sus ventas', async () => {
    const c = await company();
    await center(c, 'MOSTRADOR');
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '143505', name: 'Mercancías', type: 'asset', parentCode: '1' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '6', name: 'Costos', type: 'cost', postable: false } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '613505', name: 'Costo de ventas', type: 'cost', parentCode: '6' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '310505', name: 'Capital', type: 'equity', parentCode: '3' } });
    const item = (await call('POST', `${c.base}/items`, { cookie: c.cookie, body: { sku: 'A1', name: 'Arroz', type: 'goods', inventoryAccount: '143505', cogsAccount: '613505' } })).json();
    await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key: true, body: { itemId: item._id, date: TODAY, direction: 'in', quantity: 10_000, unitCost: 10_000, counterAccount: '310505', reason: 'Saldo' } });
    const bad = await call('POST', `${c.base}/pos/registers`, { cookie: c.cookie, body: { code: 'C1', name: 'Mostrador', costCenter: 'NOPE', accounts: { cash: '110505' } } });
    expect(bad.statusCode).toBe(400);
    const register = (await call('POST', `${c.base}/pos/registers`, { cookie: c.cookie, body: { code: 'C1', name: 'Mostrador', costCenter: 'mostrador', accounts: { cash: '110505' } } })).json();
    expect(register.costCenter).toBe('MOSTRADOR');
    await call('POST', `${c.base}/pos/registers/${register._id}/shifts`, { cookie: c.cookie, body: {} });
    const sale = (await call('POST', `${c.base}/pos/sales`, { cookie: c.cookie, key: true, body: { registerId: register._id, date: TODAY, lines: [{ description: 'Arroz', itemId: item._id, quantity: 2000, unitPrice: 25_000, vatBps: 1900 }], payments: [{ method: 'cash', amount: 59_500 }] } })).json().sale;
    const doc = (await call('GET', `${c.base}/journals/${sale.journalId}`, { cookie: c.cookie })).json();
    expect(doc.lines.find((l) => l.accountId === '413505')).toMatchObject({ credit: 50_000, costCenter: 'MOSTRADOR' });
    expect(doc.lines.find((l) => l.accountId === '613505')).toMatchObject({ debit: 20_000, costCenter: 'MOSTRADOR' });
    expect(doc.lines.find((l) => l.accountId === '143505').costCenter).toBeUndefined();
    const cleared = await call('PATCH', `${c.base}/pos/registers/${register._id}`, { cookie: c.cookie, body: { costCenter: '' } });
    expect(cleared.json().costCenter).toBeUndefined();
  });
});

describe('resultado por centro de costo', () => {
  it('reparte ingresos, costos y gastos por centro y deja lo no asignado aparte; la suma cuadra con el estado de resultados', async () => {
    const c = await company();
    await center(c, 'NORTE', 'Sede norte');
    await center(c, 'SUR', 'Sede sur');
    await invoice(c, c.cust1, [line(1_000_000, { costCenter: 'NORTE' }), line(500_000, { costCenter: 'SUR' }), line(100_000)]);
    await journal(c, [{ accountId: '510506', debit: 300_000, costCenter: 'NORTE' }, { accountId: '110505', credit: 300_000 }]);
    await journal(c, [{ accountId: '510506', debit: 120_000, costCenter: 'SUR' }, { accountId: '110505', credit: 120_000 }]);
    await journal(c, [{ accountId: '519595', debit: 50_000 }, { accountId: '110505', credit: 50_000 }]);

    const res = await report(c, 'cost-center-result', { from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.centers.map((x) => [x.code, x.name, x.totals.income, x.totals.expense, x.totals.result])).toEqual([
      ['NORTE', 'Sede norte', 1_000_000, 300_000, 700_000],
      ['SUR', 'Sede sur', 500_000, 120_000, 380_000],
    ]);
    expect(body.unassigned.totals).toMatchObject({ income: 100_000, expense: 50_000, result: 50_000 });
    expect(body.centers[0].rows).toEqual([
      { code: '413505', name: 'Ventas', type: 'income', amount: 1_000_000 },
      { code: '510506', name: 'Sueldos', type: 'expense', amount: 300_000 },
    ]);
    const statement = (await report(c, 'income-statement', { from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).json();
    expect(body.totals).toEqual({ income: statement.totals.income, cost: statement.totals.cost, expense: statement.totals.expense, result: statement.totals.net });
    expect(body.totals.result).toBe(1_130_000);
  });

  it('el cierre de ejercicio no altera el resultado por centro', async () => {
    const c = await company();
    await center(c, 'NORTE');
    const old = `${YEAR - 1}-03-10`;
    await journal(c, [{ accountId: '110505', debit: 700_000 }, { accountId: '413505', credit: 700_000, costCenter: 'NORTE' }], old);
    await journal(c, [{ accountId: '510506', debit: 200_000, costCenter: 'NORTE' }, { accountId: '110505', credit: 200_000 }], old);
    const closed = await call('POST', `${c.base}/year-end/close`, { cookie: c.cookie, body: { year: YEAR - 1, currency: 'COP', profitAccount: '360505' } });
    expect(closed.statusCode, closed.body).toBe(201);
    const res = (await report(c, 'cost-center-result', { from: `${YEAR - 1}-01`, to: `${YEAR - 1}-12`, currency: 'COP' })).json();
    expect(res.centers).toHaveLength(1);
    expect(res.centers[0].totals).toMatchObject({ income: 700_000, expense: 200_000, result: 500_000 });
    expect(res.unassigned.totals).toMatchObject({ income: 0, expense: 0, result: 0 });
  });

  it('valida los períodos y exige permiso de lectura', async () => {
    const c = await company();
    expect((await report(c, 'cost-center-result', { from: '2026-13', to: '2026-12', currency: 'COP' })).statusCode).toBe(400);
    expect((await report(c, 'cost-center-result', { from: '2026-05', to: '2026-04', currency: 'COP' })).statusCode).toBe(422);
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    expect((await report(c, 'cost-center-result', { from: MONTHS[0], to: MONTHS[0], currency: 'COP' }, cashier)).statusCode).toBe(403);
  });
});

describe('auxiliar por tercero', () => {
  it('trae saldo inicial, movimientos y saldo final del cliente por cuenta, y cuadra con su cartera', async () => {
    const c = await company();
    const inv = (await invoice(c, c.cust1, [line(1_000_000)])).invoice;
    await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, depositAccount: '110505', allocations: [{ invoiceId: inv._id, amount: 300_000 }] } });
    const res = (await report(c, 'party-ledger', { partyId: c.cust1, from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).json();
    expect(res.party).toMatchObject({ name: 'Droguería Los Andes', taxId: '800197268' });
    expect(res.accounts).toEqual([{ code: '130505', name: 'Clientes', nature: 'debit', opening: 0, debit: 1_190_000, credit: 300_000, closing: 890_000 }]);
    expect(res.movements.map((m) => [m.document, m.debit, m.credit])).toEqual([[`FV1`, 1_190_000, 0], [`RC1`, 0, 300_000]]);
    // La cuenta por cobrar de este cliente es lo que le falta pagar a su factura.
    expect((await call('GET', `${c.base}/invoices/${inv._id}`, { cookie: c.cookie })).json().balance).toBe(res.accounts[0].closing);
    const other = (await report(c, 'party-ledger', { partyId: c.cust2, from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).json();
    expect(other.accounts).toEqual([]);
    expect(other.movements).toEqual([]);
  });

  it('el saldo inicial es lo anterior al primer mes del rango', async () => {
    const c = await company();
    const last = `${YEAR - 1}-12-15`;
    await journal(c, [{ accountId: '130510', debit: 500_000, partyId: c.cust1 }, { accountId: '413505', credit: 500_000 }], last);
    await journal(c, [{ accountId: '110505', debit: 200_000 }, { accountId: '130510', credit: 200_000, partyId: c.cust1 }], TODAY);
    const res = (await report(c, 'party-ledger', { partyId: c.cust1, from: TODAY.slice(0, 7), to: TODAY.slice(0, 7), currency: 'COP' })).json();
    expect(res.accounts).toEqual([expect.objectContaining({ code: '130510', opening: 500_000, debit: 0, credit: 200_000, closing: 300_000 })]);
    expect(res.movements).toHaveLength(1);
  });

  it('el proveedor lleva su cuenta por pagar en su naturaleza, con compras, notas y pagos', async () => {
    const c = await company();
    const purchase = (await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: { supplierId: c.supplier, supplierDocNumber: 'SA-1', issueDate: YESTERDAY, lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }] } })).json().purchase;
    await call('POST', `${c.base}/payments`, { cookie: c.cookie, key: true, body: { partyId: c.supplier, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: purchase._id, amount: 400_000 }] } });
    const res = (await report(c, 'party-ledger', { partyId: c.supplier, from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).json();
    expect(res.accounts).toEqual([{ code: '220505', name: 'Proveedores', nature: 'credit', opening: 0, debit: 400_000, credit: 1_190_000, closing: 790_000 }]);
    expect((await call('GET', `${c.base}/purchases/${purchase._id}`, { cookie: c.cookie })).json().balance).toBe(790_000);
  });

  it('un anticipo y su aplicación quedan a nombre del cliente', async () => {
    const c = await company();
    const saved = await call('PUT', `${c.base}/invoicing/settings`, {
      cookie: c.cookie,
      body: {
        issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10', city: 'Garzón', region: 'Huila' } },
        accounts: { receivable: '130505', income: '413505', vatPayable: '240805', cash: '110505', customerAdvance: '280505' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const inv = (await invoice(c, c.cust1, [line(1_000_000)])).invoice;
    const adv = (await call('POST', `${c.base}/customer-advances`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, amount: 500_000, account: '110505' } })).json().advance;
    await call('POST', `${c.base}/customer-advances/${adv._id}/applications`, { cookie: c.cookie, key: true, body: { date: TODAY, allocations: [{ documentId: inv._id, amount: 300_000 }] } });
    const res = (await report(c, 'party-ledger', { partyId: c.cust1, from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).json();
    const byCode = Object.fromEntries(res.accounts.map((a) => [a.code, a]));
    expect(byCode['130505']).toMatchObject({ debit: 1_190_000, credit: 300_000, closing: 890_000 });
    // La cuenta de anticipos (pasivo): entró 500.000 y se aplicaron 300.000: quedan 200.000 a favor del cliente.
    expect(byCode['280505']).toMatchObject({ nature: 'credit', debit: 300_000, credit: 500_000, closing: 200_000 });
  });

  it('valida el tercero y los períodos', async () => {
    const c = await company();
    const q = { from: MONTHS[0], to: MONTHS[0], currency: 'COP' };
    expect((await report(c, 'party-ledger', { ...q, partyId: 'a'.repeat(24) })).statusCode).toBe(404);
    expect((await report(c, 'party-ledger', { ...q, partyId: 'nope' })).statusCode).toBe(400);
    expect((await report(c, 'party-ledger', q)).statusCode).toBe(400);
    expect((await report(c, 'party-ledger', { ...q, partyId: c.cust1, from: '2026-9' })).statusCode).toBe(400);
  });

  it('una empresa no ve los saldos de un tercero de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await invoice(a, a.cust1, [line(1_000_000)]);
    expect((await report(b, 'party-ledger', { partyId: a.cust1, from: MONTHS[0], to: MONTHS.at(-1), currency: 'COP' })).statusCode).toBe(404);
  });
});
