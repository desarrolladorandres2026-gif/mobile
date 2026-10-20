import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createSettingsService } from '../invoicing/settings.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { startMongo } from '../testing/mongo.js';
import { createPayablesService } from './payables.js';
import { createPurchasesService, withholdingAmount } from './purchases.js';

const TODAY = '2026-10-20';
const NOW = new Date(`${TODAY}T15:00:00Z`);

let mongo;
let db;
let ledger;
let accounts;
let parties;
let settings;
let purchases;
let payables;
let tenant;
let supplier;
let other;
let n = 0;
const user = new ObjectId();

const ctx = (key) => ({ idempotencyKey: key, userId: user });
const fresh = (label) => `${label}-${(n += 1)}-aaaaaaaa`;
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

const settingsInput = (extra = {}) => ({
  issuer: { name: 'Comercial Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
  accounts: { receivable: '130505', income: '413505', vatPayable: '240805', payable: '220505', vatDeductible: '240810', ...extra },
});

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('111005', 'Bancos', 'asset', '1');
  await make('130505', 'Clientes', 'asset', '1');
  await make('143505', 'Mercancías', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('220505', 'Proveedores nacionales', 'liability', '2');
  await make('236540', 'Retención en la fuente por compras', 'liability', '2');
  await make('236701', 'ReteIVA por pagar', 'liability', '2');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('240810', 'IVA descontable', 'liability', '2');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('519595', 'Gastos diversos', 'expense', '5');
  await make('523525', 'Servicios públicos', 'expense', '5');
}

const line = (patch = {}) => ({ description: 'Servicio de aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595', ...patch });
const input = (patch = {}) => ({ supplierId: String(supplier._id), supplierDocNumber: 'sa-1001', issueDate: '2026-10-05', dueDate: '2026-11-04', lines: [line()], ...patch });
const rete = (patch = {}) => ({ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250, ...patch });
const buyOn = async (patch = {}) => (await purchases.createPurchase(tenant, input(patch), ctx(fresh('pur')))).purchase;
const buy = buyOn;
const reload = (doc) => db.collection(COLLECTIONS.purchases).findOne({ _id: doc._id });
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};

