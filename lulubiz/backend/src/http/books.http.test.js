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
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': `bk-${(counter += 1)}-aaaaaaaa` } : {}) },
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
  const c = { cookie, base };
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

/** El escenario de todas las pruebas: ventas a crédito y de contado, una nota, un recibo, una compra con retención, su nota y un pago. */
async function scenario(c) {
  const invoice = (customerId, issueDate, paymentMethod, lines) =>
    call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: { customerId, issueDate, paymentMethod, ...(paymentMethod === 'credit' ? { dueDate: iso(30) } : {}), lines } });
  const a = (await invoice(c.cust1, YESTERDAY, 'credit', [{ description: 'Mercancía', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }])).json().invoice;
  const b = (await invoice(c.cust2, TODAY, 'cash', [{ description: 'Papel', quantity: 1000, unitPrice: 500_000, vatBps: 0 }])).json().invoice;
  const note = (await call('POST', `${c.base}/invoices/${a._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 250 }] } })).json().note;
  const receipt = (await call('POST', `${c.base}/receipts`, { cookie: c.cookie, key: true, body: { partyId: c.cust1, date: TODAY, depositAccount: '110505', allocations: [{ invoiceId: a._id, amount: 500_000 }] } })).json().receipt;
  const purchase = (
    await call('POST', `${c.base}/purchases`, {
      cookie: c.cookie,
      key: true,
      body: {
        supplierId: c.supplier,
        supplierDocNumber: 'SA-1',
        issueDate: YESTERDAY,
        dueDate: iso(30),
        lines: [{ description: 'Aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }],
        withholdings: [{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250 }],
      },
    })
  ).json().purchase;
  const supplierNote = (await call('POST', `${c.base}/purchases/${purchase._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reason: 'Devolución', supplierDocNumber: 'NC-9', lines: [{ lineIndex: 0, quantity: 500 }] } })).json().note;
  const payment = (await call('POST', `${c.base}/payments`, { cookie: c.cookie, key: true, body: { partyId: c.supplier, date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: purchase._id, amount: 300_000 }] } })).json().payment;
  expect([a, b, note, receipt, purchase, supplierNote, payment].every(Boolean)).toBe(true);
  return { a, b, note, receipt, purchase, supplierNote, payment };
}

const get = (c, path, query, cookie = c.cookie) => call('GET', `${c.base}/reports/${path}?${new URLSearchParams(query)}`, { cookie });
const range = { from: `${YEAR}-01-01`, to: TODAY, currency: 'COP' };

beforeAll(async () => {
  mongo = await startMongo('lulubiz_books_http_test');
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

describe('libro de ventas', () => {
  it('lista facturas y notas crédito con su base e IVA por tarifa, y las notas restan', async () => {
    const c = await company();
    const docs = await scenario(c);
    const res = await get(c, 'sales-book', range);
    expect(res.statusCode, res.body).toBe(200);
    const book = res.json();
    expect(book.rows.map((r) => [r.kind, r.number])).toEqual([['invoice', docs.a.fullNumber], ['invoice', docs.b.fullNumber], ['credit_note', docs.note.fullNumber]]);
    expect(book.rows[0]).toMatchObject({ party: { name: 'Droguería Los Andes', taxId: '800197268', checkDigit: 4 }, subtotal: 1_000_000, tax: 190_000, total: 1_190_000, rates: { 1900: { base: 1_000_000, tax: 190_000 } } });
    expect(book.rows[1]).toMatchObject({ paymentMethod: 'cash', total: 500_000, rates: { 0: { base: 500_000, tax: 0 } } });
    expect(book.rows[2]).toMatchObject({ reference: docs.a.fullNumber, subtotal: -250_000, tax: -47_500, total: -297_500 });
    expect(book.totals).toMatchObject({ documents: 3, subtotal: 1_250_000, tax: 142_500, total: 1_392_500 });
    expect(book.totals.rates).toEqual([{ vatBps: 0, base: 500_000, tax: 0 }, { vatBps: 1900, base: 750_000, tax: 142_500 }]);
  });

  it('respeta el rango de fechas y la moneda', async () => {
    const c = await company();
    await scenario(c);
    expect((await get(c, 'sales-book', { from: TODAY, to: TODAY, currency: 'COP' })).json().rows.map((r) => r.kind)).toEqual(['invoice', 'credit_note']);
    expect((await get(c, 'sales-book', { from: `${YEAR - 2}-01-01`, to: `${YEAR - 2}-12-31`, currency: 'COP' })).json()).toMatchObject({ rows: [], totals: { documents: 0, total: 0, rates: [] } });
    expect((await get(c, 'sales-book', { ...range, currency: 'USD' })).json().rows).toEqual([]);
  });

  it('no incluye lo que no se emitió', async () => {
    const c = await company();
    // Una factura rechazada por el proveedor conserva su número pero no es una venta.
    const customer = (await call('POST', `${c.base}/parties`, { cookie: c.cookie, body: { name: 'Cliente RECHAZAR', roles: ['customer'], taxIdType: 'CC', taxId: '1075123456' } })).json()._id;
    const rejected = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: { customerId: customer, issueDate: TODAY, paymentMethod: 'cash', lines: [{ description: 'x', quantity: 1000, unitPrice: 1000, vatBps: 0 }] } });
    expect(rejected.json().rejected).toBe(true);
    expect((await get(c, 'sales-book', range)).json().rows).toEqual([]);
  });
});

