import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createInventoryService } from '../inventory/inventory.js';
import { createSettingsService } from '../invoicing/settings.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { startMongo } from '../testing/mongo.js';
import { createPurchasesService } from './purchases.js';

const TODAY = '2026-10-20';
const NOW = new Date(`${TODAY}T15:00:00Z`);

let mongo;
let db;
let ledger;
let accounts;
let parties;
let settings;
let inventory;
let purchases;
let tenant;
let supplier;
let n = 0;
const user = new ObjectId();

const ctx = (key) => ({ idempotencyKey: key, userId: user });
const fresh = (label) => `${label}-${(n += 1)}-aaaaaaaa`;
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('130505', 'Clientes', 'asset', '1');
  await make('143505', 'Mercancías no fabricadas', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('220505', 'Proveedores nacionales', 'liability', '2');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('240810', 'IVA descontable', 'liability', '2');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital social', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('519595', 'Gastos diversos', 'expense', '5');
  await make('529595', 'Pérdida de inventario', 'expense', '5');
  await make('6', 'Costos de ventas', 'cost');
  await make('613505', 'Costo de mercancía vendida', 'cost', '6');
}

const makeItem = (patch = {}) => inventory.createItem(tenant, { sku: 'TORN-1', name: 'Tornillo', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', ...patch });
const goodsLine = (item, patch = {}) => ({ description: item.name, itemId: String(item._id), quantity: 10_000, unitPrice: 100_000, vatBps: 1900, ...patch });
const expenseLine = (patch = {}) => ({ description: 'Flete', quantity: 1000, unitPrice: 50_000, vatBps: 0, accountId: '519595', ...patch });
const input = (lines, patch = {}) => ({ supplierId: String(supplier._id), supplierDocNumber: fresh('f'), issueDate: '2026-10-05', dueDate: '2026-11-04', lines, ...patch });
const buy = async (lines, patch) => (await purchases.createPurchase(tenant, input(lines, patch), ctx(fresh('pur')))).purchase;
const stockRow = async (item, warehouse) => {
  const w = warehouse ?? (await inventory.ensureDefaultWarehouse(tenant));
  return db.collection(COLLECTIONS.stock).findOne({ tenantId: tenant, itemId: item._id, warehouseId: w._id });
};
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};
/** El valor de las existencias de la cuenta de inventario es exactamente su saldo en el libro. */
const expectReconciled = async () => {
  const v = await inventory.valuation(tenant);
  for (const a of v.accounts) expect(a.difference, `cuenta ${a.account}`).toBe(0);
  return v;
};

beforeAll(async () => {
  mongo = await startMongo('lulubiz_purchases_inventory_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
  parties = createPartyService(mongo.client, db);
  settings = createSettingsService(mongo.client, db, accounts);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Ferretería Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  supplier = await parties.create(tenant, { name: 'Tornillos del Sur SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
  await openChart();
  await settings.save(tenant, {
    issuer: { name: 'Ferretería Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
    accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810' },
  });
  inventory = createInventoryService({ client: mongo.client, db, ledger, accounts, now: () => NOW });
  purchases = createPurchasesService({ client: mongo.client, db, ledger, accounts, parties, settings, inventory, now: () => NOW });
});

describe('compra de bienes', () => {
  it('la línea con artículo entra a la bodega principal por su neto y debita la cuenta de inventario', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    expect(p.lines[0]).toMatchObject({ itemId: item._id, accountId: '143505', net: 1_000_000, tax: 190_000 });
    expect(p.lines[0].warehouseId).toBeDefined();

    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 1_000_000 });
    expect(await ledgerNet('143505')).toBe(1_000_000);
    expect(await ledgerNet('240810')).toBe(190_000);
    const v = await expectReconciled();
    expect(v.total).toBe(1_000_000);

    const kardex = await inventory.kardex(tenant, { itemId: String(item._id) });
    expect(kardex.items).toHaveLength(1);
    expect(kardex.items[0]).toMatchObject({ type: 'purchase_in', quantity: 10_000, value: 1_000_000, balanceQuantity: 10_000, balanceValue: 1_000_000, lineIndex: 0, source: { kind: 'purchase', id: String(p._id) } });
  });

  it('la cuenta de la línea la manda el artículo, no lo que escriba quien registra', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item, { accountId: '519595' })]);
    expect(p.lines[0].accountId).toBe('143505');
    expect(await ledgerNet('519595')).toBe(0);
  });

  it('mezcla bienes y gastos: solo los bienes tocan existencias', async () => {
    const item = await makeItem();
    await buy([goodsLine(item), expenseLine()]);
    expect(await ledgerNet('143505')).toBe(1_000_000);
    expect(await ledgerNet('519595')).toBe(50_000);
    expect(await db.collection(COLLECTIONS.movements).countDocuments({ tenantId: tenant })).toBe(1);
    await expectReconciled();
  });

  it('dos compras a distinto precio dejan el costo promedio', async () => {
    const item = await makeItem();
    await buy([goodsLine(item, { quantity: 10_000, unitPrice: 100_000 })]);
    await buy([goodsLine(item, { quantity: 10_000, unitPrice: 200_000 })]);
    expect(await stockRow(item)).toMatchObject({ quantity: 20_000, value: 3_000_000 });
    const v = await expectReconciled();
    expect(v.rows[0]).toMatchObject({ sku: 'TORN-1', quantity: 20_000, averageCost: 150_000 });
  });

  it('dos líneas del mismo artículo en la misma factura suman, y una bodega nueva lleva su propia existencia', async () => {
    const item = await makeItem();
    const wh = await inventory.createWarehouse(tenant, { code: 'SUR', name: 'Bodega sur' });
    await buy([goodsLine(item, { quantity: 4_000 }), goodsLine(item, { quantity: 6_000, warehouseId: String(wh._id) })]);
    expect(await stockRow(item)).toMatchObject({ quantity: 4_000, value: 400_000 });
    expect(await stockRow(item, wh)).toMatchObject({ quantity: 6_000, value: 600_000 });
    await expectReconciled();
  });

  it('el descuento de la línea baja el valor que entra', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item, { discountBps: 1000 })]);
    expect(p.lines[0].net).toBe(900_000);
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 900_000 });
    await expectReconciled();
  });

  it('repetir la misma clave no vuelve a meter existencias', async () => {
    const item = await makeItem();
    const key = fresh('pur');
    const body = input([goodsLine(item)], { supplierDocNumber: 'F-IDEM' });
    const first = await purchases.createPurchase(tenant, body, ctx(key));
    const again = await purchases.createPurchase(tenant, body, ctx(key));
    expect(again.replayed).toBe(true);
    expect(again.purchase._id).toEqual(first.purchase._id);
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000 });
    expect(await ledgerNet('143505')).toBe(1_000_000);
  });

  it('una factura repetida del proveedor se rechaza y no deja existencias a medias', async () => {
    const item = await makeItem();
    await buy([goodsLine(item)], { supplierDocNumber: 'F-1' });
    expect(await code(purchases.createPurchase(tenant, input([goodsLine(item)], { supplierDocNumber: 'f-1' }), ctx(fresh('pur'))))).toBe('DUPLICATE');
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 1_000_000 });
    await expectReconciled();
  });

  it('rechaza servicios, artículos inactivos, inexistentes, bodegas inactivas y cantidades inválidas, sin dejar nada', async () => {
    const item = await makeItem();
    const service = await inventory.createItem(tenant, { sku: 'INSTALA', name: 'Instalación', type: 'service', incomeAccount: '413505' });
    const dead = await makeItem({ sku: 'VIEJO', name: 'Viejo' });
    await inventory.updateItem(tenant, String(dead._id), { active: false });
    const closed = await inventory.createWarehouse(tenant, { code: 'CERR', name: 'Cerrada' });
    await inventory.setWarehouseActive(tenant, String(closed._id), false);

    const attempt = (line) => code(purchases.createPurchase(tenant, input([line]), ctx(fresh('pur'))));
    expect(await attempt(goodsLine(service))).toBe('VALIDATION');
    expect(await attempt(goodsLine(dead))).toBe('VALIDATION');
    expect(await attempt(goodsLine(item, { itemId: String(new ObjectId()) }))).toBe('NOT_FOUND');
    expect(await attempt(goodsLine(item, { itemId: 'no-es-id' }))).toBe('VALIDATION');
    expect(await attempt(goodsLine(item, { warehouseId: String(closed._id) }))).toBe('VALIDATION');
    expect(await attempt(goodsLine(item, { warehouseId: String(new ObjectId()) }))).toBe('NOT_FOUND');
    expect(await attempt(goodsLine(item, { quantity: 0 }))).toBe('VALIDATION');

    expect(await db.collection(COLLECTIONS.purchases).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await db.collection(COLLECTIONS.movements).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);
  });

  it('no mezcla empresas: el artículo de otra empresa no existe aquí', async () => {
    const item = await makeItem();
    const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
    const { tenantId: stranger } = await auth.registerTenant({ companyName: 'Otra SAS', country: 'CO', currency: 'COP', ownerName: 'O', email: 'o@otra.co', password: 'correcto-caballo-grapa' });
    const foreign = createPurchasesService({ client: mongo.client, db, ledger, accounts, parties, settings, inventory, now: () => NOW });
    const err = await code(foreign.createPurchase(stranger, input([goodsLine(item)]), ctx(fresh('pur'))));
    expect(['NOT_FOUND', 'SETTINGS_INCOMPLETE']).toContain(err);
    expect(await stockRow(item)).toBeNull();
  });

  it('sin servicio de inventario, una línea con artículo se rechaza', async () => {
    const item = await makeItem();
    const bare = createPurchasesService({ client: mongo.client, db, ledger, accounts, parties, settings, now: () => NOW });
    expect(await code(bare.createPurchase(tenant, input([goodsLine(item)]), ctx(fresh('pur'))))).toBe('VALIDATION');
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({ tenantId: tenant })).toBe(0);
  });
});