beforeAll(async () => {
  mongo = await startMongo('lulubiz_purchases_test');
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
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Comercial Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  supplier = await parties.create(tenant, { name: 'Aseo Total SAS', roles: ['supplier'], taxIdType: 'NIT', taxId: '900123456', checkDigit: 8 });
  other = await parties.create(tenant, { name: 'Papelería Central', roles: ['supplier'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  await openChart();
  await settings.save(tenant, settingsInput());
  purchases = createPurchasesService({ client: mongo.client, db, ledger, accounts, parties, settings, now: () => NOW });
  payables = createPayablesService({ db, ledger, accounts, parties, now: () => NOW });
});

describe('retenciones', () => {
  it('se calculan con enteros, medio hacia arriba', () => {
    expect(withholdingAmount(1_000_000, 250)).toBe(25_000);
    expect(withholdingAmount(1_001, 250)).toBe(25); // 25,025 → 25
    expect(withholdingAmount(1_020, 250)).toBe(26); // 25,5 → 26
    expect(withholdingAmount(0, 250)).toBe(0);
    expect(() => withholdingAmount(100, 0)).toThrow(/tarifa/);
    expect(() => withholdingAmount(100, 10_001)).toThrow(/tarifa/);
    expect(() => withholdingAmount(-1, 100)).toThrow(/base/);
  });
});

describe('configuración de compras', () => {
  it('dice qué falta y con las cuentas queda lista', async () => {
    await settings.save(tenant, settingsInput({ payable: '', vatDeductible: '' }));
    const before = await purchases.status(tenant);
    expect(before).toMatchObject({ ready: false, country: 'CO', currency: 'COP', vatRatesBps: [0, 500, 1900] });
    expect(before.missing).toEqual(['la cuenta de proveedores', 'la cuenta de IVA descontable']);
    expect(await code(purchases.createPurchase(tenant, input(), ctx(fresh('p'))))).toBe('SETTINGS_INCOMPLETE');
    await settings.save(tenant, settingsInput());
    expect(await purchases.status(tenant)).toMatchObject({ ready: true, missing: [] });
  });
});

describe('factura de compra', () => {
  it('registra con IVA y retenciones: asiento FC cuadrado y saldo igual a lo que se debe', async () => {
    const p = await buy({ withholdings: [rete()] });
    expect(p).toMatchObject({ fullNumber: 'FC1', status: 'posted', supplierDocNumber: 'SA-1001', currency: 'COP', withheld: 25_000, payable: 1_165_000, paidTotal: 0, balance: 1_165_000, creditStatus: 'none' });
    expect(p.totals).toMatchObject({ subtotal: 1_000_000, tax: 190_000, total: 1_190_000 });
    expect(p.withholdings).toEqual([{ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rateBps: 250, base: 1_000_000, amount: 25_000 }]);

    const journal = await ledger.getJournal(tenant, p.journalId);
    expect(journal).toMatchObject({ docType: 'FC', totalDebit: 1_190_000, totalCredit: 1_190_000, source: { kind: 'purchase' } });
    expect(journal.lines).toEqual([
      { accountId: '519595', debit: 1_000_000, credit: 0 },
      { accountId: '240810', debit: 190_000, credit: 0 },
      { accountId: '220505', debit: 0, credit: 1_165_000 },
      { accountId: '236540', debit: 0, credit: 25_000 },
    ]);
    expect(await ledgerNet('220505')).toBe(-1_165_000);
  });

  it('una línea sobre un activo y otra sobre un gasto agrupan por cuenta; sin IVA no hay línea de IVA', async () => {
    const p = await buy({
      supplierDocNumber: 'X-2',
      lines: [line({ vatBps: 0, accountId: '143505', unitPrice: 300_000 }), line({ vatBps: 0, accountId: '519595', unitPrice: 200_000 }), line({ vatBps: 0, accountId: '519595', unitPrice: 100_000 })],
    });
    const journal = await ledger.getJournal(tenant, p.journalId);
    expect(journal.lines).toEqual([
      { accountId: '143505', debit: 300_000, credit: 0 },
      { accountId: '519595', debit: 300_000, credit: 0 },
      { accountId: '220505', debit: 0, credit: 600_000 },
    ]);
  });

  it('repetir la clave devuelve la misma factura; el mismo número del proveedor es un duplicado', async () => {
    const key = fresh('pur');
    const first = await purchases.createPurchase(tenant, input(), ctx(key));
    const again = await purchases.createPurchase(tenant, input(), ctx(key));
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, purchase: { _id: first.purchase._id } });
    expect(await code(purchases.createPurchase(tenant, input({ supplierDocNumber: ' SA-1001 ' }), ctx(fresh('pur'))))).toBe('DUPLICATE');
    // El mismo número de otro proveedor sí es otra factura.
    await purchases.createPurchase(tenant, input({ supplierId: String(other._id) }), ctx(fresh('pur')));
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({ tenantId: tenant })).toBe(2);
    expect(await ledgerNet('220505')).toBe(-2_380_000);
  });

  it('rechaza lo que no cuadra o no corresponde y no deja asientos a medias', async () => {
    const bad = async (patch, fn = (x) => x) => code(purchases.createPurchase(tenant, fn(input(patch)), ctx(fresh('pur'))));
    const customer = await parties.create(tenant, { name: 'Cliente', roles: ['customer'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 });
    expect(await bad({ supplierId: String(customer._id) })).toBe('VALIDATION');
    expect(await bad({ supplierId: String(new ObjectId()) })).toBe('NOT_FOUND');
    expect(await bad({ lines: [line({ accountId: '413505' })] })).toBe('VALIDATION'); // ingresos no es un gasto
    expect(await bad({ lines: [line({ accountId: '' })] })).toBe('VALIDATION');
    expect(await bad({ lines: [line({ accountId: '999999' })] })).toBe('VALIDATION');
    expect(await bad({ lines: [line({ vatBps: 1600 })] })).toBe('VALIDATION'); // tarifa inexistente en Colombia
    expect(await bad({ lines: [line({ quantity: 0 })] })).toBe('VALIDATION');
    expect(await bad({ lines: [line({ unitPrice: 0, vatBps: 0 })] })).toBe('VALIDATION'); // total en cero
    expect(await bad({ lines: [] })).toBe('VALIDATION');
    expect(await bad({ withholdings: [rete({ accountId: '110505' })] })).toBe('VALIDATION'); // la retención va a un pasivo
    expect(await bad({ withholdings: [rete({ basis: 'otra' })] })).toBe('VALIDATION');
    expect(await bad({ withholdings: [rete({ rateBps: 0 })] })).toBe('VALIDATION');
    expect(await bad({ withholdings: Array.from({ length: 11 }, () => rete()) })).toBe('VALIDATION');
    // Retener todo el subtotal y todo el IVA deja la factura sin valor por pagar.
    expect(await bad({ withholdings: [rete({ rateBps: 10_000 }), rete({ name: 'ReteIVA', accountId: '236701', basis: 'vat', rateBps: 10_000 })] })).toBe('VALIDATION');
    expect(await bad({ supplierDocNumber: '  ' })).toBe('VALIDATION');
    expect(await bad({ issueDate: '2099-01-01' })).toBe('VALIDATION'); // futura
    expect(await bad({ issueDate: '05/10/2026' })).toBe('VALIDATION');
    expect(await bad({ dueDate: '2026-10-01' })).toBe('VALIDATION'); // antes de la factura
    expect(await code(purchases.createPurchase(tenant, input(), {}))).toBe('VALIDATION'); // sin clave
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({})).toBe(0);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({})).toBe(0);
  });

  it('un período cerrado rechaza la compra completa', async () => {
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(purchases.createPurchase(tenant, input(), ctx(fresh('pur'))))).toBe('PeriodClosedError');
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({})).toBe(0);
  });

  it('lista del más reciente al más antiguo, con filtros y cursor, y sin cruzar empresas', async () => {
    for (let i = 1; i <= 5; i += 1) await buy({ supplierDocNumber: `F-${i}`, ...(i % 2 ? { supplierId: String(other._id) } : {}) });
    const first = await purchases.listPurchases(tenant, { limit: 2 });
    expect(first.items.map((p) => p.fullNumber)).toEqual(['FC5', 'FC4']);
    const second = await purchases.listPurchases(tenant, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((p) => p.fullNumber)).toEqual(['FC3', 'FC2']);
    expect((await purchases.listPurchases(tenant, { supplierId: String(supplier._id) })).items).toHaveLength(2);
    expect(await purchases.listPurchases(toTenantId(new ObjectId()), {})).toEqual({ items: [], nextCursor: null });
    expect(await purchases.getPurchase(toTenantId(new ObjectId()), String(first.items[0]._id))).toBeNull();
  });
});

