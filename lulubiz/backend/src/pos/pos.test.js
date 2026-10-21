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
import { createPosService } from './pos.js';

const TODAY = new Date().toISOString().slice(0, 10);

let mongo;
let db;
let ledger;
let accounts;
let parties;
let settings;
let inventory;
let pos;
let tenant;
let register;
let n = 0;
const user = new ObjectId();

const fresh = (label = 'k') => `${label}-${(n += 1)}-aaaaaaaa`;
const ctx = (key = fresh()) => ({ idempotencyKey: key, userId: user });
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('111005', 'Bancos', 'asset', '1');
  await make('112005', 'Datáfono por cobrar', 'asset', '1');
  await make('130505', 'Clientes', 'asset', '1');
  await make('143505', 'Mercancías no fabricadas', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital social', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('429595', 'Sobrantes de caja', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('529595', 'Pérdida de inventario', 'expense', '5');
  await make('530595', 'Faltantes de caja', 'expense', '5');
  await make('6', 'Costos de ventas', 'cost');
  await make('613505', 'Costo de mercancía vendida', 'cost', '6');
}

const makeItem = (patch = {}) => inventory.createItem(tenant, { sku: 'TORN-1', name: 'Tornillo', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', ...patch });
const receive = (item, units, unitCost) =>
  inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: units * 1000, unitCost, counterAccount: '310505', reason: 'Saldo' }, ctx());
const stockRow = (item) => db.collection(COLLECTIONS.stock).findOne({ tenantId: tenant, itemId: item._id });
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};
const expectReconciled = async () => {
  const v = await inventory.valuation(tenant);
  for (const a of v.accounts) expect(a.difference, `cuenta ${a.account}`).toBe(0);
};

const freeLine = (patch = {}) => ({ description: 'Servicio de armado', quantity: 1000, unitPrice: 10_000, vatBps: 1900, ...patch });
const itemLine = (item, units, patch = {}) => ({ description: item.name, itemId: String(item._id), quantity: units * 1000, unitPrice: 25_000, vatBps: 1900, ...patch });
const saleInput = (lines, payments, patch = {}) => ({ registerId: String(register._id), date: TODAY, lines, payments, ...patch });
const sell = async (lines, payments, patch, key) => (await pos.createSale(tenant, saleInput(lines, payments, patch), ctx(key))).sale;
const cash = (amount) => ({ method: 'cash', amount });
const openShift = (openingCash = 50_000) => pos.openShift(tenant, String(register._id), { openingCash }, ctx());
const shiftOf = (shift) => db.collection(COLLECTIONS.posShifts).findOne({ _id: shift._id });
const journalOf = (id) => ledger.getJournal(tenant, id);