describe('anular una compra de bienes', () => {
  it('saca exactamente lo que entró y reversa el asiento', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    const voided = await purchases.voidPurchase(tenant, String(p._id), {}, ctx('x'));
    expect(voided.purchase.status).toBe('void');
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    expect(await ledgerNet('143505')).toBe(0);
    await expectReconciled();

    const kardex = await inventory.kardex(tenant, { itemId: String(item._id) });
    expect(kardex.items.map((m) => [m.type, m.quantity, m.value])).toEqual([
      ['purchase_in', 10_000, 1_000_000],
      ['purchase_void', -10_000, -1_000_000],
    ]);
  });

  it('anular dos veces no saca dos veces', async () => {
    const item = await makeItem();
    await buy([goodsLine(item)]);
    const second = await buy([goodsLine(item)]);
    await purchases.voidPurchase(tenant, String(second._id), {}, ctx('x'));
    const again = await purchases.voidPurchase(tenant, String(second._id), {}, ctx('x'));
    expect(again.replayed).toBe(true);
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 1_000_000 });
    await expectReconciled();
  });

  it('si parte de lo comprado ya salió, no se anula y no cambia nada', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    await inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'out', quantity: 4_000, counterAccount: '529595', reason: 'Pérdida' }, ctx(fresh('aj')));
    const before = await stockRow(item);

    expect(await code(purchases.voidPurchase(tenant, String(p._id), {}, ctx('x')))).toBe('INSUFFICIENT_STOCK');
    expect((await purchases.getPurchase(tenant, String(p._id))).status).toBe('posted');
    expect(await stockRow(item)).toMatchObject({ quantity: before.quantity, value: before.value });
    expect(await ledgerNet('220505')).toBe(-1_190_000);
    await expectReconciled();
  });
});