describe('anular una factura de compra', () => {
  it('reversa el asiento y libera el número del proveedor', async () => {
    const p = await buy({ withholdings: [rete()] });
    const { purchase, replayed } = await purchases.voidPurchase(tenant, String(p._id), {}, ctx('x'));
    expect(replayed).toBe(false);
    expect(purchase).toMatchObject({ status: 'void', balance: 0 });
    expect(await ledgerNet('220505')).toBe(0);
    expect(await ledgerNet('519595')).toBe(0);
    expect((await purchases.voidPurchase(tenant, String(p._id), {}, ctx('x'))).replayed).toBe(true);
    // El proveedor puede volver a mandar el mismo número y se registra de nuevo.
    // (FC2 es el asiento de la anulación: comparte el consecutivo del tipo de documento.)
    expect((await buy()).fullNumber).toBe('FC3');
  });

  it('no se anula con pagos ni con notas de proveedor', async () => {
    const paid = await buy({ supplierDocNumber: 'P-1' });
    await payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: String(paid._id), amount: 1_000 }] }, ctx(fresh('pay')));
    expect(await code(purchases.voidPurchase(tenant, String(paid._id), {}, ctx('x')))).toBe('INVALID_STATE');

    const credited = await buy({ supplierDocNumber: 'P-2' });
    await purchases.createSupplierNote(tenant, String(credited._id), { all: true, reason: 'Devolución', supplierDocNumber: 'NC-1' }, ctx(fresh('np')));
    expect(await code(purchases.voidPurchase(tenant, String(credited._id), {}, ctx('x')))).toBe('INVALID_STATE');
  });

  it('un período cerrado impide anular y la factura queda vigente', async () => {
    const p = await buy();
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(purchases.voidPurchase(tenant, String(p._id), {}, ctx('x')))).toBe('PeriodClosedError');
    expect((await reload(p)).status).toBe('posted');
  });

  it('una factura inexistente o de otra empresa no se anula', async () => {
    expect(await code(purchases.voidPurchase(tenant, String(new ObjectId()), {}, ctx('x')))).toBe('NOT_FOUND');
    const p = await buy();
    expect(await code(purchases.voidPurchase(toTenantId(new ObjectId()), String(p._id), {}, ctx('x')))).toBe('NOT_FOUND');
  });
});