beforeAll(async () => {
  mongo = await startMongo('lulubiz_pos_test');
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
  await openChart();
  await settings.save(tenant, {
    issuer: { name: 'Ferretería Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
    accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
  });
  inventory = createInventoryService({ client: mongo.client, db, ledger, accounts });
  pos = createPosService({ client: mongo.client, db, ledger, accounts, parties, settings, inventory });
  register = await pos.createRegister(tenant, { code: 'caja1', name: 'Caja del mostrador', accounts: { cash: '110505', card: '112005', transfer: '111005' } });
});

describe('cajas', () => {
  it('crea una caja con sus cuentas y rechaza duplicados y cuentas que no son de activo', async () => {
    expect(register).toMatchObject({ code: 'CAJA1', name: 'Caja del mostrador', active: true, lastSale: 0, accounts: { cash: '110505', card: '112005', transfer: '111005' } });
    expect(await code(pos.createRegister(tenant, { code: 'CAJA1', name: 'Otra', accounts: { cash: '110505' } }))).toBe('DUPLICATE');
    expect(await code(pos.createRegister(tenant, { code: 'C2', name: 'Otra', accounts: { cash: '413505' } }))).toBe('VALIDATION'); // ingresos no es activo
    expect(await code(pos.createRegister(tenant, { code: 'C2', name: 'Otra', accounts: { card: '112005' } }))).toBe('VALIDATION'); // sin efectivo
    expect(await code(pos.createRegister(tenant, { code: 'C 2', name: 'Otra', accounts: { cash: '110505' } }))).toBe('VALIDATION');
    expect(await code(pos.createRegister(tenant, { code: 'C2', name: 'Otra', accounts: { cash: '999999' } }))).toBe('VALIDATION');
  });

  it('con un turno abierto no se cambian sus cuentas ni se desactiva', async () => {
    await openShift();
    expect(await code(pos.updateRegister(tenant, String(register._id), { accounts: { cash: '110505' } }))).toBe('SHIFT_OPEN');
    expect(await code(pos.updateRegister(tenant, String(register._id), { active: false }))).toBe('SHIFT_OPEN');
    expect((await pos.updateRegister(tenant, String(register._id), { name: 'Mostrador 1' })).name).toBe('Mostrador 1');
  });

  it('la lista trae el turno abierto de cada caja', async () => {
    const other = await pos.createRegister(tenant, { code: 'CAJA2', name: 'Segunda', accounts: { cash: '110505' } });
    const shift = await openShift();
    const list = await pos.listRegisters(tenant);
    expect(list.map((r) => [r.code, r.openShift ? String(r.openShift._id) : null])).toEqual([['CAJA1', String(shift._id)], ['CAJA2', null]]);
    void other;
  });
});

describe('turnos', () => {
  it('abre con efectivo inicial y no deja abrir otro en la misma caja', async () => {
    const shift = await openShift(50_000);
    expect(shift).toMatchObject({ status: 'open', openingCash: 50_000, registerCode: 'CAJA1', salesCount: 0, cashTotal: 0 });
    expect(await code(openShift())).toBe('SHIFT_OPEN');
    expect(await code(pos.openShift(tenant, String(register._id), { openingCash: -1 }, ctx()))).toBe('VALIDATION');
    expect(await code(pos.openShift(tenant, String(new ObjectId()), {}, ctx()))).toBe('NOT_FOUND');
  });

  it('dos aperturas a la vez: solo una se abre', async () => {
    const results = await Promise.allSettled([openShift(), openShift()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.collection(COLLECTIONS.posShifts).countDocuments({ tenantId: tenant, status: 'open' })).toBe(1);
  });

  it('sin turno abierto no se vende', async () => {
    expect(await code(pos.createSale(tenant, saleInput([freeLine()], [cash(11_900)]), ctx()))).toBe('NO_SHIFT');
  });
});

describe('venta', () => {
  it('una venta en efectivo con IVA: asiento PV cuadrado, consecutivo de la caja y totales del turno', async () => {
    const shift = await openShift();
    const sale = await sell([freeLine()], [cash(11_900)]);
    expect(sale).toMatchObject({ status: 'posted', fullNumber: 'CAJA1-000001', number: 1, totals: { subtotal: 10_000, tax: 1_900, total: 11_900 } });
    expect(sale.customer).toBeUndefined();

    const journal = await journalOf(sale.journalId);
    expect(journal).toMatchObject({ docType: 'PV', totalDebit: 11_900, totalCredit: 11_900 });
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: '110505', debit: 11_900 }),
        expect.objectContaining({ accountId: '413505', credit: 10_000 }),
        expect.objectContaining({ accountId: '240805', credit: 1_900 }),
      ]),
    );
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 1, salesTotal: 11_900, cashTotal: 11_900, cardTotal: 0, transferTotal: 0 });
    const second = await sell([freeLine()], [cash(11_900)]);
    expect(second.fullNumber).toBe('CAJA1-000002');
  });

  it('pagos mixtos van cada uno a su cuenta y suman el total', async () => {
    const shift = await openShift();
    const sale = await sell([freeLine({ quantity: 10_000 })], [cash(50_000), { method: 'card', amount: 40_000 }, { method: 'transfer', amount: 29_000 }]);
    expect(sale.totals.total).toBe(119_000);
    const journal = await journalOf(sale.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: '110505', debit: 50_000 }),
        expect.objectContaining({ accountId: '112005', debit: 40_000 }),
        expect.objectContaining({ accountId: '111005', debit: 29_000 }),
      ]),
    );
    expect(await shiftOf(shift)).toMatchObject({ cashTotal: 50_000, cardTotal: 40_000, transferTotal: 29_000, salesTotal: 119_000 });
  });

  it('el efectivo recibido calcula el cambio, sin tocar el asiento', async () => {
    await openShift();
    const sale = await sell([freeLine()], [cash(11_900)], { cashTendered: 20_000 });
    expect(sale).toMatchObject({ cashTendered: 20_000, change: 8_100 });
    expect(await ledgerNet('110505')).toBe(11_900);
    expect(await code(pos.createSale(tenant, saleInput([freeLine()], [cash(11_900)], { cashTendered: 10_000 }), ctx()))).toBe('VALIDATION');
    expect(await code(pos.createSale(tenant, saleInput([freeLine()], [{ method: 'card', amount: 11_900 }], { cashTendered: 20_000 }), ctx()))).toBe('VALIDATION');
  });

  it('rechaza pagos que no suman, repetidos, de un método sin cuenta o inválidos, sin dejar nada', async () => {
    const shift = await openShift();
    const lone = await pos.createRegister(tenant, { code: 'SOLO', name: 'Solo efectivo', accounts: { cash: '110505' } });
    await pos.openShift(tenant, String(lone._id), {}, ctx());
    const attempt = (payments, input = saleInput([freeLine()], payments)) => code(pos.createSale(tenant, input, ctx()));
    expect(await attempt([cash(10_000)])).toBe('VALIDATION');
    expect(await attempt([cash(12_000)])).toBe('VALIDATION');
    expect(await attempt([cash(5_000), cash(6_900)])).toBe('VALIDATION');
    expect(await attempt([])).toBe('VALIDATION');
    expect(await attempt([{ method: 'bitcoin', amount: 11_900 }])).toBe('VALIDATION');
    expect(await attempt([cash(0)])).toBe('VALIDATION');
    expect(await attempt([{ method: 'card', amount: 11_900 }], saleInput([freeLine()], [{ method: 'card', amount: 11_900 }], { registerId: String(lone._id) }))).toBe('VALIDATION');
    expect(await db.collection(COLLECTIONS.posSales).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 0, cashTotal: 0 });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'PV' })).toBe(0);
  });

  it('valida líneas, cliente y configuración', async () => {
    await openShift();
    const attempt = (lines, patch = {}) => code(pos.createSale(tenant, saleInput(lines, [cash(11_900)], patch), ctx()));
    expect(await attempt([])).toBe('VALIDATION');
    expect(await attempt([freeLine({ description: '' })])).toBe('VALIDATION');
    expect(await attempt([freeLine({ vatBps: 1600 })])).toBe('VALIDATION');
    expect(await attempt([freeLine({ quantity: 0 })])).toBe('VALIDATION');
    expect(await attempt([freeLine()], { customerId: String(new ObjectId()) })).toBe('NOT_FOUND');
    const supplier = await parties.create(tenant, { name: 'Proveedor', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
    expect(await attempt([freeLine()], { customerId: String(supplier._id) })).toBe('VALIDATION');
    expect(await attempt([freeLine()], { registerId: String(new ObjectId()) })).toBe('NOT_FOUND');
    expect(await attempt([freeLine()], { date: '2999-01-01' })).toBe('VALIDATION');

    await db.collection(COLLECTIONS.settings).updateOne({ tenantId: tenant }, { $unset: { 'accounts.vatPayable': '' } });
    expect(await attempt([freeLine()])).toBe('SETTINGS_INCOMPLETE');
  });

  it('con cliente identificado lo guarda en la venta', async () => {
    await openShift();
    const customer = await parties.create(tenant, { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
    const sale = await sell([freeLine()], [cash(11_900)], { customerId: String(customer._id) });
    expect(sale.customer).toMatchObject({ name: 'Droguería Los Andes', taxId: '800197268' });
  });

  it('repetir la clave no vende dos veces', async () => {
    const shift = await openShift();
    const key = fresh('sale');
    const first = await pos.createSale(tenant, saleInput([freeLine()], [cash(11_900)]), ctx(key));
    const again = await pos.createSale(tenant, saleInput([freeLine()], [cash(11_900)]), ctx(key));
    expect(again.replayed).toBe(true);
    expect(again.sale._id).toEqual(first.sale._id);
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 1, salesTotal: 11_900 });
    expect(await ledgerNet('110505')).toBe(11_900);
  });

  it('ventas simultáneas: consecutivos distintos y seguidos, y totales exactos', async () => {
    const shift = await openShift();
    const sales = await Promise.all(Array.from({ length: 12 }, () => sell([freeLine()], [cash(11_900)])));
    expect(sales.map((s) => s.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 12, salesTotal: 12 * 11_900, cashTotal: 12 * 11_900 });
    expect(await ledgerNet('110505')).toBe(12 * 11_900);
    expect((await db.collection(COLLECTIONS.posRegisters).findOne({ _id: register._id })).lastSale).toBe(12);
  });
});