describe('libro de compras', () => {
  it('lista compras y notas de proveedor con IVA descontable y retenciones, y las notas restan', async () => {
    const c = await company();
    const docs = await scenario(c);
    const book = (await get(c, 'purchases-book', range)).json();
    expect(book.rows.map((r) => [r.kind, r.number])).toEqual([['purchase', docs.purchase.fullNumber], ['supplier_note', docs.supplierNote.fullNumber]]);
    expect(book.rows[0]).toMatchObject({ supplierDocNumber: 'SA-1', party: { name: 'Aseo Total SAS' }, subtotal: 1_000_000, tax: 190_000, total: 1_190_000, withheld: 25_000, payable: 1_165_000 });
    expect(book.rows[1]).toMatchObject({ reference: docs.purchase.fullNumber, subtotal: -500_000, tax: -95_000, total: -595_000, withheld: -12_500, payable: -582_500 });
    expect(book.totals).toMatchObject({ documents: 2, subtotal: 500_000, tax: 95_000, total: 595_000, withheld: 12_500, payable: 582_500 });
    expect(book.totals.rates).toEqual([{ vatBps: 1900, base: 500_000, tax: 95_000 }]);
  });

  it('una compra anulada no aparece', async () => {
    const c = await company();
    const { purchase } = await scenario(c);
    // Con pagos y notas no se anula: se anula una compra nueva y limpia.
    const clean = (await call('POST', `${c.base}/purchases`, { cookie: c.cookie, key: true, body: { supplierId: c.supplier, supplierDocNumber: 'SA-2', issueDate: TODAY, lines: [{ description: 'Otra', quantity: 1000, unitPrice: 100_000, vatBps: 0, accountId: '519595' }] } })).json().purchase;
    expect((await call('POST', `${c.base}/purchases/${clean._id}/void`, { cookie: c.cookie })).statusCode).toBe(200);
    const numbers = (await get(c, 'purchases-book', range)).json().rows.map((r) => r.number);
    expect(numbers).toContain(purchase.fullNumber);
    expect(numbers).not.toContain(clean.fullNumber);
  });
});