describe('notas de proveedor', () => {
  const two = (patch = {}) => buy({ lines: [line({ description: 'A', unitPrice: 600_000 }), line({ description: 'B', unitPrice: 400_000, vatBps: 500 })], withholdings: [rete()], ...patch });

  it('una devolución parcial reduce la deuda y devuelve la retención en proporción', async () => {
    const p = await two();
    // Total 1.000.000 + 114.000 + 20.000 IVA = 1.134.000; retención 25.000; se debe 1.109.000.
    expect(p).toMatchObject({ payable: 1_109_000 });
    const { note, replayed } = await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 1, quantity: 500 }], reason: 'Devolución parcial', supplierDocNumber: 'nc-77' }, ctx(fresh('np')));
    expect(replayed).toBe(false);
    // La mitad de B: neto 200.000, IVA 10.000; retención en proporción al total de la nota (210.000 / 1.134.000).
    expect(note).toMatchObject({ fullNumber: 'NP1', status: 'posted', supplierDocNumber: 'NC-77', totals: { subtotal: 200_000, tax: 10_000, total: 210_000 } });
    expect(note.withheld).toBe(Math.round((25_000 * 210_000) / 1_134_000));
    expect(note.effect).toBe(210_000 - note.withheld);
    const after = await reload(p);
    expect(after).toMatchObject({ creditedTotal: 210_000, balance: 1_109_000 - note.effect });
    expect(after.credited.quantity).toEqual([0, 500]);

    const journal = await ledger.getJournal(tenant, note.journalId);
    expect(journal).toMatchObject({ docType: 'NP', totalDebit: 210_000, totalCredit: 210_000 });
    expect(await ledgerNet('220505')).toBe(-(1_109_000 - note.effect));
  });

  it('acreditar todo en varias notas devuelve exactamente lo facturado, retenciones incluidas', async () => {
    const p = await two();
    await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 333 }], reason: 'a', supplierDocNumber: 'N-1' }, ctx(fresh('np')));
    await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 1, quantity: 700 }], reason: 'b', supplierDocNumber: 'N-2' }, ctx(fresh('np')));
    const rest = await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'c', supplierDocNumber: 'N-3' }, ctx(fresh('np')));
    expect(rest.note.fullNumber).toBe('NP3');
    const done = await reload(p);
    expect(done).toMatchObject({ creditedTotal: 1_134_000, creditedWithheld: [25_000], balance: 0 });
    expect(done.credited.quantity).toEqual([1000, 1000]);
    expect(await ledgerNet('220505')).toBe(0);
    expect(await ledgerNet('236540')).toBe(0);
    expect(await ledgerNet('519595')).toBe(0);
    expect(await ledgerNet('240810')).toBe(0);
    expect((await purchases.getPurchase(tenant, String(p._id))).creditStatus).toBe('full');
    expect(await code(purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'd', supplierDocNumber: 'N-4' }, ctx(fresh('np'))))).toBe('OVER_CREDIT');
  });

  it('no deja acreditar más de lo comprado ni líneas repetidas o inexistentes', async () => {
    const p = await two();
    const note = (lines, extra = {}) => code(purchases.createSupplierNote(tenant, String(p._id), { lines, reason: 'x', supplierDocNumber: fresh('N'), ...extra }, ctx(fresh('np'))));
    expect(await note([{ lineIndex: 0, quantity: 1001 }])).toBe('OVER_CREDIT');
    expect(await note([{ lineIndex: 5, quantity: 1 }])).toBe('VALIDATION');
    expect(await note([{ lineIndex: 0, quantity: 1 }, { lineIndex: 0, quantity: 1 }])).toBe('VALIDATION');
    expect(await note([])).toBe('OVER_CREDIT');
    expect(await note([{ lineIndex: 0, quantity: 1 }], { reason: ' ' })).toBe('VALIDATION');
    expect(await note([{ lineIndex: 0, quantity: 1 }], { issueDate: '2026-10-01' })).toBe('VALIDATION'); // antes de la factura
    expect((await reload(p)).creditedTotal).toBe(0);
  });

  it('dos notas simultáneas por todo: solo una cabe', async () => {
    const p = await two();
    const attempts = await Promise.allSettled([
      purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'S-1' }, ctx(fresh('np'))),
      purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'S-2' }, ctx(fresh('np'))),
      purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'S-3' }, ctx(fresh('np'))),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'OVER_CREDIT')).toBe(true);
    expect(await reload(p)).toMatchObject({ creditedTotal: 1_134_000, balance: 0 });
    expect(await ledgerNet('220505')).toBe(0);
  });

  it('repetir la clave devuelve la misma nota; el número del proveedor no se repite', async () => {
    const p = await two();
    const key = fresh('np');
    const first = await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 100 }], reason: 'x', supplierDocNumber: 'D-1' }, ctx(key));
    const again = await purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 100 }], reason: 'x', supplierDocNumber: 'D-1' }, ctx(key));
    expect(again).toMatchObject({ replayed: true, note: { _id: first.note._id } });
    expect((await reload(p)).credited.quantity[0]).toBe(100);
    expect(await code(purchases.createSupplierNote(tenant, String(p._id), { lines: [{ lineIndex: 0, quantity: 1 }], reason: 'x', supplierDocNumber: 'd-1' }, ctx(fresh('np'))))).toBe('DUPLICATE');
  });

  it('anular una nota libera lo reservado y restituye la deuda', async () => {
    const p = await two();
    const { note } = await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'V-1' }, ctx(fresh('np')));
    const voided = await purchases.voidSupplierNote(tenant, String(note._id), {}, ctx('x'));
    expect(voided.note.status).toBe('void');
    expect(await reload(p)).toMatchObject({ creditedTotal: 0, creditedWithheld: [0], balance: 1_109_000 });
    expect(await ledgerNet('220505')).toBe(-1_109_000);
    expect((await purchases.voidSupplierNote(tenant, String(note._id), {}, ctx('x'))).replayed).toBe(true);
    // Se puede volver a acreditar, y el número del proveedor quedó libre.
    await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'x', supplierDocNumber: 'V-1' }, ctx(fresh('np')));
    expect((await reload(p)).balance).toBe(0);
  });

  it('una nota sobre una factura ya pagada deja saldo a favor y no se cobra de más', async () => {
    const p = await buy({ supplierDocNumber: 'PAGADA' });
    await payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: String(p._id), amount: 1_190_000 }] }, ctx(fresh('pay')));
    await purchases.createSupplierNote(tenant, String(p._id), { all: true, reason: 'Devolución', supplierDocNumber: 'N-9' }, ctx(fresh('np')));
    expect((await reload(p)).balance).toBe(-1_190_000);
    expect(await ledgerNet('220505')).toBe(1_190_000); // saldo deudor: el proveedor nos debe
  });

  it('una nota de otra empresa o de una factura inexistente no existe', async () => {
    const p = await two();
    const body = { all: true, reason: 'x', supplierDocNumber: 'Z-1' };
    expect(await code(purchases.createSupplierNote(toTenantId(new ObjectId()), String(p._id), body, ctx(fresh('np'))))).toBe('NOT_FOUND');
    expect(await code(purchases.createSupplierNote(tenant, String(new ObjectId()), body, ctx(fresh('np'))))).toBe('NOT_FOUND');
    expect(await code(purchases.voidSupplierNote(tenant, String(new ObjectId()), {}, ctx('x')))).toBe('NOT_FOUND');
  });
});