describe('venta de bienes del inventario', () => {
  it('saca la existencia al costo promedio y asienta costo de ventas contra inventario', async () => {
    const item = await makeItem({ incomeAccount: '413505' });
    await receive(item, 10, 10_000);
    await openShift();
    const sale = await sell([itemLine(item, 4)], [cash(119_000)]);
    expect(sale.stockCost).toEqual([40_000]);
    expect(await stockRow(item)).toMatchObject({ quantity: 6_000, value: 60_000 });
    const journal = await journalOf(sale.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: '613505', debit: 40_000 }), expect.objectContaining({ accountId: '143505', credit: 40_000 })]),
    );
    expect(await ledgerNet('613505')).toBe(40_000);
    await expectReconciled();
    expect((await inventory.kardex(tenant, { itemId: String(item._id) })).items.at(-1)).toMatchObject({ type: 'pos_sale', quantity: -4_000, value: -40_000 });
  });

  it('sin existencias suficientes la venta entera se rechaza y no cambia nada', async () => {
    const item = await makeItem();
    await receive(item, 3, 10_000);
    const shift = await openShift();
    expect(await code(pos.createSale(tenant, saleInput([itemLine(item, 4)], [cash(119_000)]), ctx()))).toBe('INSUFFICIENT_STOCK');
    expect(await stockRow(item)).toMatchObject({ quantity: 3_000 });
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 0, cashTotal: 0 });
    expect((await db.collection(COLLECTIONS.posRegisters).findOne({ _id: register._id })).lastSale).toBe(0);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'PV' })).toBe(0);
  });

  it('rechaza servicios con artículo, inactivos e inexistentes', async () => {
    const item = await makeItem();
    await receive(item, 5, 10_000);
    const service = await inventory.createItem(tenant, { sku: 'INSTALA', name: 'Instalación', type: 'service', incomeAccount: '413505' });
    const dead = await makeItem({ sku: 'VIEJO', name: 'Viejo' });
    await inventory.updateItem(tenant, String(dead._id), { active: false });
    await openShift();
    const attempt = (l) => code(pos.createSale(tenant, saleInput([l], [cash(29_750)]), ctx()));
    expect(await attempt(itemLine(service, 1))).toBe('VALIDATION');
    expect(await attempt(itemLine(dead, 1))).toBe('VALIDATION');
    expect(await attempt(itemLine(item, 1, { itemId: String(new ObjectId()) }))).toBe('NOT_FOUND');
  });

  it('dos ventas a la vez que no caben las dos: una se vende y la otra se rechaza, sin existencia negativa', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const shift = await openShift();
    const results = await Promise.allSettled([sell([itemLine(item, 6)], [cash(178_500)]), sell([itemLine(item, 6)], [cash(178_500)])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockRow(item)).toMatchObject({ quantity: 4_000, value: 40_000 });
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 1 });
    await expectReconciled();
  });

  it('dos ventas a la vez que caben ambas: las dos salen', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    await openShift();
    await Promise.all([sell([itemLine(item, 5)], [cash(148_750)]), sell([itemLine(item, 5)], [cash(148_750)])]);
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    expect(await ledgerNet('613505')).toBe(100_000);
    await expectReconciled();
  });

  it('usa la bodega de la caja', async () => {
    const item = await makeItem();
    const south = await inventory.createWarehouse(tenant, { code: 'SUR', name: 'Sur' });
    await inventory.adjust(tenant, { itemId: String(item._id), warehouseId: String(south._id), date: TODAY, direction: 'in', quantity: 5_000, unitCost: 10_000, counterAccount: '310505', reason: 'x' }, ctx());
    const sur = await pos.createRegister(tenant, { code: 'SUR1', name: 'Caja sur', accounts: { cash: '110505' }, warehouseId: String(south._id) });
    await pos.openShift(tenant, String(sur._id), {}, ctx());
    await pos.createSale(tenant, { registerId: String(sur._id), date: TODAY, lines: [itemLine(item, 2)], payments: [cash(59_500)] }, ctx());
    const row = await db.collection(COLLECTIONS.stock).findOne({ tenantId: tenant, itemId: item._id, warehouseId: south._id });
    expect(row).toMatchObject({ quantity: 3_000, value: 30_000 });
  });
});