describe('nota de proveedor sobre bienes', () => {
  it('la devolución parcial saca esa cantidad y ese neto', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    const { note } = await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 3_000 }], reason: 'Defectuosos', supplierDocNumber: 'nc-1' }, ctx(fresh('np')));
    expect(note.lines[0]).toMatchObject({ itemId: item._id, quantity: 3_000, net: 300_000 });
    expect(await stockRow(item)).toMatchObject({ quantity: 7_000, value: 700_000 });
    expect(await ledgerNet('143505')).toBe(700_000);
    await expectReconciled();

    const kardex = await inventory.kardex(tenant, { itemId: String(item._id) });
    expect(kardex.items[1]).toMatchObject({ type: 'purchase_return', quantity: -3_000, value: -300_000 });
  });

  it('acreditar el resto deja la existencia en cero, sin residuos', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item, { quantity: 3_000, unitPrice: 333_333 })]);
    await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 1_000 }], reason: 'a', supplierDocNumber: 'N-1' }, ctx(fresh('np')));
    await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'b', supplierDocNumber: 'N-2' }, ctx(fresh('np')));
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    await expectReconciled();
  });

  it('anular la nota devuelve las existencias', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    const { note } = await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'NV-1' }, ctx(fresh('np')));
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    await purchases.voidSupplierNote(tenant, String(note._id), {}, ctx('x'));
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 1_000_000 });
    await expectReconciled();
  });

  it('si ya se vendió lo que se devuelve, la nota se rechaza entera: ni deuda, ni acreditado, ni existencias', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    await inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'out', quantity: 9_000, counterAccount: '529595', reason: 'Salida' }, ctx(fresh('aj')));
    const debtBefore = await ledgerNet('220505');

    expect(await code(purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 5_000 }], reason: 'x', supplierDocNumber: 'NX-1' }, ctx(fresh('np'))))).toBe('INSUFFICIENT_STOCK');
    const after = await purchases.getPurchase(tenant, String(p._id));
    expect(after).toMatchObject({ creditedTotal: 0, creditStatus: 'none', balance: 1_190_000 });
    expect(await db.collection(COLLECTIONS.supplierNotes).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await ledgerNet('220505')).toBe(debtBefore);
    expect(await stockRow(item)).toMatchObject({ quantity: 1_000 });
    await expectReconciled();
  });

  it('anular la nota siempre puede reingresar, aunque la existencia haya cambiado entremedias', async () => {
    const item = await makeItem();
    const p = await buy([goodsLine(item)]);
    const { note } = await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'NR-1' }, ctx(fresh('np')));
    await inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: 2_000, unitCost: 777, counterAccount: '310505', reason: 'Hallazgo' }, ctx(fresh('aj')));
    await purchases.voidSupplierNote(tenant, String(note._id), {}, ctx('x'));
    expect(await stockRow(item)).toMatchObject({ quantity: 12_000, value: 1_000_000 + valueOf(2_000, 777) });
    await expectReconciled();
  });
});

const valueOf = (quantity, unitCost) => Math.round((quantity * unitCost) / 1000);