describe('pagos a proveedores', () => {
  const pay = (purchase, amount) => ({ purchaseId: String(purchase._id), amount });
  const payment = (allocations, patch = {}, key = fresh('pay')) =>
    payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations, ...patch }, ctx(key));

  it('paga una factura completa: asiento CE, saldo en cero y dinero que sale de la cuenta', async () => {
    const p = await buy({ withholdings: [rete()] });
    const { payment: ce, replayed } = await payment([pay(p, 1_165_000)], { notes: 'Transferencia' });
    expect(replayed).toBe(false);
    expect(ce).toMatchObject({ fullNumber: 'CE1', status: 'posted', total: 1_165_000, paymentAccount: '110505', notes: 'Transferencia' });
    expect(ce.allocations).toEqual([{ purchaseId: p._id, purchaseFullNumber: 'FC1', supplierDocNumber: 'SA-1001', amount: 1_165_000 }]);
    expect(await reload(p)).toMatchObject({ paidTotal: 1_165_000, balance: 0 });
    const journal = await ledger.getJournal(tenant, ce.journalId);
    expect(journal).toMatchObject({ docType: 'CE', source: { kind: 'payment' } });
    expect(await ledgerNet('220505')).toBe(0);
    expect(await ledgerNet('110505')).toBe(-1_165_000);
  });

  it('repetir la clave no paga dos veces; los abonos suman y la numeración no deja huecos', async () => {
    const p = await buy();
    const key = fresh('pay');
    const first = await payment([pay(p, 400_000)], {}, key);
    expect((await payment([pay(p, 400_000)], {}, key)).replayed).toBe(true);
    const second = await payment([pay(p, 790_000)], { paymentAccount: '111005' });
    expect([first.payment.fullNumber, second.payment.fullNumber]).toEqual(['CE1', 'CE2']);
    expect(await reload(p)).toMatchObject({ paidTotal: 1_190_000, balance: 0 });
    expect(await ledgerNet('111005')).toBe(-790_000);
  });

  it('un pago puede aplicar a varias facturas con un solo crédito a la cuenta de caja', async () => {
    const a = await buy({ supplierDocNumber: 'A' });
    const b = await buy({ supplierDocNumber: 'B', lines: [line({ unitPrice: 500_000 })] });
    const { payment: ce } = await payment([pay(a, 1_190_000), pay(b, 100_000)]);
    const journal = await ledger.getJournal(tenant, ce.journalId);
    expect(journal.lines).toEqual([
      { accountId: '220505', debit: 1_290_000, credit: 0 },
      { accountId: '110505', debit: 0, credit: 1_290_000 },
    ]);
    expect((await reload(b)).balance).toBe(495_000);
  });

  it('pagar de más se rechaza sin cambiar nada; dos pagos simultáneos por todo, solo uno entra', async () => {
    const a = await buy({ supplierDocNumber: 'A' });
    const b = await buy({ supplierDocNumber: 'B', lines: [line({ unitPrice: 100_000 })] });
    expect(await code(payment([pay(a, 1_190_000), pay(b, 119_001)]))).toBe('OVER_PAYMENT');
    expect(await reload(a)).toMatchObject({ paidTotal: 0 });
    expect(await db.collection(COLLECTIONS.payments).countDocuments({})).toBe(0);

    const attempts = await Promise.allSettled([payment([pay(a, 1_190_000)]), payment([pay(a, 1_190_000)], { paymentAccount: '111005' }), payment([pay(a, 1_190_000)])]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'OVER_PAYMENT')).toBe(true);
    expect(await reload(a)).toMatchObject({ paidTotal: 1_190_000, balance: 0 });
  });

  it('valida proveedor, cuentas, fechas, duplicados e importes', async () => {
    const mine = await buy();
    const theirs = await buy({ supplierId: String(other._id), supplierDocNumber: 'O-1' });
    const bad = (allocations, patch) => code(payment(allocations, patch));
    expect(await bad([pay(theirs, 1_000)])).toBe('VALIDATION');
    expect(await bad([pay(mine, 1_000)], { paymentAccount: '519595' })).toBe('VALIDATION'); // un gasto no es caja
    expect(await bad([pay(mine, 1_000)], { paymentAccount: '220505' })).toBe('VALIDATION'); // la misma cuenta por pagar... y es pasivo
    expect(await bad([pay(mine, 1_000)], { paymentAccount: '999999' })).toBe('VALIDATION');
    expect(await bad([pay(mine, 1_000)], { date: '2026-10-01' })).toBe('VALIDATION'); // antes de la factura
    expect(await bad([pay(mine, 1_000), pay(mine, 2_000)])).toBe('VALIDATION');
    expect(await bad([pay(mine, 0)])).toBe('VALIDATION');
    expect(await bad([])).toBe('VALIDATION');
    expect(await bad([{ purchaseId: String(new ObjectId()), amount: 10 }])).toBe('NOT_FOUND');
    expect(await code(payables.createPayment(tenant, { partyId: String(new ObjectId()), date: TODAY, paymentAccount: '110505', allocations: [pay(mine, 10)] }, ctx(fresh('pay'))))).toBe('NOT_FOUND');
    expect(await code(payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [pay(mine, 10)] }, {}))).toBe('VALIDATION');
    await purchases.voidPurchase(tenant, String(mine._id), {}, ctx('x'));
    expect(await bad([pay(mine, 10)])).toBe('INVALID_STATE');
    expect(await code(payables.createPayment(toTenantId(new ObjectId()), { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [pay(theirs, 10)] }, ctx(fresh('pay'))))).toBe('NOT_FOUND');
  });

  it('anular un pago devuelve la deuda; anular dos veces o a la vez, una sola', async () => {
    const p = await buy();
    const { payment: ce } = await payment([pay(p, 500_000)]);
    await Promise.allSettled([payables.voidPayment(tenant, String(ce._id), {}, ctx('x')), payables.voidPayment(tenant, String(ce._id), {}, ctx('x'))]);
    expect(await reload(p)).toMatchObject({ paidTotal: 0, balance: 1_190_000 });
    expect(await ledgerNet('110505')).toBe(0);
    expect((await payables.voidPayment(tenant, String(ce._id), {}, ctx('x'))).replayed).toBe(true);
    expect((await payables.getPayment(tenant, String(ce._id))).status).toBe('void');
    // Con la factura anulada o el período cerrado no se anula nada a medias.
    const { payment: other2 } = await payment([pay(p, 100_000)]);
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(payables.voidPayment(tenant, String(other2._id), {}, ctx('x')))).toBe('PeriodClosedError');
    expect((await reload(p)).balance).toBe(1_090_000);
    expect(await code(payables.voidPayment(tenant, String(new ObjectId()), {}, ctx('x')))).toBe('NOT_FOUND');
  });

  it('lista pagos con filtros y cursor, y las facturas abiertas por vencimiento', async () => {
    const late = await buy({ supplierDocNumber: 'L', dueDate: '2026-10-06' });
    const soon = await buy({ supplierDocNumber: 'S', dueDate: '2026-12-01' });
    const paid = await buy({ supplierDocNumber: 'P', dueDate: '2026-10-10' });
    await buy({ supplierDocNumber: 'O', supplierId: String(other._id) });
    for (let i = 0; i < 3; i += 1) await payment([pay(paid, 1_000)]);
    await payment([pay(paid, 1_190_000 - 3_000)]);
    const first = await payables.listPayments(tenant, { limit: 2 });
    expect(first.items.map((p) => p.fullNumber)).toEqual(['CE4', 'CE3']);
    expect((await payables.listPayments(tenant, { limit: 2, cursor: first.nextCursor })).items.map((p) => p.fullNumber)).toEqual(['CE2', 'CE1']);
    expect((await payables.listPayments(tenant, { partyId: String(other._id) })).items).toEqual([]);
    const open = await payables.listOpenPurchases(tenant, { partyId: String(supplier._id), currency: 'COP' });
    expect(open.map((o) => o.fullNumber)).toEqual([late.fullNumber, soon.fullNumber]);
    expect(open[0]).toMatchObject({ payable: 1_190_000, paid: 0, balance: 1_190_000, supplierDocNumber: 'L' });
  });
});