describe('anular una venta', () => {
  it('reversa el asiento, regresa los bienes al costo al que salieron y corrige el turno', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const shift = await openShift();
    const sale = await sell([itemLine(item, 4)], [cash(119_000)]);
    await receive(item, 10, 50_000); // el promedio de hoy ya no es el de la venta
    const before = await stockRow(item);

    const { sale: voided } = await pos.voidSale(tenant, String(sale._id), { reason: 'Error de digitación' }, ctx());
    expect(voided).toMatchObject({ status: 'void', voidReason: 'Error de digitación' });
    const after = await stockRow(item);
    expect(after.quantity - before.quantity).toBe(4_000);
    expect(after.value - before.value).toBe(40_000);
    expect(await ledgerNet('110505')).toBe(0);
    expect(await ledgerNet('613505')).toBe(0);
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 0, salesTotal: 0, cashTotal: 0, voidedCount: 1, voidedTotal: 119_000 });
    expect((await inventory.kardex(tenant, { itemId: String(item._id) })).items.at(-1)).toMatchObject({ type: 'pos_void', quantity: 4_000, value: 40_000 });
    await expectReconciled();
  });

  it('anular dos veces no repite nada, y exige motivo', async () => {
    const shift = await openShift();
    const sale = await sell([freeLine()], [cash(11_900)]);
    expect(await code(pos.voidSale(tenant, String(sale._id), {}, ctx()))).toBe('VALIDATION');
    await pos.voidSale(tenant, String(sale._id), { reason: 'x' }, ctx());
    const again = await pos.voidSale(tenant, String(sale._id), { reason: 'x' }, ctx());
    expect(again.replayed).toBe(true);
    expect(await shiftOf(shift)).toMatchObject({ salesCount: 0, voidedCount: 1, voidedTotal: 11_900 });
  });

  it('después del cierre del turno ya no se anula', async () => {
    const shift = await openShift(0);
    const sale = await sell([freeLine()], [cash(11_900)]);
    await pos.closeShift(tenant, String(shift._id), { countedCash: 11_900, date: TODAY }, ctx());
    expect(await code(pos.voidSale(tenant, String(sale._id), { reason: 'x' }, ctx()))).toBe('SHIFT_CLOSED');
    expect((await pos.getSale(tenant, String(sale._id))).status).toBe('posted');
  });
});