describe('estados de cuenta', () => {
  it('cliente: factura a crédito, nota y recibo, con saldo corrido; la factura de contado no cuenta', async () => {
    const c = await company();
    const docs = await scenario(c);
    const st = (await get(c, 'customer-statement', { ...range, partyId: c.cust1 })).json();
    expect(st.party).toMatchObject({ name: 'Droguería Los Andes', taxId: '800197268' });
    expect(st.opening).toBe(0);
    expect(st.rows.map((r) => [r.kind, r.debit, r.credit, r.balance])).toEqual([
      ['invoice', 1_190_000, 0, 1_190_000],
      ['credit_note', 0, 297_500, 892_500],
      ['receipt', 0, 500_000, 392_500],
    ]);
    expect(st.totals).toEqual({ debit: 1_190_000, credit: 797_500 });
    expect(st.closing).toBe(392_500);
    // Cuadra con el saldo que lleva la propia factura.
    expect((await call('GET', `${c.base}/invoices/${docs.a._id}`, { cookie: c.cookie })).json().balance).toBe(st.closing);
    // El otro cliente solo tiene una venta de contado: no debe nada.
    const other = (await get(c, 'customer-statement', { ...range, partyId: c.cust2 })).json();
    expect(other.rows).toEqual([]);
    expect(other.closing).toBe(0);
  });

  it('cliente: el saldo inicial es lo anterior al rango', async () => {
    const c = await company();
    await scenario(c);
    const st = (await get(c, 'customer-statement', { from: TODAY, to: TODAY, currency: 'COP', partyId: c.cust1 })).json();
    expect(st.opening).toBe(1_190_000);
    expect(st.rows.map((r) => r.kind)).toEqual(['credit_note', 'receipt']);
    expect(st.closing).toBe(392_500);
  });

  it('un recibo anulado deja de contar', async () => {
    const c = await company();
    const { receipt } = await scenario(c);
    await call('POST', `${c.base}/receipts/${receipt._id}/void`, { cookie: c.cookie });
    const st = (await get(c, 'customer-statement', { ...range, partyId: c.cust1 })).json();
    expect(st.rows.map((r) => r.kind)).toEqual(['invoice', 'credit_note']);
    expect(st.closing).toBe(892_500);
  });

  it('proveedor: compra sin retenciones, nota y pago, y cuadra con lo que falta pagar', async () => {
    const c = await company();
    const docs = await scenario(c);
    const st = (await get(c, 'supplier-statement', { ...range, partyId: c.supplier })).json();
    expect(st.rows.map((r) => [r.kind, r.debit, r.credit, r.balance])).toEqual([
      ['purchase', 0, 1_165_000, 1_165_000],
      ['supplier_note', 582_500, 0, 582_500],
      ['payment', 300_000, 0, 282_500],
    ]);
    expect(st.closing).toBe(282_500);
    expect((await call('GET', `${c.base}/purchases/${docs.purchase._id}`, { cookie: c.cookie })).json().balance).toBe(st.closing);
    expect(st.rows[0]).toMatchObject({ detail: 'Factura SA-1' });
  });

  it('valida el cliente y las fechas', async () => {
    const c = await company();
    expect((await get(c, 'customer-statement', { ...range, partyId: 'a'.repeat(24) })).statusCode).toBe(404);
    expect((await get(c, 'customer-statement', { ...range, partyId: 'nope' })).statusCode).toBe(400);
    expect((await get(c, 'supplier-statement', { ...range, partyId: 'b'.repeat(24) })).statusCode).toBe(404);
    expect((await get(c, 'customer-statement', range)).statusCode).toBe(400);
  });
});

describe('ventas por cliente y por mes', () => {
  it('suma facturas y resta notas, ordenado por lo vendido', async () => {
    const c = await company();
    await scenario(c);
    const res = (await get(c, 'sales-summary', { ...range, by: 'customer' })).json();
    expect(res.rows.map((r) => [r.name, r.invoices, r.notes, r.subtotal, r.tax, r.total])).toEqual([
      ['Droguería Los Andes', 1, 1, 750_000, 142_500, 892_500],
      ['Papelería Central', 1, 0, 500_000, 0, 500_000],
    ]);
    expect(res.totals).toEqual({ invoices: 2, notes: 1, subtotal: 1_250_000, tax: 142_500, total: 1_392_500 });
  });

  it('por mes agrupa por el mes de emisión', async () => {
    const c = await company();
    await scenario(c);
    const res = (await get(c, 'sales-summary', { ...range, by: 'month' })).json();
    const months = new Set([YESTERDAY.slice(0, 7), TODAY.slice(0, 7)]);
    expect(res.rows.map((r) => r.key)).toEqual([...months].sort());
    expect(res.totals.total).toBe(1_392_500);
    expect((await get(c, 'sales-summary', { ...range, by: 'producto' })).statusCode).toBe(400);
  });
});

describe('permisos y aislamiento', () => {
  it('el lector consulta; el cajero no; sin sesión nada', async () => {
    const c = await company();
    await scenario(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const cashier = await joinAs(c, 'cajero@andina.co', 'cashier');
    for (const [path, extra] of [['sales-book', {}], ['purchases-book', {}], ['customer-statement', { partyId: c.cust1 }], ['supplier-statement', { partyId: c.supplier }], ['sales-summary', { by: 'month' }]]) {
      expect((await get(c, path, { ...range, ...extra }, viewer)).statusCode, path).toBe(200);
      expect((await get(c, path, { ...range, ...extra }, cashier)).statusCode, path).toBe(403);
      expect((await call('GET', `${c.base}/reports/${path}?${new URLSearchParams({ ...range, ...extra })}`)).statusCode, path).toBe(401);
    }
  });

  it('una empresa no ve los documentos ni los terceros de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    await scenario(a);
    expect((await get(b, 'sales-book', range)).json().rows).toEqual([]);
    expect((await get(b, 'purchases-book', range)).json().rows).toEqual([]);
    expect((await get(b, 'customer-statement', { ...range, partyId: a.cust1 })).statusCode).toBe(404);
    expect((await get(a, 'sales-book', range, b.cookie)).statusCode).toBe(403);
  });
});
