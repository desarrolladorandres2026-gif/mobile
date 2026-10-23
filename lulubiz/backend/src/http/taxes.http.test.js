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
const YEAR = new Date().getUTCFullYear();
const FROM = iso(-5);
const TO = iso(0);

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
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': `tx-${(counter += 1)}-aaaaaaaa` } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
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
  await make({ code: '135515', name: 'Saldo a favor de IVA', type: 'asset', parentCode: '1' });
  await make({ code: '135595', name: 'Retención en la fuente a favor', type: 'asset', parentCode: '1' });
  await make({ code: '135596', name: 'ReteIVA a favor', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' });
  await make({ code: '236540', name: 'Retención en la fuente por compras', type: 'liability', parentCode: '2' });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' });
  await make({ code: '241005', name: 'IVA por pagar a la DIAN', type: 'liability', parentCode: '2' });
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

const get = (c, path, cookie = c.cookie) => call('GET', `${c.base}${path}`, { cookie });
const post = (c, path, body, cookie = c.cookie) => call('POST', `${c.base}${path}`, { cookie, body, key: true });
const query = (q) => new URLSearchParams(q).toString();
const vatQuery = (extra = {}) => query({ from: FROM, to: TO, currency: 'COP', ...extra });
const net = async (c, account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: c.tenantId, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};

/** Ventas con tres tarifas y una nota crédito; una compra con retención y una nota de proveedor. */
async function activity(c) {
  const a = await post(c, '/invoices', { customerId: c.customer, issueDate: iso(-2), paymentMethod: 'cash', lines: [{ description: 'Equipos', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }, { description: 'Alimentos', quantity: 1000, unitPrice: 500_000, vatBps: 500 }] });
  expect(a.statusCode, a.body).toBe(201);
  expect((await post(c, '/invoices', { customerId: c.customer, issueDate: iso(-1), paymentMethod: 'cash', lines: [{ description: 'Libros', quantity: 1000, unitPrice: 300_000, vatBps: 0 }] })).statusCode).toBe(201);
  const nc = await post(c, `/invoices/${a.json().invoice._id}/credit-notes`, { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 250 }] });
  expect(nc.statusCode, nc.body).toBe(201);
  const p = await post(c, '/purchases', { supplierId: c.supplier, supplierDocNumber: 'SA-1', issueDate: iso(-2), lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 2_000_000, vatBps: 1900, accountId: '519595' }], withholdings: [{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }] });
  expect(p.statusCode, p.body).toBe(201);
  const sn = await post(c, `/purchases/${p.json().purchase._id}/credit-notes`, { reason: 'Devolución', supplierDocNumber: 'NC-1', lines: [{ lineIndex: 0, quantity: 500 }] });
  expect(sn.statusCode, sn.body).toBe(201);
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_taxes_http_test');
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

