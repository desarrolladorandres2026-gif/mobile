import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { createYearEndService } from '../closing/yearEnd.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createInventoryService } from '../inventory/inventory.js';
import { createSettingsService } from '../invoicing/settings.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { createPosService } from '../pos/pos.js';
import { startMongo } from '../testing/mongo.js';
import { verifyIntegrity } from './verifyIntegrity.js';

const TODAY = new Date().toISOString().slice(0, 10);

let mongo;
let db;
let ledger;
let accounts;
let inventory;
let pos;
let yearEnd;
let tenant;
let other;
let n = 0;

const fresh = () => `k-${(n += 1)}-aaaaaaaa`;
const ctx = () => ({ idempotencyKey: fresh(), userId: null });
const day = (iso) => new Date(`${iso}T12:00:00Z`);

async function openChart(tenantId) {
  const make = (c, name, type, parentCode) => accounts.create(tenantId, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('143505', 'Mercancías', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital', 'equity', '3');
  await make('360505', 'Utilidad del ejercicio', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('510506', 'Sueldos', 'expense', '5');
  await make('530595', 'Faltantes', 'expense', '5');
  await make('6', 'Costos', 'cost');
  await make('613505', 'Costo de ventas', 'cost', '6');
}

async function register(name, email) {
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  return (await auth.registerTenant({ companyName: name, country: 'CO', currency: 'COP', ownerName: 'M', email, password: 'correcto-caballo-grapa' })).tenantId;
}

/** Una empresa con de todo un poco: inventario, venta de mostrador, anulación, cierre de turno y de ejercicio. */
async function busyTenant(tenantId) {
  await openChart(tenantId);
  const settings = createSettingsService(mongo.client, db, accounts);
  await settings.save(tenantId, {
    issuer: { name: 'Andina', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10', city: 'Garzón', region: 'Huila' } },
    accounts: { receivable: '110505', income: '413505', vatPayable: '240805' },
  });
  const item = await inventory.createItem(tenantId, { sku: 'A1', name: 'Arroz', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505' });
  await inventory.adjust(tenantId, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: 10_000, unitCost: 10_000, counterAccount: '310505', reason: 'Saldo' }, ctx());
  const register = await pos.createRegister(tenantId, { code: 'CAJA1', name: 'Mostrador', accounts: { cash: '110505', shortage: '530595' } });
  const shift = await pos.openShift(tenantId, String(register._id), { openingCash: 50_000 }, ctx());
  const line = { description: 'Arroz', itemId: String(item._id), quantity: 3000, unitPrice: 25_000, vatBps: 1900 };
  const sale = (await pos.createSale(tenantId, { registerId: String(register._id), date: TODAY, lines: [line], payments: [{ method: 'cash', amount: 89_250 }] }, ctx())).sale;
  const gone = (await pos.createSale(tenantId, { registerId: String(register._id), date: TODAY, lines: [line], payments: [{ method: 'cash', amount: 89_250 }] }, ctx())).sale;
  await pos.voidSale(tenantId, String(gone._id), { reason: 'prueba' }, ctx());
  // Un año pasado con resultados, cerrado.
  const post = (date, lines) => ledger.postJournal(tenantId, { docType: 'AJ', date: day(date), currency: 'COP', idempotencyKey: fresh(), lines });
  await post('2024-03-10', [{ accountId: '110505', debit: 700_000 }, { accountId: '413505', credit: 700_000 }]);
  await post('2024-04-10', [{ accountId: '510506', debit: 200_000 }, { accountId: '110505', credit: 200_000 }]);
  await yearEnd.close(tenantId, { year: 2024, currency: 'COP', profitAccount: '360505' }, { userId: null });
  return { item, register, shift, sale };
}

const check = (report, fragment) => report.tenants[0].checks.find((c) => c.name.includes(fragment));
const failing = (report) => report.tenants[0].checks.filter((c) => !c.ok).map((c) => c.name);

beforeAll(async () => {
  mongo = await startMongo('lulubiz_integrity_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
  inventory = createInventoryService({ client: mongo.client, db, ledger, accounts });
  pos = createPosService({ client: mongo.client, db, ledger, accounts, parties: createPartyService(mongo.client, db), settings: createSettingsService(mongo.client, db, accounts), inventory });
  yearEnd = createYearEndService({ client: mongo.client, db, ledger, accounts });
});

afterAll(async () => {
  await mongo?.stop();
});

let scenario;

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  tenant = await register('Ferretería Andina SAS', 'm@andina.co');
  other = await register('Boreal SAS', 'b@boreal.co');
  scenario = await busyTenant(tenant);
});

describe('una base sana', () => {
  it('pasa las diecisiete comprobaciones, con inventario, mostrador, anulación y cierre de ejercicio', async () => {
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(report.ok).toBe(true);
    expect(report.tenants).toHaveLength(1);
    expect(report.tenants[0].checks).toHaveLength(17);
    expect(failing(report)).toEqual([]);
    expect(check(report, 'saldos por cuenta').detail).toMatch(/saldos revisados/);
    expect(check(report, 'ejercicios cerrados').detail).toBe('1 ejercicios cerrados revisados.');
    expect(check(report, 'turno').detail).toBe('1 turnos revisados.');
  });

  it('sin indicar empresa revisa todas, también una vacía', async () => {
    const report = await verifyIntegrity(db);
    expect(report.tenants.map((t) => t.name).sort()).toEqual(['Boreal SAS', 'Ferretería Andina SAS']);
    expect(report.ok).toBe(true);
  });
});

describe('detecta lo que se altera por fuera del sistema', () => {
  it('un saldo que ya no coincide con los asientos', async () => {
    await db.collection(COLLECTIONS.balances).updateOne({ tenantId: tenant, accountId: '110505' }, { $inc: { debit: 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(report.ok).toBe(false);
    expect(failing(report)).toContain('Los saldos por cuenta y período coinciden con los asientos');
    expect(check(report, 'saldos por cuenta').detail).toMatch(/110505/);
  });

  it('un asiento que no cuadra', async () => {
    await db.collection(COLLECTIONS.journals).updateOne({ tenantId: tenant, docType: 'PV' }, { $inc: { totalDebit: 5 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(failing(report)).toContain('Todo asiento cuadra (débitos iguales a créditos)');
    expect(check(report, 'Todo asiento cuadra').detail).toMatch(/PV/);
  });

  it('un asiento borrado: salta la numeración y el documento queda sin asiento', async () => {
    await db.collection(COLLECTIONS.journals).deleteOne({ _id: scenario.sale.journalId });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(failing(report)).toEqual(expect.arrayContaining([
      'La numeración de asientos es consecutiva, sin saltos ni repetidos',
      'Todo documento contabilizado apunta a un asiento que existe',
      'Los saldos por cuenta y período coinciden con los asientos',
    ]));
    expect(check(report, 'apunta a un asiento').detail).toMatch(/ventas de mostrador/);
  });

  it('un contador de numeración adelantado', async () => {
    await db.collection(COLLECTIONS.counters).updateOne({ tenantId: tenant, docType: 'PV' }, { $inc: { last: 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(failing(report)).toEqual(['La numeración de asientos es consecutiva, sin saltos ni repetidos']);
    expect(check(report, 'numeración').detail).toMatch(/PV: el contador está en/);
  });

  it('una existencia que no coincide con su kardex ni con el libro', async () => {
    await db.collection(COLLECTIONS.stock).updateOne({ tenantId: tenant, itemId: scenario.item._id }, { $inc: { value: 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(failing(report)).toEqual(expect.arrayContaining([
      'Las existencias coinciden con el kardex y ninguna es negativa',
      'El valor del inventario coincide con el saldo de su cuenta en el libro',
    ]));
  });

  it('una existencia negativa', async () => {
    await db.collection(COLLECTIONS.stock).updateOne({ tenantId: tenant, itemId: scenario.item._id }, { $set: { quantity: -1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'kardex').ok).toBe(false);
    expect(check(report, 'kardex').detail).toMatch(/negativa/);
  });

  it('el total de un turno que no coincide con sus ventas', async () => {
    await db.collection(COLLECTIONS.posShifts).updateOne({ _id: scenario.shift._id }, { $inc: { cashTotal: 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(failing(report)).toEqual(['Los totales de cada turno de caja coinciden con sus ventas']);
    expect(check(report, 'turno').detail).toMatch(/CAJA1/);
  });

  it('una venta anulada que sigue sumando en su turno', async () => {
    await db.collection(COLLECTIONS.posSales).updateOne({ tenantId: tenant, status: 'void' }, { $set: { status: 'posted' } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'turno').ok).toBe(false);
  });

  it('un ejercicio cerrado cuyas cuentas de resultados ya no están en cero', async () => {
    await db.collection(COLLECTIONS.balances).updateOne({ tenantId: tenant, accountId: '413505', period: '2024-03' }, { $inc: { credit: 10 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'ejercicios cerrados').ok).toBe(false);
    expect(check(report, 'ejercicios cerrados').detail).toMatch(/2024 COP: 1 cuentas/);
  });

  it('un anticipo cuyo saldo no coincide con sus aplicaciones', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant });
    const base = { tenantId: tenant, kind: 'customer', status: 'posted', currency: 'COP', amount: 100, journalId: journal._id };
    await db.collection(COLLECTIONS.advances).insertOne({ ...base, fullNumber: 'RC90', idempotencyKey: 'a-90', applied: 0, balance: 100 });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'anticipo').ok).toBe(true);
    await db.collection(COLLECTIONS.advances).insertOne({ ...base, fullNumber: 'RC91', idempotencyKey: 'a-91', applied: 0, balance: 40 });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'anticipo').ok).toBe(false);
    expect(check(report, 'anticipo').detail).toMatch(/RC91/);
  });

  it('un saldo por centro de costo o por tercero que no coincide con los asientos', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant });
    const period = journal.period;
    await db.collection(COLLECTIONS.dimBalances).insertOne({ tenantId: tenant, dimension: 'costCenter', key: 'FANTASMA', accountId: '413505', period, currency: 'COP', debit: 10, credit: 0 });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'por centro de costo').ok).toBe(false);
    expect(check(report, 'por centro de costo').detail).toMatch(/FANTASMA/);
    await db.collection(COLLECTIONS.dimBalances).deleteOne({ tenantId: tenant, key: 'FANTASMA' });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'por centro de costo').ok).toBe(true);
  });

  it('una conciliación bancaria cuyo importe ya no coincide con el libro o el extracto', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant, 'lines.accountId': '110505' });
    const idx = journal.lines.findIndex((l) => l.accountId === '110505');
    const amount = (journal.lines[idx].debit ?? 0) - (journal.lines[idx].credit ?? 0);
    const bankLine = await db.collection(COLLECTIONS.bankLines).insertOne({ tenantId: tenant, accountId: '110505', currency: 'COP', date: journal.date, description: 'x', amount, status: 'active', dedupeKey: 'k1' });
    await db.collection(COLLECTIONS.bankMatches).insertOne({ tenantId: tenant, active: true, accountId: '110505', currency: 'COP', bankLineId: bankLine.insertedId, journalId: journal._id, lineIndex: idx, document: 'X1', amount, bankDate: journal.date, bookDate: journal.date });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'conciliación bancaria').ok).toBe(true);
    await db.collection(COLLECTIONS.bankLines).updateOne({ _id: bankLine.insertedId }, { $set: { amount: amount + 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'conciliación bancaria').ok).toBe(false);
    expect(check(report, 'conciliación bancaria').detail).toMatch(/X1/);
  });

  it('un activo fijo cuya depreciación no coincide con su calendario ni con sus corridas', async () => {
    const asset = { tenantId: tenant, code: 'EQ1', name: 'Equipo', status: 'active', currency: 'COP', cost: 1_200_000, salvageValue: 0, usefulLifeMonths: 12, depreciationStart: '2026-01', depreciatedMonths: 2, depreciatedTotal: 200_000 };
    const { insertedId } = await db.collection(COLLECTIONS.fixedAssets).insertOne(asset);
    await db.collection(COLLECTIONS.depreciationRuns).insertOne({ tenantId: tenant, period: '2026-02', total: 200_000, items: [{ assetId: insertedId, code: 'EQ1', fromMonth: 1, toMonth: 2, amount: 200_000 }] });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'activo fijo').ok).toBe(true);
    await db.collection(COLLECTIONS.fixedAssets).updateOne({ _id: insertedId }, { $set: { depreciatedTotal: 250_000 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'activo fijo').ok).toBe(false);
    expect(check(report, 'activo fijo').detail).toMatch(/EQ1/);
    await db.collection(COLLECTIONS.fixedAssets).updateOne({ _id: insertedId }, { $set: { depreciatedTotal: 200_000 } });
    await db.collection(COLLECTIONS.depreciationRuns).deleteMany({ tenantId: tenant });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'activo fijo').ok).toBe(false);
    await db.collection(COLLECTIONS.fixedAssets).deleteMany({ tenantId: tenant });
  });

  it('una nómina cuyos totales ya no coinciden con su asiento ni con sus empleados', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant });
    const totals = { gross: journal.totalDebit, employerTotal: 0, provisionsTotal: 0, net: 0 };
    const { insertedId } = await db.collection(COLLECTIONS.payrollRuns).insertOne({ tenantId: tenant, period: '2026-01', status: 'posted', journalId: journal._id, totals, items: [{ net: 0, gross: journal.totalDebit }] });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'nómina').ok).toBe(true);
    await db.collection(COLLECTIONS.payrollRuns).updateOne({ _id: insertedId }, { $set: { 'totals.gross': journal.totalDebit + 1 } });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'nómina').ok).toBe(false);
    expect(check(report, 'nómina').detail).toMatch(/2026-01/);
    await db.collection(COLLECTIONS.payrollRuns).deleteMany({ tenantId: tenant });
  });

  it('una conciliación bancaria cerrada a la que después se le registra un asiento en su tramo', async () => {
    const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: '110505', currency: 'COP' }).toArray();
    const bookBalance = rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
    await db.collection(COLLECTIONS.bankReconciliations).insertOne({ tenantId: tenant, accountId: '110505', currency: 'COP', asOf: day(TODAY), statementBalance: bookBalance, bookBalance, status: 'closed', closedAt: new Date() });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'conciliaciones bancarias cerradas').ok).toBe(true);
    await ledger.postJournal(tenant, { docType: 'AJ', date: day(TODAY), currency: 'COP', idempotencyKey: fresh(), lines: [{ accountId: '110505', debit: 1_000 }, { accountId: '413505', credit: 1_000 }] });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'conciliaciones bancarias cerradas').ok).toBe(false);
    expect(check(report, 'conciliaciones bancarias cerradas').detail).toMatch(/110505/);
    // Una conciliación reabierta ya no fija nada.
    await db.collection(COLLECTIONS.bankReconciliations).updateMany({ tenantId: tenant }, { $set: { status: 'reopened' } });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'conciliaciones bancarias cerradas').ok).toBe(true);
  });

  it('una factura cuyo saldo no coincide con sus recibos, anticipos y notas, o que quedó con saldo negativo', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant });
    const invoice = (fullNumber, patch = {}) => ({ tenantId: tenant, fullNumber, status: 'issued', totals: { total: 1_000 }, paidTotal: 0, creditedTotal: 0, balance: 1_000, ...patch });
    const { insertedId } = await db.collection(COLLECTIONS.invoices).insertOne(invoice('FE90'));
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'saldo de cada factura').ok).toBe(true);
    // Un saldo tocado a mano.
    await db.collection(COLLECTIONS.invoices).updateOne({ _id: insertedId }, { $set: { balance: 400 } });
    let report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'saldo de cada factura').ok).toBe(false);
    expect(check(report, 'saldo de cada factura').detail).toMatch(/FE90/);
    // Con su recibo vigente, el saldo cuadra.
    await db.collection(COLLECTIONS.receipts).insertOne({ tenantId: tenant, status: 'posted', journalId: journal._id, allocations: [{ invoiceId: insertedId, amount: 600 }] });
    await db.collection(COLLECTIONS.invoices).updateOne({ _id: insertedId }, { $set: { paidTotal: 600 } });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'saldo de cada factura').ok).toBe(true);
    // Un recibo anulado deja de contar.
    await db.collection(COLLECTIONS.receipts).updateMany({ tenantId: tenant }, { $set: { status: 'void' } });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'saldo de cada factura').ok).toBe(false);
    await db.collection(COLLECTIONS.receipts).deleteMany({ tenantId: tenant });
    await db.collection(COLLECTIONS.invoices).deleteMany({ tenantId: tenant });
    // Acreditar más de lo que valía deja un saldo negativo: justo lo que dejaba la nota crédito sobre una factura cobrada.
    const over = await db.collection(COLLECTIONS.invoices).insertOne(invoice('FE91', { creditedTotal: 1_200, balance: -200 }));
    await db.collection(COLLECTIONS.creditNotes).insertOne({ tenantId: tenant, invoiceId: over.insertedId, status: 'issued', totals: { total: 1_200 } });
    report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'saldo de cada factura').ok).toBe(false);
    expect(check(report, 'saldo de cada factura').detail).toMatch(/negativo/);
  });

  it('una compra cuyo saldo no coincide con sus pagos y notas de proveedor', async () => {
    const { insertedId } = await db.collection(COLLECTIONS.purchases).insertOne({ tenantId: tenant, fullNumber: 'FC90', status: 'posted', payable: 1_000, paidTotal: 0, creditedTotal: 0, balance: 1_000 });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'saldo de cada compra').ok).toBe(true);
    // Una nota de proveedor vigente baja lo que se debe; si el saldo no lo refleja, se detecta.
    await db.collection(COLLECTIONS.supplierNotes).insertOne({ tenantId: tenant, purchaseId: insertedId, status: 'posted', totals: { total: 300 }, effect: 300 });
    let report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'saldo de cada compra').ok).toBe(false);
    expect(check(report, 'saldo de cada compra').detail).toMatch(/FC90/);
    await db.collection(COLLECTIONS.purchases).updateOne({ _id: insertedId }, { $set: { creditedTotal: 300, balance: 700 } });
    report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'saldo de cada compra').ok).toBe(true);
  });

  it('dos cierres de IVA vigentes que se traslapan, o uno sin asiento', async () => {
    const journal = await db.collection(COLLECTIONS.journals).findOne({ tenantId: tenant });
    const close = (document, from, to, patch = {}) => ({ tenantId: tenant, status: 'posted', currency: 'COP', document, from: day(from), to: day(to), generated: 100, deductible: 40, net: 60, journalId: journal._id, ...patch });
    await db.collection(COLLECTIONS.taxCloses).insertMany([close('CI90', '2026-01-01', '2026-01-31'), close('CI91', '2026-02-01', '2026-02-28')]);
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'cierres de IVA').ok).toBe(true);
    await db.collection(COLLECTIONS.taxCloses).insertOne(close('CI92', '2026-01-20', '2026-02-10'));
    let report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'cierres de IVA').ok).toBe(false);
    expect(check(report, 'cierres de IVA').detail).toMatch(/se traslapa/);
    await db.collection(COLLECTIONS.taxCloses).deleteOne({ tenantId: tenant, document: 'CI92' });
    await db.collection(COLLECTIONS.taxCloses).updateOne({ tenantId: tenant, document: 'CI90' }, { $set: { journalId: new ObjectId() } });
    report = await verifyIntegrity(db, { tenantId: tenant });
    expect(check(report, 'cierres de IVA').detail).toMatch(/CI90: no tiene asiento/);
  });

  it('el consecutivo de traspasos no se compara con los asientos', async () => {
    await db.collection(COLLECTIONS.counters).insertOne({ tenantId: tenant, docType: 'TR', last: 2 });
    await db.collection(COLLECTIONS.stockDocs).insertMany([
      { tenantId: tenant, kind: 'transfer', number: 1, idempotencyKey: 't1' },
      { tenantId: tenant, kind: 'transfer', number: 2, idempotencyKey: 't2' },
    ]);
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'numeración').ok).toBe(true);
    await db.collection(COLLECTIONS.counters).updateOne({ tenantId: tenant, docType: 'TR' }, { $set: { last: 5 } });
    expect(check(await verifyIntegrity(db, { tenantId: tenant }), 'numeración').detail).toMatch(/TR/);
  });

  it('un ejercicio reabierto ya no se exige en cero', async () => {
    await yearEnd.reopen(tenant, { year: 2024, currency: 'COP' }, { userId: null });
    const report = await verifyIntegrity(db, { tenantId: tenant });
    expect(report.ok).toBe(true);
    expect(check(report, 'ejercicios cerrados').detail).toBe('0 ejercicios cerrados revisados.');
  });
});

describe('aislamiento', () => {
  it('una alteración en una empresa no marca a la otra', async () => {
    await db.collection(COLLECTIONS.balances).updateOne({ tenantId: tenant, accountId: '110505' }, { $inc: { debit: 1 } });
    const all = await verifyIntegrity(db);
    expect(all.ok).toBe(false);
    expect(all.tenants.find((t) => t.name === 'Boreal SAS').ok).toBe(true);
    expect(all.tenants.find((t) => t.name === 'Ferretería Andina SAS').ok).toBe(false);
    expect((await verifyIntegrity(db, { tenantId: other })).ok).toBe(true);
  });
});