describe('cuentas de la diferencia de la caja', () => {
  const withDefaults = (patch = {}) =>
    pos.updateRegister(tenant, String(register._id), { accounts: { cash: '110505', card: '112005', transfer: '111005', shortage: '530595', surplus: '429595', ...patch } });

  it('solo acepta un gasto para faltantes y un ingreso para sobrantes', async () => {
    expect(await code(withDefaults({ shortage: '413505' }))).toBe('VALIDATION');
    expect(await code(withDefaults({ surplus: '530595' }))).toBe('VALIDATION');
    expect(await code(withDefaults({ shortage: '999999' }))).toBe('VALIDATION');
    expect((await withDefaults()).accounts).toMatchObject({ shortage: '530595', surplus: '429595' });
  });

  it('el cierre usa las de la caja sin que se indique una cuenta', async () => {
    await withDefaults();
    const a = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    const short = await pos.closeShift(tenant, String(a._id), { countedCash: 10_000, date: TODAY }, ctx());
    expect((await journalOf(short.shift.closeJournalId)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '530595', debit: 1_900 })]));
    const b = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    const over = await pos.closeShift(tenant, String(b._id), { countedCash: 12_000, date: TODAY }, ctx());
    expect((await journalOf(over.shift.closeJournalId)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '429595', credit: 100 })]));
  });

  it('sin cuentas en la caja ni indicadas, pide configurarlas', async () => {
    const shift = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    const err = await pos.closeShift(tenant, String(shift._id), { countedCash: 10_000, date: TODAY }, ctx()).catch((e) => e);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/configúrala en Cajas/);
  });
});