describe('informe de IVA', () => {
  it('separa el generado del descontable por tarifa, resta las notas y cuadra con el libro', async () => {
    const c = await company();
    await activity(c);
    const res = await get(c, `/reports/vat?${vatQuery()}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.generated.rates).toEqual([
      { vatBps: 0, base: 300_000, tax: 0 },
      { vatBps: 500, base: 500_000, tax: 25_000 },
      { vatBps: 1900, base: 750_000, tax: 142_500 },
    ]);
    expect(r.generated).toMatchObject({ base: 1_550_000, tax: 167_500, documents: { invoices: 2, posSales: 0, creditNotes: 1 } });
    expect(r.deductible.rates).toEqual([{ vatBps: 1900, base: 1_000_000, tax: 190_000 }]);
    expect(r.deductible.documents).toEqual({ purchases: 1, supplierNotes: 1 });
    expect(r.net).toBe(-22_500);
    expect(r.ledger.generated).toMatchObject({ account: '240805', amount: 167_500, difference: 0 });
    expect(r.ledger.deductible).toMatchObject({ account: '240810', amount: 190_000, difference: 0 });
  });

  it('un asiento manual sobre la cuenta de IVA se ve como diferencia con el libro', async () => {
    const c = await company();
    await activity(c);
    const manual = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType: 'AJ', date: `${iso(-1)}T12:00:00Z`, currency: 'COP', lines: [{ accountId: '110505', debit: 1_000 }, { accountId: '240805', credit: 1_000 }] } });
    expect(manual.statusCode, manual.body).toBe(201);
    const r = (await get(c, `/reports/vat?${vatQuery()}`)).json();
    expect(r.ledger.generated.difference).toBe(1_000);
    expect(r.ledger.deductible.difference).toBe(0);
  });

  it('un rango sin documentos da ceros; valida fechas; el lector lo ve; otra empresa no ve nada', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await activity(a);
    const empty = (await get(a, `/reports/vat?${query({ from: `${YEAR - 1}-01-01`, to: `${YEAR - 1}-01-31`, currency: 'COP' })}`)).json();
    expect(empty).toMatchObject({ net: 0, generated: { tax: 0, rates: [] }, deductible: { tax: 0 } });
    expect((await get(a, `/reports/vat?${query({ from: TO, to: FROM, currency: 'COP' })}`)).statusCode).toBe(400);
    expect((await get(a, `/reports/vat?${query({ from: '2026-02-30', to: TO, currency: 'COP' })}`)).statusCode).toBe(400);
    const viewer = await joinAs(a, 'lector@andina.co', 'viewer');
    expect((await get(a, `/reports/vat?${vatQuery()}`, viewer)).statusCode).toBe(200);
    expect((await get(b, `/reports/vat?${vatQuery()}`)).json().net).toBe(0);
  });
});

describe('informe de ICA', () => {
  const icaQuery = (extra = {}) => query({ from: FROM, to: TO, currency: 'COP', ratePpm: '9660', ...extra });

  it('toma el ingreso neto del libro (las notas crédito restan) y aplica la tarifa por mil', async () => {
    const c = await company();
    await activity(c);
    const res = await get(c, `/reports/ica?${icaQuery()}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.lines).toEqual([{ account: '413505', name: 'Ventas', amount: 1_550_000, excluded: false }]);
    expect(r).toMatchObject({ total: 1_550_000, base: 1_550_000, excludedTotal: 0, ratePpm: 9660, ica: 14_973 });
  });

  it('una cuenta excluida sale de la base pero se muestra; excluir una cuenta que no es de ingreso se rechaza', async () => {
    const c = await company();
    await activity(c);
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '421005', name: 'Otros ingresos', type: 'income', parentCode: '4' } });
    const manual = await call('POST', `${c.base}/journals`, { cookie: c.cookie, key: true, body: { docType: 'AJ', date: `${iso(-1)}T12:00:00Z`, currency: 'COP', lines: [{ accountId: '110505', debit: 100_000 }, { accountId: '421005', credit: 100_000 }] } });
    expect(manual.statusCode, manual.body).toBe(201);
    const all = (await get(c, `/reports/ica?${icaQuery()}`)).json();
    expect(all).toMatchObject({ base: 1_650_000, ica: 15_939 });
    const r = (await get(c, `/reports/ica?${icaQuery({ excludeAccounts: '421005' })}`)).json();
    expect(r.lines.find((l) => l.account === '421005')).toMatchObject({ amount: 100_000, excluded: true });
    expect(r).toMatchObject({ total: 1_650_000, excludedTotal: 100_000, base: 1_550_000, ica: 14_973 });
    expect((await get(c, `/reports/ica?${icaQuery({ excludeAccounts: '110505' })}`)).statusCode).toBe(400);
  });

  it('valida la tarifa y las fechas; un rango sin ingresos da cero; el lector lo ve', async () => {
    const c = await company();
    expect((await get(c, `/reports/ica?${icaQuery({ ratePpm: '100001' })}`)).statusCode).toBe(400);
    expect((await get(c, `/reports/ica?${query({ from: FROM, to: TO, currency: 'COP' })}`)).statusCode).toBe(400);
    expect((await get(c, `/reports/ica?${icaQuery({ from: TO, to: FROM })}`)).statusCode).toBe(400);
    expect((await get(c, `/reports/ica?${icaQuery()}`)).json()).toMatchObject({ lines: [], base: 0, ica: 0 });
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await get(c, `/reports/ica?${icaQuery()}`, viewer)).statusCode).toBe(200);
  });
});