describe('cuentas por pagar por edades', () => {
  it('reparte lo que se debe por antigüedad y por proveedor, sin lo pagado ni lo anulado', async () => {
    const unit = (amount) => [line({ unitPrice: amount, vatBps: 0 })];
    const buy = (patch) => buyOn({ issueDate: '2026-05-01', ...patch });
    await buy({ supplierDocNumber: '1', lines: unit(1_000), dueDate: '2026-10-25' }); // vigente
    await buy({ supplierDocNumber: '2', lines: unit(2_000), dueDate: '2026-10-20' }); // vence hoy
    await buy({ supplierDocNumber: '3', lines: unit(3_000), dueDate: '2026-10-10' }); // 10 días
    await buy({ supplierDocNumber: '4', lines: unit(5_000), dueDate: '2026-09-19' }); // 31 días
    await buy({ supplierDocNumber: '5', lines: unit(6_000), dueDate: '2026-08-01' }); // 80 días
    await buy({ supplierDocNumber: '6', lines: unit(7_000), dueDate: '2026-06-01', issueDate: '2026-05-01' }); // 141 días
    await buy({ supplierDocNumber: '7', lines: unit(8_000), dueDate: '2026-06-01', issueDate: '2026-05-01', supplierId: String(other._id) });
    const paid = await buy({ supplierDocNumber: '8', lines: unit(9_000), dueDate: '2026-06-01', issueDate: '2026-05-01' });
    await payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: String(paid._id), amount: 9_000 }] }, ctx(fresh('pay')));
    const voided = await buy({ supplierDocNumber: '9', lines: unit(4_000), dueDate: '2026-10-10' });
    await purchases.voidPurchase(tenant, String(voided._id), {}, ctx('x'));

    const report = await payables.aging(tenant, { currency: 'COP' });
    expect(report).toMatchObject({ asOf: TODAY, currency: 'COP', suppliers: 2, truncated: false });
    const mine = report.rows.find((r) => r.name === 'Aseo Total SAS');
    expect(mine).toMatchObject({ current: 3_000, d1_30: 3_000, d31_60: 5_000, d61_90: 6_000, d90plus: 7_000, invoices: 6, total: 24_000 });
    expect(report.rows.find((r) => r.name === 'Papelería Central')).toMatchObject({ d90plus: 8_000, total: 8_000 });
    expect(report.totals.total).toBe(32_000);
    expect(report.rows[0].total).toBeGreaterThanOrEqual(report.rows[1].total);
    expect(await payables.aging(toTenantId(new ObjectId()), { currency: 'COP' })).toMatchObject({ rows: [], suppliers: 0, totals: { total: 0 } });
  });
});