describe('cierre de turno', () => {
  it('con el efectivo exacto cierra sin asiento', async () => {
    const shift = await openShift(50_000);
    await sell([freeLine()], [cash(11_900)]);
    await sell([freeLine()], [{ method: 'card', amount: 11_900 }]);
    const { shift: closed, replayed } = await pos.closeShift(tenant, String(shift._id), { countedCash: 61_900, date: TODAY }, ctx());
    expect(replayed).toBe(false);
    expect(closed).toMatchObject({ status: 'closed', expectedCash: 61_900, countedCash: 61_900, difference: 0 });
    expect(closed.closeJournalId).toBeUndefined();
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant, docType: 'CJ' })).toBe(0);
  });

  it('un faltante se asienta contra la cuenta indicada y baja la caja', async () => {
    const shift = await openShift(50_000);
    await sell([freeLine()], [cash(11_900)]);
    const { shift: closed } = await pos.closeShift(tenant, String(shift._id), { countedCash: 60_000, counterAccount: '530595', date: TODAY }, ctx());
    expect(closed).toMatchObject({ expectedCash: 61_900, countedCash: 60_000, difference: -1_900 });
    const journal = await journalOf(closed.closeJournalId);
    expect(journal).toMatchObject({ docType: 'CJ', totalDebit: 1_900 });
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '530595', debit: 1_900 }), expect.objectContaining({ accountId: '110505', credit: 1_900 })]));
    expect(await ledgerNet('110505')).toBe(11_900 - 1_900);
  });

  it('un sobrante entra a la caja contra la cuenta indicada', async () => {
    const shift = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    const { shift: closed } = await pos.closeShift(tenant, String(shift._id), { countedCash: 12_000, counterAccount: '429595', date: TODAY }, ctx());
    expect(closed.difference).toBe(100);
    const journal = await journalOf(closed.closeJournalId);
    expect(journal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: '110505', debit: 100 }), expect.objectContaining({ accountId: '429595', credit: 100 })]));
  });

  it('con diferencia exige la cuenta, y no puede ser la de efectivo', async () => {
    const shift = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    expect(await code(pos.closeShift(tenant, String(shift._id), { countedCash: 10_000, date: TODAY }, ctx()))).toBe('VALIDATION');
    expect(await code(pos.closeShift(tenant, String(shift._id), { countedCash: 10_000, counterAccount: '110505', date: TODAY }, ctx()))).toBe('VALIDATION');
    expect(await code(pos.closeShift(tenant, String(shift._id), { countedCash: -5, date: TODAY }, ctx()))).toBe('VALIDATION');
    expect((await pos.getShift(tenant, String(shift._id))).status).toBe('open');
  });

  it('las ventas anuladas no cuentan en el efectivo esperado', async () => {
    const shift = await openShift(0);
    const keep = await sell([freeLine()], [cash(11_900)]);
    const drop = await sell([freeLine()], [cash(11_900)]);
    await pos.voidSale(tenant, String(drop._id), { reason: 'x' }, ctx());
    const { shift: closed } = await pos.closeShift(tenant, String(shift._id), { countedCash: 11_900, date: TODAY }, ctx());
    expect(closed).toMatchObject({ expectedCash: 11_900, difference: 0, voidedCount: 1 });
    void keep;
  });

  it('cerrar de nuevo devuelve lo mismo, y después no se vende hasta abrir otro turno', async () => {
    const shift = await openShift(0);
    await pos.closeShift(tenant, String(shift._id), { countedCash: 0, date: TODAY }, ctx());
    const again = await pos.closeShift(tenant, String(shift._id), { countedCash: 999, date: TODAY }, ctx());
    expect(again.replayed).toBe(true);
    expect(again.shift.countedCash).toBe(0);
    expect(await code(pos.createSale(tenant, saleInput([freeLine()], [cash(11_900)]), ctx()))).toBe('NO_SHIFT');
    const next = await openShift(5_000);
    expect(next.status).toBe('open');
    expect(String(next._id)).not.toBe(String(shift._id));
  });

  it('una venta que entra mientras se cierra: el cierre cuenta todo lo vendido o la venta se rechaza, nunca queda fuera', async () => {
    const shift = await openShift(0);
    await sell([freeLine()], [cash(11_900)]);
    const results = await Promise.allSettled([
      sell([freeLine()], [cash(11_900)]),
      pos.closeShift(tenant, String(shift._id), { countedCash: 11_900, counterAccount: '429595', date: TODAY }, ctx()),
    ]);
    const closed = await shiftOf(shift);
    const sold = results[0].status === 'fulfilled';
    expect(closed.status).toBe('closed');
    // El efectivo esperado siempre coincide con lo cobrado en efectivo que quedó registrado en el turno.
    expect(closed.expectedCash).toBe(closed.cashTotal);
    expect(closed.cashTotal).toBe(sold ? 23_800 : 11_900);
    const posted = await db.collection(COLLECTIONS.posSales).countDocuments({ tenantId: tenant, shiftId: shift._id, status: 'posted' });
    expect(posted).toBe(sold ? 2 : 1);
  });
});

