import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createLedger } from '../ledger/ledger.js';
import { startMongo } from '../testing/mongo.js';
import { averageCost, createInventoryService, valueOf } from './inventory.js';

const TODAY = '2026-10-20';
const NOW = new Date(`${TODAY}T15:00:00Z`);

let mongo;
let db;
let ledger;
let accounts;
let inventory;
let tenant;
let n = 0;
const user = new ObjectId();

const ctx = (key = `k-${(n += 1)}-aaaaaaaa`) => ({ idempotencyKey: key, userId: user });
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);
const units = (q) => Math.round(q * 1000);

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('143505', 'Mercancías no fabricadas', 'asset', '1');
  await make('143510', 'Materias primas', 'asset', '1');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital social', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('529595', 'Pérdida de inventario', 'expense', '5');
  await make('6', 'Costos de ventas', 'cost');
  await make('613505', 'Costo de mercancía vendida', 'cost', '6');
}

const goods = (patch = {}) => ({ sku: 'tornillo-1', name: 'Tornillo 1/2 pulgada', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', ...patch });
const newItem = async (patch) => inventory.createItem(tenant, goods(patch));
const adjust = (item, direction, quantity, extra = {}, key) =>
  inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction, quantity: units(quantity), counterAccount: direction === 'in' ? '310505' : '529595', reason: 'Prueba', ...(direction === 'in' ? { unitCost: 100 } : {}), ...extra }, ctx(key));
const stockOf = async (item, warehouse) => {
  const w = warehouse ?? (await inventory.ensureDefaultWarehouse(tenant));
  return db.collection(COLLECTIONS.stock).findOne({ tenantId: tenant, itemId: item._id, warehouseId: w._id });
};
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};