describe('coherencia con el libro', () => {
  it('la suma de saldos por pagar es el saldo de la cuenta de proveedores tras comprar, pagar, acreditar y anular', async () => {
    const a = await buy({ supplierDocNumber: 'A', withholdings: [rete()] });
    const b = await buy({ supplierDocNumber: 'B', supplierId: String(other._id), lines: [line({ unitPrice: 2_000_000 })] });
    const c = await buy({ supplierDocNumber: 'C' });
    const { payment: first } = await payables.createPayment(tenant, { partyId: String(supplier._id), date: TODAY, paymentAccount: '110505', allocations: [{ purchaseId: String(a._id), amount: 500_000 }, { purchaseId: String(c._id), amount: 1_190_000 }] }, ctx(fresh('pay')));
    await purchases.createSupplierNote(tenant, String(b._id), { lines: [{ lineIndex: 0, quantity: 300 }], reason: 'x', supplierDocNumber: 'NB' }, ctx(fresh('np')));
    await purchases.createSupplierNote(tenant, String(a._id), { all: true, reason: 'x', supplierDocNumber: 'NA' }, ctx(fresh('np')));
    await payables.voidPayment(tenant, String(first._id), {}, ctx('x'));
    const open = await db.collection(COLLECTIONS.purchases).find({ tenantId: tenant, status: 'posted' }).toArray();
    expect(-(await ledgerNet('220505'))).toBe(open.reduce((acc, p) => acc + p.balance, 0));
  });
});