describe('coherencia con el libro', () => {
  it('tras vender, anular y cerrar, el efectivo del libro es lo cobrado menos lo anulado más el sobrante', async () => {
    const item = await makeItem();
    await receive(item, 20, 10_000);
    const shift = await openShift(100_000);
    const a = await sell([itemLine(item, 3)], [cash(89_250)]);
    await sell([freeLine()], [cash(5_000), { method: 'card', amount: 6_900 }]);
    await sell([itemLine(item, 2)], [{ method: 'transfer', amount: 59_500 }]);
    await pos.voidSale(tenant, String(a._id), { reason: 'x' }, ctx());
    await pos.closeShift(tenant, String(shift._id), { countedCash: 105_050, counterAccount: '429595', date: TODAY }, ctx()); // esperado 105 000
    expect(await ledgerNet('110505')).toBe(5_000 + 50);
    expect(await ledgerNet('112005')).toBe(6_900);
    expect(await ledgerNet('111005')).toBe(59_500);
    expect(await ledgerNet('413505')).toBe(-60_000);
    await expectReconciled();
    const closed = await shiftOf(shift);
    expect(closed).toMatchObject({ salesCount: 2, voidedCount: 1, cashTotal: 5_000, cardTotal: 6_900, transferTotal: 59_500 });
  });
});