beforeAll(async () => {
  mongo = await startMongo('lulubiz_inventory_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Ferretería Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  await openChart();
  inventory = createInventoryService({ client: mongo.client, db, ledger, accounts, now: () => NOW });
});

describe('costo promedio', () => {
  it('el valor de una entrada es cantidad por costo unitario, medio hacia arriba', () => {
    expect(valueOf(10_000, 100)).toBe(1_000);
    expect(valueOf(1_500, 333)).toBe(500); // 499,5 → 500
    expect(valueOf(3_000, 3_333)).toBe(9_999);
  });

  it('sacar todo cuesta todo el valor: no quedan residuos', () => {
    expect(averageCost({ quantity: 3_000, value: 9_999 }, 1_000)).toBe(3_333);
    expect(averageCost({ quantity: 2_000, value: 6_666 }, 1_000)).toBe(3_333);
    expect(averageCost({ quantity: 1_000, value: 3_333 }, 1_000)).toBe(3_333);
    expect(averageCost({ quantity: 3, value: 10 }, 3)).toBe(10);
  });
});

describe('artículos', () => {
  it('crea un bien con sus cuentas y un servicio sin ellas', async () => {
    const item = await newItem({ price: 250_000, vatBps: 1900, minStock: 5_000, incomeAccount: '413505' });
    expect(item).toMatchObject({ sku: 'TORNILLO-1', name: 'Tornillo 1/2 pulgada', nameKey: 'tornillo 1/2 pulgada', unit: 'UND', type: 'goods', inventoryAccount: '143505', cogsAccount: '613505', incomeAccount: '413505', price: 250_000, vatBps: 1900, minStock: 5_000, active: true });
    const service = await inventory.createItem(tenant, { sku: 'INSTALA', name: 'Instalación', type: 'service', incomeAccount: '413505' });
    expect(service).toMatchObject({ type: 'service', incomeAccount: '413505' });
    expect(service.inventoryAccount).toBeUndefined();
  });

  it('valida código, tipo, cuentas y campos de bienes en servicios', async () => {
    const bad = (patch, base = goods()) => code(inventory.createItem(tenant, { ...base, ...patch }));
    expect(await bad({ sku: '' })).toBe('VALIDATION');
    expect(await bad({ sku: 'con espacio' })).toBe('VALIDATION');
    expect(await bad({ name: '  ' })).toBe('VALIDATION');
    expect(await bad({ type: 'otro' })).toBe('VALIDATION');
    expect(await bad({ inventoryAccount: undefined })).toBe('VALIDATION');
    expect(await bad({ inventoryAccount: '413505' })).toBe('VALIDATION'); // ingresos no es inventario
    expect(await bad({ inventoryAccount: '143' })).toBe('VALIDATION'); // inexistente
    expect(await bad({ cogsAccount: '143510' })).toBe('VALIDATION'); // un activo no es costo de ventas
    expect(await bad({ incomeAccount: '143505' })).toBe('VALIDATION');
    expect(await bad({ price: -1 })).toBe('VALIDATION');
    expect(await bad({ vatBps: 10_001 })).toBe('VALIDATION');
    expect(await bad({ type: 'service', inventoryAccount: '143505' }, { sku: 'S', name: 'Servicio' })).toBe('VALIDATION');
    await newItem();
    expect(await bad({ sku: 'Tornillo-1' })).toBe('DUPLICATE');
  });

  it('edita lo que se puede y bloquea las cuentas cuando ya hay movimientos', async () => {
    const item = await newItem();
    const edited = await inventory.updateItem(tenant, String(item._id), { name: 'Tornillo galvanizado', price: 300, minStock: 2_000, unit: 'caja' });
    expect(edited).toMatchObject({ name: 'Tornillo galvanizado', nameKey: 'tornillo galvanizado', price: 300, minStock: 2_000, unit: 'CAJA' });
    const cleared = await inventory.updateItem(tenant, String(item._id), { price: null, minStock: null });
    expect(cleared.price).toBeUndefined();
    expect(cleared.minStock).toBeUndefined();
    // Sin movimientos todavía se pueden cambiar las cuentas.
    expect((await inventory.updateItem(tenant, String(item._id), { inventoryAccount: '143510' })).inventoryAccount).toBe('143510');
    await adjust(item, 'in', 5);
    expect(await code(inventory.updateItem(tenant, String(item._id), { inventoryAccount: '143505' }))).toBe('ITEM_IN_USE');
    expect(await code(inventory.updateItem(tenant, String(new ObjectId()), { name: 'x' }))).toBe('NOT_FOUND');
    expect((await inventory.updateItem(tenant, String(item._id), { active: false })).active).toBe(false);
  });

  it('lista con búsqueda, filtros, cursor y existencias totales, sin ver otras empresas', async () => {
    const a = await newItem({ sku: 'A-1', name: 'Tuerca hexagonal' });
    await newItem({ sku: 'B-1', name: 'Clavo de acero' });
    await inventory.createItem(tenant, { sku: 'S-1', name: 'Instalación', type: 'service' });
    await adjust(a, 'in', 7);
    const all = await inventory.listItems(tenant, { limit: 2 });
    expect(all.items.map((i) => i.sku)).toEqual(['A-1', 'B-1']);
    expect(all.items[0]).toMatchObject({ onHand: 7_000, stockValue: 700 });
    expect((await inventory.listItems(tenant, { limit: 2, cursor: all.nextCursor })).items.map((i) => i.sku)).toEqual(['S-1']);
    expect((await inventory.listItems(tenant, { search: 'tuer' })).items.map((i) => i.sku)).toEqual(['A-1']);
    expect((await inventory.listItems(tenant, { search: 'b-' })).items.map((i) => i.sku)).toEqual(['B-1']);
    expect((await inventory.listItems(tenant, { type: 'service' })).items.map((i) => i.sku)).toEqual(['S-1']);
    expect((await inventory.listItems(tenant, { search: 'ñandú.*' })).items).toEqual([]);
    expect((await inventory.listItems(toTenantId(new ObjectId()), {})).items).toEqual([]);
    expect(await inventory.getItem(toTenantId(new ObjectId()), String(a._id))).toBeNull();
  });
});

describe('bodegas', () => {
  it('existe una bodega principal; se crean otras sin repetir código y no se desactiva con existencias', async () => {
    const list = await inventory.listWarehouses(tenant);
    expect(list).toMatchObject([{ code: 'PRINCIPAL', isDefault: true, active: true }]);
    const second = await inventory.createWarehouse(tenant, { code: 'norte', name: 'Bodega norte' });
    expect(second).toMatchObject({ code: 'NORTE', active: true, isDefault: false });
    expect(await code(inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Otra' }))).toBe('DUPLICATE');
    expect(await code(inventory.createWarehouse(tenant, { code: 'con espacio', name: 'x' }))).toBe('VALIDATION');
    const item = await newItem();
    await adjust(item, 'in', 3, { warehouseId: String(second._id) });
    expect(await code(inventory.setWarehouseActive(tenant, String(second._id), false))).toBe('ITEM_IN_USE');
    expect(await code(inventory.setWarehouseActive(tenant, String(list[0]._id), false))).toBe('VALIDATION');
    await inventory.transfer(tenant, { itemId: String(item._id), fromWarehouseId: String(second._id), toWarehouseId: String(list[0]._id), date: TODAY, quantity: units(3) }, ctx());
    expect((await inventory.setWarehouseActive(tenant, String(second._id), false)).active).toBe(false);
    expect(await code(adjust(item, 'in', 1, { warehouseId: String(second._id) }))).toBe('VALIDATION'); // inactiva
  });

  it('dos peticiones a la vez crean una sola bodega principal', async () => {
    await Promise.all([inventory.listWarehouses(tenant), inventory.listWarehouses(tenant), inventory.ensureDefaultWarehouse(tenant)]);
    expect(await db.collection(COLLECTIONS.warehouses).countDocuments({ tenantId: tenant })).toBe(1);
  });
});

describe('ajustes y costo promedio', () => {
  it('una entrada sube existencias, deja su movimiento y su asiento MI, y el libro cuadra con el inventario', async () => {
    const item = await newItem();
    const { doc, replayed } = await adjust(item, 'in', 10, { unitCost: 100 });
    expect(replayed).toBe(false);
    expect(doc).toMatchObject({ kind: 'adjustment', fullNumber: 'MI1', direction: 'in', quantity: 10_000, value: 1_000, counterAccount: '310505' });
    expect(await stockOf(item)).toMatchObject({ quantity: 10_000, value: 1_000 });
    const journal = await ledger.getJournal(tenant, doc.journalId);
    expect(journal).toMatchObject({ docType: 'MI', source: { kind: 'stock_adjustment' } });
    expect(journal.lines).toEqual([{ accountId: '143505', debit: 1_000, credit: 0 }, { accountId: '310505', debit: 0, credit: 1_000 }]);
    const kardex = await inventory.kardex(tenant, { itemId: String(item._id) });
    expect(kardex.items).toMatchObject([{ type: 'adjust_in', quantity: 10_000, value: 1_000, balanceQuantity: 10_000, balanceValue: 1_000 }]);
  });

  it('el costo es el promedio ponderado: una salida sale al promedio y deja saldos coherentes', async () => {
    const item = await newItem();
    await adjust(item, 'in', 10, { unitCost: 100 });
    await adjust(item, 'in', 10, { unitCost: 200 }); // 20 unidades por 3.000: promedio 150
    const out = await adjust(item, 'out', 5);
    expect(out.doc).toMatchObject({ direction: 'out', value: 750, counterAccount: '529595', fullNumber: 'MI3' });
    expect(await stockOf(item)).toMatchObject({ quantity: 15_000, value: 2_250 });
    const journal = await ledger.getJournal(tenant, out.doc.journalId);
    expect(journal.lines).toEqual([{ accountId: '529595', debit: 750, credit: 0 }, { accountId: '143505', debit: 0, credit: 750 }]);
    expect(await ledgerNet('143505')).toBe(2_250);
    expect(await ledgerNet('529595')).toBe(750);
    const { items } = await inventory.kardex(tenant, { itemId: String(item._id) });
    expect(items.map((m) => [m.quantity, m.value, m.balanceQuantity, m.balanceValue])).toEqual([
      [10_000, 1_000, 10_000, 1_000],
      [10_000, 2_000, 20_000, 3_000],
      [-5_000, -750, 15_000, 2_250],
    ]);
  });

  it('con redondeos, al sacar todo el valor llega exactamente a cero', async () => {
    const item = await newItem();
    await adjust(item, 'in', 3, { unitCost: 3_333 }); // 9.999
    for (let i = 0; i < 2; i += 1) await adjust(item, 'out', 1);
    expect(await stockOf(item)).toMatchObject({ quantity: 1_000, value: 3_333 });
    await adjust(item, 'out', 1);
    expect(await stockOf(item)).toMatchObject({ quantity: 0, value: 0 });
    expect(await ledgerNet('143505')).toBe(0);
  });

  it('no deja sacar más de lo que hay ni de un artículo sin existencias, y no cambia nada', async () => {
    const item = await newItem();
    await adjust(item, 'in', 2);
    expect(await code(adjust(item, 'out', 2.001))).toBe('INSUFFICIENT_STOCK');
    expect(await code(adjust(await newItem({ sku: 'OTRO', name: 'Otro' }), 'out', 1))).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(item)).toMatchObject({ quantity: 2_000, value: 200 });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('valida artículo, fecha, cantidad, costo y contrapartida', async () => {
    const item = await newItem();
    const bad = (extra, direction = 'in') => code(adjust(item, direction, 1, extra));
    expect(await bad({ quantity: 0 })).toBe('VALIDATION');
    expect(await bad({ quantity: 1.5 })).toBe('VALIDATION');
    expect(await bad({ unitCost: undefined })).toBe('VALIDATION');
    expect(await bad({ unitCost: 0 })).toBe('VALIDATION'); // valor cero: no hay asiento
    expect(await bad({ unitCost: -1 })).toBe('VALIDATION');
    expect(await bad({ reason: ' ' })).toBe('VALIDATION');
    expect(await bad({ counterAccount: '143505' })).toBe('VALIDATION');
    expect(await bad({ counterAccount: '999999' })).toBe('VALIDATION');
    expect(await bad({ counterAccount: '' })).toBe('VALIDATION');
    expect(await bad({ date: '2099-01-01' })).toBe('VALIDATION');
    expect(await bad({ direction: 'otra' })).toBe('VALIDATION');
    expect(await bad({ itemId: String(new ObjectId()) })).toBe('NOT_FOUND');
    expect(await bad({ warehouseId: String(new ObjectId()) })).toBe('NOT_FOUND');
    const service = await inventory.createItem(tenant, { sku: 'SV', name: 'Servicio', type: 'service' });
    expect(await code(adjust(service, 'in', 1))).toBe('VALIDATION');
    await inventory.updateItem(tenant, String(item._id), { active: false });
    expect(await code(adjust(item, 'in', 1))).toBe('VALIDATION');
    expect(await code(inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: 1000, unitCost: 1, counterAccount: '310505', reason: 'x' }, {}))).toBe('VALIDATION'); // sin clave
    expect(await ledgerNet('143505')).toBe(0);
  });

  it('repetir la clave no ajusta dos veces', async () => {
    const item = await newItem();
    const key = 'ajuste-1-aaaaaaaa';
    const first = await adjust(item, 'in', 4, {}, key);
    const again = await adjust(item, 'in', 4, {}, key);
    expect(again).toMatchObject({ replayed: true, doc: { _id: first.doc._id } });
    expect(await stockOf(item)).toMatchObject({ quantity: 4_000 });
  });

  it('un período cerrado rechaza el ajuste completo', async () => {
    const item = await newItem();
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(adjust(item, 'in', 1))).toBe('PeriodClosedError');
    expect(await stockOf(item)).toBeNull();
    expect(await db.collection(COLLECTIONS.movements).countDocuments({ tenantId: tenant })).toBe(0);
  });

  it('salidas simultáneas del mismo artículo: todas caben o fallan por existencias, sin saldos inconsistentes', async () => {
    const item = await newItem();
    await adjust(item, 'in', 8, { unitCost: 125 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => adjust(item, 'out', 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    expect(await stockOf(item)).toMatchObject({ quantity: 0, value: 0 });
    expect(await ledgerNet('143505')).toBe(0);
    expect(await ledgerNet('529595')).toBe(1_000);
    const { items } = await inventory.kardex(tenant, { itemId: String(item._id), limit: 100 });
    expect(items).toHaveLength(9);
    expect(items.at(-1)).toMatchObject({ balanceQuantity: 0, balanceValue: 0 });
  });

  it('dos salidas que juntas no caben: solo una entra', async () => {
    const item = await newItem();
    await adjust(item, 'in', 10);
    const results = await Promise.allSettled([adjust(item, 'out', 6), adjust(item, 'out', 6)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(item)).toMatchObject({ quantity: 4_000, value: 400 });
  });
});

describe('traspasos', () => {
  it('mueven cantidad y valor entre bodegas sin asiento y con numeración propia', async () => {
    const item = await newItem();
    const [main, north] = [await inventory.ensureDefaultWarehouse(tenant), await inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Norte' })];
    await adjust(item, 'in', 10, { unitCost: 100 });
    await adjust(item, 'in', 5, { warehouseId: String(north._id), unitCost: 400 }); // norte: 5 unidades por 2.000
    const first = await inventory.transfer(tenant, { itemId: String(item._id), fromWarehouseId: String(main._id), toWarehouseId: String(north._id), date: TODAY, quantity: units(4), note: 'Reposición' }, ctx());
    expect(first.doc).toMatchObject({ fullNumber: 'TR1', kind: 'transfer', quantity: 4_000, value: 400, note: 'Reposición' });
    expect(await stockOf(item, main)).toMatchObject({ quantity: 6_000, value: 600 });
    expect(await stockOf(item, north)).toMatchObject({ quantity: 9_000, value: 2_400 }); // el destino promedia con lo que ya tenía
    const second = await inventory.transfer(tenant, { itemId: String(item._id), fromWarehouseId: String(north._id), toWarehouseId: String(main._id), date: TODAY, quantity: units(9) }, ctx());
    expect(second.doc.fullNumber).toBe('TR2');
    expect(await stockOf(item, north)).toMatchObject({ quantity: 0, value: 0 });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: { $ne: 'MI' } })).toBe(0);
    expect(await ledgerNet('143505')).toBe(1_000 + 2_000);
    const valuation = await inventory.valuation(tenant);
    expect(valuation.accounts).toEqual([{ account: '143505', stockValue: 3_000, ledgerBalance: 3_000, difference: 0 }]);
  });

  it('repite sin duplicar, y rechaza bodegas iguales, existencias insuficientes y servicios', async () => {
    const item = await newItem();
    const north = await inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Norte' });
    const main = await inventory.ensureDefaultWarehouse(tenant);
    await adjust(item, 'in', 5);
    const body = { itemId: String(item._id), fromWarehouseId: String(main._id), toWarehouseId: String(north._id), date: TODAY, quantity: units(2) };
    const key = 'traspaso-1-aaaaaaaa';
    const first = await inventory.transfer(tenant, body, ctx(key));
    expect((await inventory.transfer(tenant, body, ctx(key))).replayed).toBe(true);
    expect(await stockOf(item, north)).toMatchObject({ quantity: 2_000 });
    expect(await code(inventory.transfer(tenant, { ...body, toWarehouseId: String(main._id) }, ctx()))).toBe('VALIDATION');
    expect(await code(inventory.transfer(tenant, { ...body, quantity: units(10) }, ctx()))).toBe('INSUFFICIENT_STOCK');
    expect(await code(inventory.transfer(tenant, { ...body, quantity: 0 }, ctx()))).toBe('VALIDATION');
    const service = await inventory.createItem(tenant, { sku: 'SV', name: 'Servicio', type: 'service' });
    expect(await code(inventory.transfer(tenant, { ...body, itemId: String(service._id) }, ctx()))).toBe('VALIDATION');
    expect(first.doc.fullNumber).toBe('TR1');
    expect((await inventory.listStockDocs(tenant, { kind: 'transfer' })).items).toHaveLength(1);
  });

  it('traspasos simultáneos desde la misma bodega: solo caben los que hay', async () => {
    const item = await newItem();
    const north = await inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Norte' });
    const main = await inventory.ensureDefaultWarehouse(tenant);
    await adjust(item, 'in', 6);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => inventory.transfer(tenant, { itemId: String(item._id), fromWarehouseId: String(main._id), toWarehouseId: String(north._id), date: TODAY, quantity: units(2) }, ctx())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stockOf(item, main)).toMatchObject({ quantity: 0, value: 0 });
    expect(await stockOf(item, north)).toMatchObject({ quantity: 6_000, value: 600 });
  });
});

describe('kardex, valoración y mínimos', () => {
  it('el kardex se pagina y se filtra por bodega y fechas', async () => {
    const item = await newItem();
    const north = await inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Norte' });
    for (let i = 1; i <= 5; i += 1) await adjust(item, 'in', i);
    await adjust(item, 'in', 9, { warehouseId: String(north._id), date: '2026-10-01' });
    const first = await inventory.kardex(tenant, { itemId: String(item._id), limit: 2 });
    expect(first.items.map((m) => m.quantity)).toEqual([1_000, 2_000]);
    const second = await inventory.kardex(tenant, { itemId: String(item._id), limit: 10, cursor: first.nextCursor });
    expect(second.items).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const only = await inventory.kardex(tenant, { itemId: String(item._id), warehouseId: String(north._id) });
    expect(only.items.map((m) => m.quantity)).toEqual([9_000]);
    expect((await inventory.kardex(tenant, { itemId: String(item._id), from: '2026-10-02', to: '2026-10-31' })).items).toHaveLength(5);
    expect((await inventory.kardex(tenant, { itemId: String(item._id), from: '2026-10-01', to: '2026-10-01' })).items).toHaveLength(1);
    expect(await code(inventory.kardex(tenant, { itemId: String(item._id), from: 'ayer' }))).toBe('VALIDATION');
    expect((await inventory.kardex(toTenantId(new ObjectId()), { itemId: String(item._id) })).items).toEqual([]);
  });

  it('valora por artículo y bodega y cuadra con el libro; un asiento manual sobre la cuenta se ve como diferencia', async () => {
    const a = await newItem({ sku: 'A', name: 'A' });
    const b = await newItem({ sku: 'B', name: 'B', inventoryAccount: '143510' });
    await adjust(a, 'in', 10, { unitCost: 150 });
    await adjust(b, 'in', 4, { unitCost: 2_500 });
    const valuation = await inventory.valuation(tenant);
    expect(valuation.rows.map((r) => [r.sku, r.warehouseCode, r.quantity, r.value, r.averageCost])).toEqual([
      ['A', 'PRINCIPAL', 10_000, 1_500, 150],
      ['B', 'PRINCIPAL', 4_000, 10_000, 2_500],
    ]);
    expect(valuation.total).toBe(11_500);
    expect(valuation.accounts.every((x) => x.difference === 0)).toBe(true);
    await ledger.postJournal(tenant, { docType: 'CC', date: new Date(`${TODAY}T12:00:00Z`), currency: 'COP', idempotencyKey: 'manual-1-aaaaaaaa', lines: [{ accountId: '143505', debit: 77 }, { accountId: '310505', credit: 77 }] });
    const after = await inventory.valuation(tenant);
    expect(after.accounts.find((x) => x.account === '143505')).toEqual({ account: '143505', stockValue: 1_500, ledgerBalance: 1_577, difference: -77 });
    expect((await inventory.valuation(toTenantId(new ObjectId()))).rows).toEqual([]);
  });

  it('avisa de los bienes bajo su mínimo, sumando bodegas', async () => {
    const low = await newItem({ sku: 'LOW', name: 'Poco', minStock: 10_000 });
    const ok = await newItem({ sku: 'OK', name: 'Suficiente', minStock: 3_000 });
    await newItem({ sku: 'NOMIN', name: 'Sin mínimo' });
    const north = await inventory.createWarehouse(tenant, { code: 'NORTE', name: 'Norte' });
    await adjust(low, 'in', 4);
    await adjust(low, 'in', 3, { warehouseId: String(north._id) });
    await adjust(ok, 'in', 3);
    expect(await inventory.lowStock(tenant)).toMatchObject([{ sku: 'LOW', onHand: 7_000, minStock: 10_000 }]);
    await adjust(low, 'in', 3);
    expect(await inventory.lowStock(tenant)).toEqual([]);
  });
});
