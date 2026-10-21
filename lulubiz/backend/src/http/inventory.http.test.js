import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../data/db.js';
import { createSandboxProvider } from '../invoicing/provider.js';
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
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true }, invoicingProvider: createSandboxProvider() });
};

const call = (method, url, { cookie, body, key } = {}) =>
  app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key === true ? `inv-${(counter += 1)}-aaaaaaaa` : key } : {}) },
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
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '143505', name: 'Mercancías', type: 'asset', parentCode: '1' });
  await make({ code: '3', name: 'Patrimonio', type: 'equity', postable: false });
  await make({ code: '310505', name: 'Capital social', type: 'equity', parentCode: '3' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await make({ code: '5', name: 'Gastos', type: 'expense', postable: false });
  await make({ code: '529595', name: 'Pérdida de inventario', type: 'expense', parentCode: '5' });
  await make({ code: '6', name: 'Costos de ventas', type: 'cost', postable: false });
  await make({ code: '613505', name: 'Costo de mercancía vendida', type: 'cost', parentCode: '6' });
  return { cookie, base };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const itemBody = (patch = {}) => ({ sku: 'tornillo-1', name: 'Tornillo 1/2', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', minStock: 5_000, ...patch });
const newItem = async (c, patch) => {
  const res = await call('POST', `${c.base}/items`, { cookie: c.cookie, body: itemBody(patch) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const adjustBody = (item, patch = {}) => ({ itemId: item._id, date: TODAY, direction: 'in', quantity: 10_000, unitCost: 100, counterAccount: '310505', reason: 'Saldo inicial', ...patch });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_inventory_http_test');
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

describe('artículos y bodegas por la API', () => {
  it('crea, consulta, edita, lista y desactiva un artículo', async () => {
    const c = await company();
    const item = await newItem(c, { price: 250_000, vatBps: 1900 });
    expect(item).toMatchObject({ sku: 'TORNILLO-1', unit: 'UND', type: 'goods', inventoryAccount: '143505', price: 250_000, active: true });

    expect((await call('GET', `${c.base}/items/${item._id}`, { cookie: c.cookie })).json().name).toBe('Tornillo 1/2');
    const edited = await call('PATCH', `${c.base}/items/${item._id}`, { cookie: c.cookie, body: { name: 'Tornillo galvanizado', price: null, minStock: 8_000 } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ name: 'Tornillo galvanizado', minStock: 8_000 });
    expect(edited.json().price).toBeUndefined();

    await newItem(c, { sku: 'TUERCA', name: 'Tuerca hexagonal' });
    await call('PATCH', `${c.base}/items/${item._id}`, { cookie: c.cookie, body: { active: false } });
    const all = (await call('GET', `${c.base}/items`, { cookie: c.cookie })).json();
    expect(all.items.map((i) => i.sku)).toEqual(['TORNILLO-1', 'TUERCA']);
    expect(all.items[0]).toMatchObject({ onHand: 0, stockValue: 0 });
    expect((await call('GET', `${c.base}/items?active=true`, { cookie: c.cookie })).json().items.map((i) => i.sku)).toEqual(['TUERCA']);
    expect((await call('GET', `${c.base}/items?search=tue`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/items?limit=1`, { cookie: c.cookie })).json().nextCursor).toBeTruthy();
  });

  it('valida el cuerpo y cuida los duplicados y los ids', async () => {
    const c = await company();
    await newItem(c);
    const post = (body) => call('POST', `${c.base}/items`, { cookie: c.cookie, body });
    expect((await post(itemBody({ sku: 'tornillo-1' }))).json().error).toBe('DUPLICATE');
    expect((await post(itemBody({ sku: 'con espacio' }))).statusCode).toBe(400);
    expect((await post(itemBody({ extra: 1 }))).statusCode).toBe(400);
    expect((await post(itemBody({ type: 'otro' }))).statusCode).toBe(400);
    expect((await post(itemBody({ sku: 'B2', price: -5 }))).statusCode).toBe(400);
    expect((await post(itemBody({ sku: 'B3', inventoryAccount: '413505' }))).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/items/no-es-id`, { cookie: c.cookie })).statusCode).toBe(400);
    expect((await call('GET', `${c.base}/items/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('PATCH', `${c.base}/items/${'a'.repeat(24)}`, { cookie: c.cookie, body: { name: 'x' } })).statusCode).toBe(404);
    expect((await call('PATCH', `${c.base}/items/${'a'.repeat(24)}`, { cookie: c.cookie, body: {} })).statusCode).toBe(400);
  });

  it('crea bodegas, no repite códigos y no desactiva la principal ni una con existencias', async () => {
    const c = await company();
    const item = await newItem(c);
    const created = await call('POST', `${c.base}/warehouses`, { cookie: c.cookie, body: { code: 'sur', name: 'Bodega sur' } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ code: 'SUR', active: true });
    expect((await call('POST', `${c.base}/warehouses`, { cookie: c.cookie, body: { code: 'SUR', name: 'Otra' } })).json().error).toBe('DUPLICATE');
    const list = (await call('GET', `${c.base}/warehouses`, { cookie: c.cookie })).json().items;
    expect(list.map((w) => w.code).sort()).toEqual(['PRINCIPAL', 'SUR']);

    const main = list.find((w) => w.code === 'PRINCIPAL');
    expect((await call('POST', `${c.base}/warehouses/${main._id}/active`, { cookie: c.cookie, body: { active: false } })).statusCode).toBe(400);

    await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key: true, body: adjustBody(item, { warehouseId: created.json()._id }) });
    const busy = await call('POST', `${c.base}/warehouses/${created.json()._id}/active`, { cookie: c.cookie, body: { active: false } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('ITEM_IN_USE');
  });
});

describe('existencias por la API', () => {
  it('ajusta, traspasa, consulta existencias, kardex, valoración y mínimos', async () => {
    const c = await company();
    const item = await newItem(c);
    const south = (await call('POST', `${c.base}/warehouses`, { cookie: c.cookie, body: { code: 'SUR', name: 'Bodega sur' } })).json();

    expect((await call('GET', `${c.base}/inventory/low-stock`, { cookie: c.cookie })).json().items).toEqual([expect.objectContaining({ sku: 'TORNILLO-1', onHand: 0, minStock: 5_000 })]);

    const key = 'ajuste-1-aaaaaaaa';
    const entry = await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key, body: adjustBody(item) });
    expect(entry.statusCode, entry.body).toBe(201);
    expect(entry.json().doc).toMatchObject({ fullNumber: 'MI1', direction: 'in', quantity: 10_000, value: 1_000 });
    const again = await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key, body: adjustBody(item) });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);

    const moved = await call('POST', `${c.base}/stock/transfers`, { cookie: c.cookie, key: true, body: { itemId: item._id, fromWarehouseId: (await call('GET', `${c.base}/warehouses`, { cookie: c.cookie })).json().items.find((w) => w.code === 'PRINCIPAL')._id, toWarehouseId: south._id, date: TODAY, quantity: 4_000 } });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json().doc).toMatchObject({ fullNumber: 'TR1', quantity: 4_000, value: 400 });

    const out = await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key: true, body: adjustBody(item, { direction: 'out', quantity: 1_000, counterAccount: '529595', reason: 'Rotura', unitCost: undefined }) });
    expect(out.statusCode, out.body).toBe(201);
    expect(out.json().doc).toMatchObject({ direction: 'out', value: 100 });

    const stock = (await call('GET', `${c.base}/stock?itemId=${item._id}`, { cookie: c.cookie })).json().items;
    expect(stock.map((s) => [s.quantity, s.value]).sort()).toEqual([[4_000, 400], [5_000, 500]]);

    const kardex = (await call('GET', `${c.base}/kardex?itemId=${item._id}`, { cookie: c.cookie })).json();
    expect(kardex.items.map((m) => m.type)).toEqual(['adjust_in', 'transfer_out', 'transfer_in', 'adjust_out']);
    expect((await call('GET', `${c.base}/kardex?itemId=${item._id}&limit=2`, { cookie: c.cookie })).json().nextCursor).toBeTruthy();
    expect((await call('GET', `${c.base}/kardex?itemId=${item._id}&from=2000-01-01&to=2000-01-02`, { cookie: c.cookie })).json().items).toHaveLength(0);

    const valuation = (await call('GET', `${c.base}/inventory/valuation`, { cookie: c.cookie })).json();
    expect(valuation.total).toBe(900);
    expect(valuation.accounts).toEqual([{ account: '143505', stockValue: 900, ledgerBalance: 900, difference: 0 }]);
    expect(valuation.rows).toHaveLength(2);
    expect((await call('GET', `${c.base}/inventory/valuation?warehouseId=${south._id}`, { cookie: c.cookie })).json().total).toBe(400);

    expect((await call('GET', `${c.base}/inventory/low-stock`, { cookie: c.cookie })).json().items).toHaveLength(0);
    const docs = (await call('GET', `${c.base}/stock/documents`, { cookie: c.cookie })).json();
    expect(docs.items.map((d) => d.fullNumber)).toEqual(['MI2', 'TR1', 'MI1']);
    expect((await call('GET', `${c.base}/stock/documents?kind=transfer`, { cookie: c.cookie })).json().items).toHaveLength(1);
  });

  it('rechaza lo imposible con el código de negocio y no toca nada', async () => {
    const c = await company();
    const item = await newItem(c);
    const adjust = (body, key = true) => call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key, body });

    const empty = await adjust(adjustBody(item, { direction: 'out', quantity: 1_000, counterAccount: '529595', unitCost: undefined }));
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe('INSUFFICIENT_STOCK');
    expect((await adjust(adjustBody(item, { counterAccount: '143505' }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item), false)).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { quantity: 0 }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { quantity: 1.5 }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { direction: 'sideways' }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { unitCost: undefined }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { date: '2026-13-40' }))).statusCode).toBe(400);
    expect((await adjust(adjustBody(item, { itemId: 'a'.repeat(24) }))).statusCode).toBe(404);
    expect((await adjust(adjustBody(item, { counterAccount: '999999' }))).statusCode).toBe(400);

    const main = (await call('GET', `${c.base}/warehouses`, { cookie: c.cookie })).json().items[0];
    const same = await call('POST', `${c.base}/stock/transfers`, { cookie: c.cookie, key: true, body: { itemId: item._id, fromWarehouseId: main._id, toWarehouseId: main._id, date: TODAY, quantity: 1_000 } });
    expect(same.statusCode).toBe(400);

    expect((await call('GET', `${c.base}/stock`, { cookie: c.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${c.base}/stock/documents`, { cookie: c.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${c.base}/kardex`, { cookie: c.cookie })).statusCode).toBe(400); // exige artículo
  });

  it('una compra con artículo por la API entra al inventario y queda cuadrada con el libro', async () => {
    const c = await company();
    const item = await newItem(c);
    const party = await call('POST', `${c.base}/parties`, { cookie: c.cookie, body: { name: 'Tornillos del Sur SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '2', name: 'Pasivo', type: 'liability', postable: false } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '220505', name: 'Proveedores', type: 'liability', parentCode: '2' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '240810', name: 'IVA descontable', type: 'liability', parentCode: '2' } });
    expect(
      (
        await call('PUT', `${c.base}/invoicing/settings`, {
          cookie: c.cookie,
          body: {
            issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
            accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810' },
          },
        })
      ).statusCode,
    ).toBe(200);

    const bought = await call('POST', `${c.base}/purchases`, {
      cookie: c.cookie,
      key: true,
      body: { supplierId: party.json()._id, supplierDocNumber: 'F-77', issueDate: TODAY, dueDate: TODAY, lines: [{ description: 'Tornillos', itemId: item._id, quantity: 10_000, unitPrice: 100_000, vatBps: 1900 }] },
    });
    expect(bought.statusCode, bought.body).toBe(201);
    expect((await call('GET', `${c.base}/stock?itemId=${item._id}`, { cookie: c.cookie })).json().items[0]).toMatchObject({ quantity: 10_000, value: 1_000_000 });
    expect((await call('GET', `${c.base}/inventory/valuation`, { cookie: c.cookie })).json().accounts[0].difference).toBe(0);

    const note = await call('POST', `${c.base}/purchases/${bought.json().purchase._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reason: 'Devolución', supplierDocNumber: 'NC-1', all: true } });
    expect(note.statusCode, note.body).toBe(201);
    expect((await call('GET', `${c.base}/stock?itemId=${item._id}`, { cookie: c.cookie })).json().items[0]).toMatchObject({ quantity: 0, value: 0 });

    const bad = await call('POST', `${c.base}/purchases`, {
      cookie: c.cookie,
      key: true,
      body: { supplierId: party.json()._id, supplierDocNumber: 'F-78', issueDate: TODAY, dueDate: TODAY, lines: [{ description: 'Fantasma', itemId: 'a'.repeat(24), quantity: 1000, unitPrice: 100, vatBps: 0 }] },
    });
    expect(bad.statusCode).toBe(404);
  });
});

describe('ventas con inventario por la API', () => {
  it('la factura con artículo saca la existencia y la nota crédito de devolución la reingresa', async () => {
    const c = await company();
    const item = await newItem(c);
    await call('POST', `${c.base}/stock/adjustments`, { cookie: c.cookie, key: true, body: adjustBody(item, { quantity: 10_000, unitCost: 10_000 }) });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '2', name: 'Pasivo', type: 'liability', postable: false } });
    await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body: { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' } });
    const party = await call('POST', `${c.base}/parties`, { cookie: c.cookie, body: { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } });
    expect(
      (
        await call('PUT', `${c.base}/invoicing/settings`, {
          cookie: c.cookie,
          body: {
            issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
            accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
          },
        })
      ).statusCode,
    ).toBe(200);
    for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
      const year = new Date().getUTCFullYear();
      const res = await call('POST', `${c.base}/invoicing/resolutions`, { cookie: c.cookie, body: { docType, prefix, number: '18760000001', from: 1, to: 50, validFrom: `${year - 1}-01-01`, validTo: `${year + 1}-12-31` } });
      expect(res.statusCode, res.body).toBe(201);
    }

    const sale = (quantity) => ({ customerId: party.json()._id, issueDate: TODAY, paymentMethod: 'credit', dueDate: `${new Date().getUTCFullYear() + 1}-12-31`, lines: [{ description: 'Tornillos', itemId: item._id, quantity, unitPrice: 25_000, vatBps: 1900 }] });
    const tooMuch = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: sale(11_000) });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error).toBe('INSUFFICIENT_STOCK');

    const sold = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, key: true, body: sale(4_000) });
    expect(sold.statusCode, sold.body).toBe(201);
    expect(sold.json().invoice).toMatchObject({ status: 'issued', stockCost: [40_000], accounting: { status: 'posted' } });
    expect((await call('GET', `${c.base}/stock?itemId=${item._id}`, { cookie: c.cookie })).json().items[0]).toMatchObject({ quantity: 6_000, value: 60_000 });

    const note = await call('POST', `${c.base}/invoices/${sold.json().invoice._id}/credit-notes`, { cookie: c.cookie, key: true, body: { reasonCode: '1', all: true } });
    expect(note.statusCode, note.body).toBe(201);
    expect((await call('GET', `${c.base}/stock?itemId=${item._id}`, { cookie: c.cookie })).json().items[0]).toMatchObject({ quantity: 10_000, value: 100_000 });
    const valuation = (await call('GET', `${c.base}/inventory/valuation`, { cookie: c.cookie })).json();
    expect(valuation.accounts.every((a) => a.difference === 0)).toBe(true);
    expect((await call('GET', `${c.base}/kardex?itemId=${item._id}`, { cookie: c.cookie })).json().items.map((m) => m.type)).toEqual(['adjust_in', 'sale_out', 'sale_return']);
  });
});

describe('permisos y aislamiento del inventario', () => {
  it('un lector consulta pero no gestiona ni ajusta; un contador sí; sin sesión nada', async () => {
    const c = await company();
    const item = await newItem(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');

    expect((await call('GET', `${c.base}/items`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/inventory/valuation`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/kardex?itemId=${item._id}`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/items`, { cookie: viewer, body: itemBody({ sku: 'X' }) })).statusCode).toBe(403);
    expect((await call('PATCH', `${c.base}/items/${item._id}`, { cookie: viewer, body: { name: 'Y' } })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/warehouses`, { cookie: viewer, body: { code: 'Z', name: 'Z' } })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/stock/adjustments`, { cookie: viewer, key: true, body: adjustBody(item) })).statusCode).toBe(403);

    expect((await call('POST', `${c.base}/stock/adjustments`, { cookie: accountant, key: true, body: adjustBody(item) })).statusCode).toBe(201);
    expect((await call('POST', `${c.base}/items`, { cookie: accountant, body: itemBody({ sku: 'DEL-CONTADOR' }) })).statusCode).toBe(201);
    expect((await call('GET', `${c.base}/items`)).statusCode).toBe(401);
    expect((await call('POST', `${c.base}/stock/adjustments`, { key: true, body: adjustBody(item) })).statusCode).toBe(401);
  });

  it('una empresa no ve ni toca el inventario de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const item = await newItem(a);
    await call('POST', `${a.base}/stock/adjustments`, { cookie: a.cookie, key: true, body: adjustBody(item) });

    // La sesión de B contra la ruta de A: sin membresía.
    expect((await call('GET', `${a.base}/items`, { cookie: b.cookie })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/stock/adjustments`, { cookie: b.cookie, key: true, body: adjustBody(item) })).statusCode).toBe(403);
    // La sesión de B contra su propia ruta con ids de A: no existen.
    expect((await call('GET', `${b.base}/items/${item._id}`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('PATCH', `${b.base}/items/${item._id}`, { cookie: b.cookie, body: { name: 'robado' } })).statusCode).toBe(404);
    expect((await call('POST', `${b.base}/stock/adjustments`, { cookie: b.cookie, key: true, body: adjustBody(item) })).statusCode).toBe(404);
    expect((await call('GET', `${b.base}/stock?itemId=${item._id}`, { cookie: b.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${b.base}/kardex?itemId=${item._id}`, { cookie: b.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${b.base}/inventory/valuation`, { cookie: b.cookie })).json().total).toBe(0);
    expect((await call('GET', `${a.base}/items/${item._id}`, { cookie: a.cookie })).json().name).toBe('Tornillo 1/2');
  });
});