describe('base de información exógena', () => {
  const exoQuery = (extra = {}) => query({ year: String(YEAR), currency: 'COP', ...extra });

  it('suma por tercero ingresos, compras y retenciones, netos de las notas', async () => {
    const c = await company();
    await activity(c);
    const res = await get(c, `/reports/exogena?${exoQuery()}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.income.parties).toEqual([expect.objectContaining({ name: 'Droguería Los Andes', taxId: '800197268', base: 1_550_000, tax: 167_500 })]);
    expect(r.income).toMatchObject({ counterOfSale: 0, total: 1_550_000 });
    expect(r.costs.parties).toEqual([expect.objectContaining({ name: 'Aseo Total SAS', base: 1_000_000, tax: 190_000 })]);
    expect(r.withheldFromSuppliers).toMatchObject({ total: 25_000, parties: [expect.objectContaining({ name: 'Aseo Total SAS', amount: 25_000 })] });
    expect(r.withheldByCustomers).toMatchObject({ total: 0, parties: [] });
  });

  it('el tope oculta a los terceros por debajo, no los totales; valida año y tope; el lector lo ve', async () => {
    const c = await company();
    await activity(c);
    const r = (await get(c, `/reports/exogena?${exoQuery({ minAmount: '1550001' })}`)).json();
    expect(r.income.parties).toEqual([]);
    expect(r.income.total).toBe(1_550_000);
    expect(r.costs.parties).toEqual([]);
    expect((await get(c, `/reports/exogena?${exoQuery({ year: '26' })}`)).statusCode).toBe(400);
    expect((await get(c, `/reports/exogena?${exoQuery({ minAmount: '-1' })}`)).statusCode).toBe(400);
    const empty = (await get(c, `/reports/exogena?${exoQuery({ year: String(YEAR - 3) })}`)).json();
    expect(empty).toMatchObject({ income: { parties: [], total: 0 }, costs: { total: 0 } });
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    expect((await get(c, `/reports/exogena?${exoQuery()}`, viewer)).statusCode).toBe(200);
  });
});

describe('retenciones practicadas', () => {
  it('por concepto y por proveedor, netas de lo que devolvió la nota', async () => {
    const c = await company();
    await activity(c);
    const r = (await get(c, `/reports/withholdings?${vatQuery()}`)).json();
    expect(r.concepts).toEqual([{ name: 'Retefuente 2,5 %', accountId: '236540', rateBps: 250, basis: 'subtotal', base: 1_000_000, amount: 25_000 }]);
    expect(r.suppliers).toEqual([expect.objectContaining({ name: 'Aseo Total SAS', taxId: '900123456', amount: 25_000 })]);
    expect(r.totals).toEqual({ base: 1_000_000, amount: 25_000 });
    expect(await net(c, '236540')).toBe(-25_000); // coincide con el libro
    expect((await get(c, `/reports/withholdings?${vatQuery({ supplierId: String(new ObjectId()) })}`)).json().concepts).toEqual([]);
    expect((await get(c, `/reports/withholdings?${vatQuery({ supplierId: 'x' })}`)).statusCode).toBe(400);
  });

  it('el certificado de un proveedor trae lo retenido en el año y los datos de quien retuvo', async () => {
    const c = await company();
    await activity(c);
    const res = await get(c, `/reports/withholding-certificate?${query({ supplierId: c.supplier, year: String(YEAR), currency: 'COP' })}`);
    expect(res.statusCode, res.body).toBe(200);
    const cert = res.json();
    expect(cert).toMatchObject({ year: YEAR, issuer: { name: 'Andina SAS', taxId: '890903938', checkDigit: 8 }, supplier: { name: 'Aseo Total SAS', taxId: '900123456' }, totals: { base: 1_000_000, amount: 25_000 } });
    expect(cert.concepts).toHaveLength(1);
    expect((await get(c, `/reports/withholding-certificate?${query({ supplierId: String(new ObjectId()), year: String(YEAR), currency: 'COP' })}`)).statusCode).toBe(404);
    expect((await get(c, `/reports/withholding-certificate?${query({ supplierId: c.supplier, year: '26', currency: 'COP' })}`)).statusCode).toBe(400);
  });
});

describe('cierre de IVA', () => {
  const close = (c, body, cookie = c.cookie) => call('POST', `${c.base}/taxes/vat-closes`, { cookie, body: { from: FROM, to: TO, currency: 'COP', ...body } });

  it('con saldo a favor cruza lo generado contra lo descontable y deja la diferencia en la cuenta de saldo a favor', async () => {
    const c = await company();
    await activity(c);
    const preview = (await get(c, `/taxes/vat-close/preview?${vatQuery()}`)).json();
    expect(preview).toMatchObject({ generated: 167_500, deductible: 190_000, net: -22_500, overlap: null });
    expect((await close(c, {})).statusCode).toBe(400); // falta la cuenta del saldo a favor
    expect((await close(c, { creditAccount: '241005' })).statusCode).toBe(400); // un pasivo no es saldo a favor
    expect((await close(c, { creditAccount: '240805' })).statusCode).toBe(400); // ni la cuenta de IVA misma
    const res = await close(c, { creditAccount: '135515' });
    expect(res.statusCode, res.body).toBe(201);
    const { close: done } = res.json();
    expect(done).toMatchObject({ status: 'posted', result: 'credit', net: -22_500, generated: 167_500, deductible: 190_000 });
    const journal = (await get(c, `/journals/${done.journalId}`)).json();
    expect(journal).toMatchObject({ docType: 'CI', totalDebit: 190_000, totalCredit: 190_000 });
    expect(journal.lines).toEqual([
      expect.objectContaining({ accountId: '240805', debit: 167_500 }),
      expect.objectContaining({ accountId: '240810', credit: 190_000 }),
      expect.objectContaining({ accountId: '135515', debit: 22_500 }),
    ]);
    expect(await net(c, '240805')).toBe(0);
    expect(await net(c, '240810')).toBe(0);
    expect(await net(c, '135515')).toBe(22_500);
    // El informe de IVA no cuenta el asiento de cierre.
    const after = (await get(c, `/reports/vat?${vatQuery()}`)).json();
    expect(after.ledger.generated.difference).toBe(0);
    expect(after.net).toBe(-22_500);
  });

  it('con IVA por pagar lo deja en la cuenta de IVA por pagar a la DIAN', async () => {
    const c = await company();
    expect((await post(c, '/invoices', { customerId: c.customer, issueDate: iso(-1), paymentMethod: 'cash', lines: [{ description: 'Equipos', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }] })).statusCode).toBe(201);
    const noDue = await close(c, { creditAccount: '135515' });
    expect(noDue.statusCode).toBe(400); // hay IVA por pagar y se indicó la cuenta equivocada
    const res = await close(c, { dueAccount: '241005' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().close).toMatchObject({ result: 'payable', net: 190_000, resultAccount: '241005' });
    expect(await net(c, '241005')).toBe(-190_000);
    expect(await net(c, '240805')).toBe(0);
  });

  it('un rango no se cierra dos veces ni se traslapa; anular lo libera', async () => {
    const c = await company();
    await activity(c);
    const first = (await close(c, { creditAccount: '135515' })).json().close;
    expect((await close(c, { creditAccount: '135515' })).statusCode).toBe(409);
    expect((await close(c, { from: iso(-3), to: iso(0), creditAccount: '135515' })).statusCode).toBe(409); // traslapado
    expect((await get(c, `/taxes/vat-close/preview?${vatQuery()}`)).json().overlap).toMatchObject({ document: first.document });
    expect((await get(c, '/taxes/vat-closes')).json().items).toHaveLength(1);
    const voided = await call('POST', `${c.base}/taxes/vat-closes/${first._id}/void`, { cookie: c.cookie });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().close.status).toBe('void');
    expect(await net(c, '240805')).toBe(-167_500); // el IVA vuelve al libro
    expect((await call('POST', `${c.base}/taxes/vat-closes/${first._id}/void`, { cookie: c.cookie })).json().replayed).toBe(true);
    expect((await close(c, { creditAccount: '135515' })).statusCode).toBe(201);
  });

  it('no cierra un rango sin IVA, valida el rango y exige permiso; el lector ve el estado', async () => {
    const c = await company();
    const empty = await close(c, { creditAccount: '135515' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toMatch(/no hay IVA/);
    expect((await close(c, { from: TO, to: FROM, creditAccount: '135515' })).statusCode).toBe(400);
    await activity(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    expect((await close(c, { creditAccount: '135515' }, viewer)).statusCode).toBe(403);
    expect((await get(c, '/taxes/vat-closes', viewer)).statusCode).toBe(200);
    expect((await close(c, { creditAccount: '135515' }, accountant)).statusCode).toBe(201);
  });

  it('dos cierres a la vez del mismo rango dejan uno', async () => {
    const c = await company();
    await activity(c);
    const results = await Promise.all([close(c, { creditAccount: '135515' }), close(c, { creditAccount: '135515' }), close(c, { creditAccount: '135515' })]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
    expect(await net(c, '240805')).toBe(0);
  });

  it('un período contable cerrado impide el cierre y no deja nada a medias', async () => {
    const c = await company();
    await activity(c);
    const month = TO.slice(0, 7);
    expect((await call('POST', `${c.base}/periods/${month}/close`, { cookie: c.cookie })).statusCode).toBeLessThan(300);
    const res = await close(c, { creditAccount: '135515' });
    expect(res.statusCode).toBe(409);
    expect(await db.collection(COLLECTIONS.taxCloses).countDocuments({ tenantId: c.tenantId })).toBe(0);
  });
});

describe('retenciones que nos practican los clientes', () => {
  async function creditInvoice(c) {
    const inv = await post(c, '/invoices', { customerId: c.customer, issueDate: iso(-3), paymentMethod: 'credit', dueDate: iso(30), lines: [{ description: 'Equipos', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }] });
    expect(inv.statusCode, inv.body).toBe(201);
    return inv.json().invoice;
  }
  const WH = [{ name: 'Retefuente 2,5 %', accountId: '135595', amount: 25_000 }, { name: 'ReteIVA 15 %', accountId: '135596', amount: 28_500 }];
  const receipt = (c, inv, extra = {}, amount = 1_190_000) => post(c, '/receipts', { partyId: c.customer, date: iso(-1), depositAccount: '110505', allocations: [{ invoiceId: inv._id, amount }], ...extra });

  it('bajan la cartera como un cobro pero no entran como dinero: quedan como impuesto a favor', async () => {
    const c = await company();
    const inv = await creditInvoice(c);
    const res = await receipt(c, inv, { withholdings: WH });
    expect(res.statusCode, res.body).toBe(201);
    const { receipt: r } = res.json();
    expect(r).toMatchObject({ total: 1_190_000, withheld: 53_500, received: 1_136_500 });
    expect(r.withholdings).toEqual(WH);
    const journal = (await get(c, `/journals/${r.journalId}`)).json();
    expect(journal.totalDebit).toBe(1_190_000);
    expect(journal.lines.find((l) => l.accountId === '110505').debit).toBe(1_136_500);
    expect(journal.lines.find((l) => l.accountId === '135595').debit).toBe(25_000);
    expect(journal.lines.find((l) => l.accountId === '130505')).toMatchObject({ credit: 1_190_000, partyId: c.customer });
    expect((await get(c, `/invoices/${inv._id}`)).json().balance).toBe(0);
    expect(await net(c, '110505')).toBe(1_136_500);
    expect(await net(c, '135596')).toBe(28_500);
  });

  it('anular el recibo devuelve la cartera y reversa las retenciones', async () => {
    const c = await company();
    const inv = await creditInvoice(c);
    const r = (await receipt(c, inv, { withholdings: WH })).json().receipt;
    const voided = await call('POST', `${c.base}/receipts/${r._id}/void`, { cookie: c.cookie, key: true });
    expect(voided.statusCode, voided.body).toBe(200);
    expect((await get(c, `/invoices/${inv._id}`)).json().balance).toBe(1_190_000);
    expect(await net(c, '135595')).toBe(0);
    expect(await net(c, '110505')).toBe(0);
  });

  it('rechaza retenciones que no cuadran, sin dejar nada', async () => {
    const c = await company();
    const inv = await creditInvoice(c);
    const bad = async (withholdings, amount) => (await receipt(c, inv, { withholdings }, amount)).statusCode;
    expect(await bad([{ name: 'Todo', accountId: '135595', amount: 1_190_000 }])).toBe(400); // nada entraría a caja
    expect(await bad([{ name: 'Mal', accountId: '240805', amount: 100 }])).toBe(400); // un pasivo no es impuesto a favor
    expect(await bad([{ name: 'Caja', accountId: '110505', amount: 100 }])).toBe(400); // la misma cuenta del depósito
    expect(await bad([{ name: 'Por cobrar', accountId: '130505', amount: 100 }])).toBe(400);
    expect(await bad([{ name: 'No existe', accountId: '999999', amount: 100 }])).toBe(400);
    expect(await bad([{ name: '', accountId: '135595', amount: 100 }])).toBe(400);
    expect(await bad([{ name: 'Cero', accountId: '135595', amount: 0 }])).toBe(400);
    expect((await get(c, `/invoices/${inv._id}`)).json().balance).toBe(1_190_000);
    expect(await db.collection(COLLECTIONS.receipts).countDocuments({ tenantId: c.tenantId })).toBe(0);
  });

  it('el informe suma lo retenido por concepto y por cliente, y no cuenta recibos anulados', async () => {
    const c = await company();
    const inv = await creditInvoice(c);
    const inv2 = await creditInvoice(c);
    const r1 = (await receipt(c, inv, { withholdings: WH })).json().receipt;
    await receipt(c, inv2, { withholdings: [WH[0]] });
    let r = (await get(c, `/reports/withholdings-suffered?${vatQuery()}`)).json();
    expect(r.concepts).toEqual([{ name: 'Retefuente 2,5 %', accountId: '135595', amount: 50_000 }, { name: 'ReteIVA 15 %', accountId: '135596', amount: 28_500 }]);
    expect(r.customers).toEqual([expect.objectContaining({ name: 'Droguería Los Andes', amount: 78_500 })]);
    expect(r.total).toBe(78_500);
    await call('POST', `${c.base}/receipts/${r1._id}/void`, { cookie: c.cookie, key: true });
    r = (await get(c, `/reports/withholdings-suffered?${vatQuery()}`)).json();
    expect(r.total).toBe(25_000);
    expect((await get(c, `/reports/withholdings-suffered?${vatQuery({ customerId: String(new ObjectId()) })}`)).json().concepts).toEqual([]);
    expect((await get(c, `/reports/withholdings-suffered?${vatQuery({ customerId: 'x' })}`)).statusCode).toBe(400);
  });
});
