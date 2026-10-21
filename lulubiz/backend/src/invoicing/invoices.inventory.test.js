import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createInventoryService, returnedCost } from '../inventory/inventory.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { startMongo } from '../testing/mongo.js';
import { createInvoicingService } from './invoices.js';
import { ProviderUnavailableError } from './provider.js';
import { createResolutionService } from './resolutions.js';
import { createSettingsService } from './settings.js';

let mongo;
let db;
let ledger;
let accounts;
let parties;
let settings;
let resolutions;
let inventory;
let invoicing;
let provider;
let tenant;
let customer;
let n = 0;
const user = new ObjectId();

const TODAY = new Date().toISOString().slice(0, 10);
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;

const fresh = (label) => `${label}-${(n += 1)}-aaaaaaaa`;
const ctx = (key = fresh('k')) => ({ idempotencyKey: key, userId: user });
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

/** Proveedor guionizado que además guarda los documentos que recibió. */
function scriptedProvider(script = []) {
  const accepted = new Map();
  const queue = [...script];
  const documents = [];
  return {
    name: 'guionizado',
    sandbox: false,
    documents,
    async issue({ reference, document }) {
      documents.push(document);
      if (accepted.has(reference)) return accepted.get(reference);
      const step = queue.shift() ?? 'accept';
      if (step === 'timeout') throw new ProviderUnavailableError();
      if (step === 'reject') return { status: 'rejected', code: 'RECHAZO', message: 'documento rechazado por el proveedor' };
      const receipt = { status: 'accepted', cufe: `CUFE-${reference}`, qr: `QR-${reference}`, validatedAt: new Date(), reference };
      accepted.set(reference, receipt);
      return receipt;
    },
    async status(reference) {
      return accepted.get(reference) ?? { status: 'unknown' };
    },
  };
}

async function openChart() {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('130505', 'Clientes', 'asset', '1');
  await make('143505', 'Mercancías no fabricadas', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('3', 'Patrimonio', 'equity');
  await make('310505', 'Capital social', 'equity', '3');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  await make('413510', 'Ventas de ferretería', 'income', '4');
  await make('5', 'Gastos', 'expense');
  await make('529595', 'Pérdida de inventario', 'expense', '5');
  await make('6', 'Costos de ventas', 'cost');
  await make('613505', 'Costo de mercancía vendida', 'cost', '6');
}

const makeItem = (patch = {}) => inventory.createItem(tenant, { sku: 'TORN-1', name: 'Tornillo', type: 'goods', unit: 'und', inventoryAccount: '143505', cogsAccount: '613505', ...patch });
const receive = (item, units, unitCost, warehouseId) =>
  inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: units * 1000, unitCost, counterAccount: '310505', reason: 'Compra', ...(warehouseId ? { warehouseId: String(warehouseId) } : {}) }, ctx());
const drain = (item, units) =>
  inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'out', quantity: units * 1000, counterAccount: '529595', reason: 'Salida' }, ctx());
const stockRow = async (item, warehouse) => {
  const w = warehouse ?? (await inventory.ensureDefaultWarehouse(tenant));
  return db.collection(COLLECTIONS.stock).findOne({ tenantId: tenant, itemId: item._id, warehouseId: w._id });
};
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};
const expectReconciled = async () => {
  const v = await inventory.valuation(tenant);
  for (const a of v.accounts) expect(a.difference, `cuenta ${a.account}`).toBe(0);
  return v;
};

const line = (item, units, patch = {}) => ({ description: item.name, itemId: String(item._id), quantity: units * 1000, unitPrice: 25_000, vatBps: 1900, ...patch });
const invoiceInput = (lines, patch = {}) => ({ customerId: String(customer._id), issueDate: TODAY, paymentMethod: 'credit', dueDate: NEXT_YEAR, lines, ...patch });
const sell = async (lines, patch) => {
  const res = await invoicing.issueInvoice(tenant, invoiceInput(lines, patch), ctx());
  return res.invoice;
};
const journalOf = (id) => ledger.getJournal(tenant, id);
const reload = (invoice) => db.collection(COLLECTIONS.invoices).findOne({ _id: invoice._id });
const movements = (item) => db.collection(COLLECTIONS.movements).find({ tenantId: tenant, itemId: item._id }).sort({ _id: 1 }).toArray();
const buildInvoicing = (inv = inventory) =>
  createInvoicingService({ client: mongo.client, db, ledger, accounts, parties, settings, resolutions, provider, inventory: inv });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_invoicing_inventory_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
  parties = createPartyService(mongo.client, db);
  settings = createSettingsService(mongo.client, db, accounts);
  resolutions = createResolutionService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Ferretería Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  customer = await parties.create(tenant, { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  await openChart();
  await settings.save(tenant, {
    issuer: { name: 'Ferretería Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
    accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
  });
  await resolutions.create(tenant, { docType: 'invoice', prefix: 'FE', number: '18760000001', from: 1, to: 100, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  await resolutions.create(tenant, { docType: 'credit_note', prefix: 'NC', number: '18760000002', from: 1, to: 100, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  provider = scriptedProvider();
  inventory = createInventoryService({ client: mongo.client, db, ledger, accounts });
  invoicing = buildInvoicing();
});

describe('costo puro de una devolución', () => {
  it('vuelve al costo original y la que agota lo vendido recibe el resto exacto', () => {
    expect(returnedCost(1_000, 3_000, { quantity: 1_000 })).toBe(333);
    expect(returnedCost(1_000, 3_000, { quantity: 1_000, restockedQuantity: 1_000, restockedCost: 333 })).toBe(333);
    expect(returnedCost(1_000, 3_000, { quantity: 1_000, restockedQuantity: 2_000, restockedCost: 666 })).toBe(334);
    expect(() => returnedCost(1_000, 3_000, { quantity: 2_000, restockedQuantity: 2_000, restockedCost: 666 })).toThrow(/más de lo vendido/);
    expect(() => returnedCost(1_000, 3_000, { quantity: 0 })).toThrow();
  });
});

describe('venta de bienes', () => {
  it('al emitir saca la existencia al costo promedio y suma el costo de ventas al asiento', async () => {
    const item = await makeItem({ incomeAccount: '413510' });
    await receive(item, 10, 10_000);
    await receive(item, 10, 20_000); // 20 und a 15 000 promedio

    const invoice = await sell([line(item, 4)]);
    expect(invoice).toMatchObject({ status: 'issued', accounting: { status: 'posted' }, stockCost: [60_000] });
    expect(invoice.lines[0]).toMatchObject({ itemId: item._id, accountId: '413510', inventoryAccount: '143505', cogsAccount: '613505' });

    expect(await stockRow(item)).toMatchObject({ quantity: 16_000, value: 240_000 });
    const journal = await journalOf(invoice.accounting.journalId);
    expect(journal).toMatchObject({ docType: 'FV', totalDebit: 119_000 + 60_000, totalCredit: 119_000 + 60_000 });
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: '130505', debit: 119_000 }),
        expect.objectContaining({ accountId: '413510', credit: 100_000 }),
        expect.objectContaining({ accountId: '240805', credit: 19_000 }),
        expect.objectContaining({ accountId: '613505', debit: 60_000 }),
        expect.objectContaining({ accountId: '143505', credit: 60_000 }),
      ]),
    );
    expect(await ledgerNet('613505')).toBe(60_000);
    expect(await ledgerNet('143505')).toBe(10 * 10_000 + 10 * 20_000 - 60_000);
    await expectReconciled();

    const out = (await movements(item)).at(-1);
    expect(out).toMatchObject({ type: 'sale_out', quantity: -4_000, value: -60_000, source: { kind: 'invoice', id: String(invoice._id) } });
  });

  it('el proveedor recibe el documento sin datos de inventario', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    await sell([line(item, 2)]);
    const sent = provider.documents.at(-1).lines[0];
    for (const key of ['itemId', 'warehouseId', 'inventoryAccount', 'cogsAccount', 'stockCost']) expect(sent).not.toHaveProperty(key);
    expect(sent).toMatchObject({ description: 'Tornillo', quantity: 2_000, net: 50_000 });
  });

  it('mezcla bienes y servicios: solo los bienes tocan existencias y costo', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 2), { description: 'Instalación', quantity: 1000, unitPrice: 80_000, vatBps: 1900 }]);
    expect(invoice.stockCost).toEqual([20_000, 0]);
    expect(await ledgerNet('613505')).toBe(20_000);
    expect(await ledgerNet('413505')).toBe(-(50_000 + 80_000));
    await expectReconciled();
  });

  it('dos líneas del mismo artículo reparten el costo sin residuo', async () => {
    const item = await makeItem();
    await inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: 3_000, unitCost: 3_333, counterAccount: '310505', reason: 'x' }, ctx()); // valor 9 999
    const invoice = await sell([line(item, 1), line(item, 2)]);
    expect(invoice.stockCost.reduce((a, b) => a + b, 0)).toBe(9_999);
    expect(invoice.stockCost).toEqual([3_333, 6_666]);
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    await expectReconciled();
  });

  it('descuenta de la bodega indicada y no de las demás', async () => {
    const item = await makeItem();
    const south = await inventory.createWarehouse(tenant, { code: 'SUR', name: 'Sur' });
    await receive(item, 5, 10_000);
    await receive(item, 5, 40_000, south._id);
    const invoice = await sell([line(item, 2, { warehouseId: String(south._id) })]);
    expect(invoice.stockCost).toEqual([80_000]);
    expect(await stockRow(item)).toMatchObject({ quantity: 5_000, value: 50_000 });
    expect(await stockRow(item, south)).toMatchObject({ quantity: 3_000, value: 120_000 });
    await expectReconciled();
  });

  it('sin existencias suficientes se rechaza antes de gastar un número', async () => {
    const item = await makeItem();
    await receive(item, 3, 10_000);
    expect(await code(invoicing.issueInvoice(tenant, invoiceInput([line(item, 4)]), ctx()))).toBe('INSUFFICIENT_STOCK');
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({ tenantId: tenant })).toBe(0);
    expect((await resolutions.list(tenant)).find((r) => r.docType === 'invoice').next).toBe(1);
    expect(await stockRow(item)).toMatchObject({ quantity: 3_000 });
  });

  it('rechaza servicios, inactivos, inexistentes y la venta sin servicio de inventario', async () => {
    const item = await makeItem();
    await receive(item, 5, 10_000);
    const service = await inventory.createItem(tenant, { sku: 'INSTALA', name: 'Instalación', type: 'service', incomeAccount: '413505' });
    const dead = await makeItem({ sku: 'VIEJO', name: 'Viejo' });
    await inventory.updateItem(tenant, String(dead._id), { active: false });
    const attempt = (l, svc = invoicing) => code(svc.issueInvoice(tenant, invoiceInput([l]), ctx()));
    expect(await attempt(line(service, 1))).toBe('VALIDATION');
    expect(await attempt(line(dead, 1))).toBe('VALIDATION');
    expect(await attempt(line(item, 1, { itemId: String(new ObjectId()) }))).toBe('NOT_FOUND');
    expect(await attempt(line(item, 1), buildInvoicing(null))).toBe('VALIDATION');
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({ tenantId: tenant })).toBe(0);
  });

  it('repetir la clave no vende dos veces', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const key = fresh('inv');
    const first = await invoicing.issueInvoice(tenant, invoiceInput([line(item, 3)]), ctx(key));
    const again = await invoicing.issueInvoice(tenant, invoiceInput([line(item, 3)]), ctx(key));
    expect(again.replayed).toBe(true);
    expect(again.invoice._id).toEqual(first.invoice._id);
    expect(await stockRow(item)).toMatchObject({ quantity: 7_000, value: 70_000 });
    expect(await ledgerNet('613505')).toBe(30_000);
  });

  it('si el proveedor no responde, la existencia no sale hasta que se valide', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    provider = scriptedProvider(['timeout']);
    invoicing = buildInvoicing();
    const pending = (await invoicing.issueInvoice(tenant, invoiceInput([line(item, 4)]), ctx())).invoice;
    expect(pending.status).toBe('pending_provider');
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 100_000 });
    const synced = await invoicing.submitInvoice(tenant, pending._id, ctx());
    expect(synced.invoice).toMatchObject({ status: 'issued', stockCost: [40_000] });
    expect(await stockRow(item)).toMatchObject({ quantity: 6_000, value: 60_000 });
    await expectReconciled();
  });

  it('si se agotó entre la creación y la validación, queda emitida y pendiente; al reponer se contabiliza', async () => {
    const item = await makeItem();
    await receive(item, 5, 10_000);
    provider = scriptedProvider(['timeout']);
    invoicing = buildInvoicing();
    const pending = (await invoicing.issueInvoice(tenant, invoiceInput([line(item, 4)]), ctx())).invoice;
    await drain(item, 3);

    const issued = (await invoicing.submitInvoice(tenant, pending._id, ctx())).invoice;
    expect(issued.status).toBe('issued');
    expect(issued.accounting).toMatchObject({ status: 'pending' });
    expect(issued.accounting.error).toMatch(/no hay existencias suficientes/);
    expect(await stockRow(item)).toMatchObject({ quantity: 2_000 });
    expect(await ledgerNet('613505')).toBe(0);
    expect(await ledgerNet('130505')).toBe(0);

    expect(await code(invoicing.accountInvoice(tenant, pending._id, ctx()))).toBe('INSUFFICIENT_STOCK');
    await receive(item, 5, 10_000);
    const posted = await invoicing.accountInvoice(tenant, pending._id, ctx());
    expect(posted).toMatchObject({ accounting: { status: 'posted' }, stockCost: [40_000] });
    expect(await stockRow(item)).toMatchObject({ quantity: 3_000 });
    expect(await ledgerNet('613505')).toBe(40_000);
    await expectReconciled();
    // contabilizar de nuevo no vuelve a sacar
    await invoicing.accountInvoice(tenant, pending._id, ctx());
    expect(await stockRow(item)).toMatchObject({ quantity: 3_000 });
  });

  it('dos ventas a la vez que caben ambas: las dos salen y nada queda negativo', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const results = await Promise.all([sell([line(item, 5)]), sell([line(item, 5)])]);
    expect(results.map((r) => r.accounting.status)).toEqual(['posted', 'posted']);
    expect(await stockRow(item)).toMatchObject({ quantity: 0, value: 0 });
    expect(await ledgerNet('613505')).toBe(100_000);
    await expectReconciled();
  });

  it('dos ventas a la vez que no caben las dos: una se contabiliza y la otra queda pendiente, sin existencia negativa', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const results = await Promise.allSettled([sell([line(item, 6)]), sell([line(item, 6)])]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const posted = fulfilled.filter((i) => i.accounting.status === 'posted');
    expect(posted).toHaveLength(1);
    const row = await stockRow(item);
    expect(row.quantity).toBe(4_000);
    expect(row.value).toBe(40_000);
    expect(await ledgerNet('613505')).toBe(60_000);
    await expectReconciled();
  });
});

describe('devolución de bienes vendidos', () => {
  const returnNote = (invoice, body = {}) => invoicing.issueCreditNote(tenant, String(invoice._id), { reasonCode: '1', ...body }, ctx());

  it('la devolución parcial reingresa al costo al que salió, no al promedio de hoy', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 4)]); // costo 40 000
    await receive(item, 10, 50_000); // hoy el promedio sube
    const before = await stockRow(item);

    const { note } = await returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 1_000 }] });
    expect(note).toMatchObject({ status: 'issued', accounting: { status: 'posted' } });
    expect(note.lines[0]).toMatchObject({ itemId: item._id, quantity: 1_000, stockCost: 10_000 });

    const after = await stockRow(item);
    expect(after.quantity - before.quantity).toBe(1_000);
    expect(after.value - before.value).toBe(10_000);
    const journal = await journalOf(note.accounting.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: '143505', debit: 10_000 }), expect.objectContaining({ accountId: '613505', credit: 10_000 })]),
    );
    expect(await ledgerNet('613505')).toBe(30_000);
    expect((await movements(item)).at(-1)).toMatchObject({ type: 'sale_return', quantity: 1_000, value: 10_000, source: { kind: 'credit_note', id: String(note._id) } });
    await expectReconciled();
  });

  it('devolver todo en varias notas suma exactamente el costo original', async () => {
    const item = await makeItem();
    await inventory.adjust(tenant, { itemId: String(item._id), date: TODAY, direction: 'in', quantity: 3_000, unitCost: 3_333, counterAccount: '310505', reason: 'x' }, ctx()); // 9 999
    const invoice = await sell([line(item, 3)]);
    expect(invoice.stockCost).toEqual([9_999]);
    await returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 1_000 }] });
    await returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 1_000 }] });
    const last = await returnNote(invoice, { all: true });
    expect(last.note.lines[0].stockCost).toBe(3_333);
    expect(await stockRow(item)).toMatchObject({ quantity: 3_000, value: 9_999 });
    expect(await ledgerNet('613505')).toBe(0);
    expect((await reload(invoice)).credited).toMatchObject({ restocked: [3_000], cost: [9_999] });
    await expectReconciled();
  });

  it('la anulación (motivo 2) devuelve todos los bienes', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 4), { description: 'Flete', quantity: 1000, unitPrice: 10_000, vatBps: 0 }]);
    await invoicing.issueCreditNote(tenant, String(invoice._id), { reasonCode: '2', all: true }, ctx());
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 100_000 });
    expect(await ledgerNet('613505')).toBe(0);
    await expectReconciled();
  });

  it('una nota de rebaja o de ajuste de precio no mueve existencias ni costo', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 4)]);
    const { note } = await returnNote(invoice, { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 1_000 }] });
    expect(note.lines[0].itemId).toBeUndefined();
    expect(note.accounting.status).toBe('posted');
    expect(await stockRow(item)).toMatchObject({ quantity: 6_000, value: 60_000 });
    expect(await ledgerNet('613505')).toBe(40_000);
    expect((await reload(invoice)).credited.restocked).toEqual([0]);
  });

  it('una rebaja previa no cambia el costo de lo que se devuelva después', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 10)]); // costo 100 000
    await returnNote(invoice, { reasonCode: '3', lines: [{ lineIndex: 0, quantity: 6_000 }] }); // rebaja sobre 6 und
    const { note } = await returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 4_000 }] });
    expect(note.lines[0].stockCost).toBe(40_000); // 4 und a 10 000, no el resto de todo el costo
    expect(await stockRow(item)).toMatchObject({ quantity: 4_000, value: 40_000 });
    await expectReconciled();
  });

  it('una nota rechazada por el proveedor libera lo reservado y se puede devolver de nuevo', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    provider = scriptedProvider(['accept', 'reject']);
    invoicing = buildInvoicing();
    const invoice = await sell([line(item, 4)]);
    const rejected = await returnNote(invoice, { all: true });
    expect(rejected.rejected).toBe(true);
    expect(await stockRow(item)).toMatchObject({ quantity: 6_000 });
    expect((await reload(invoice)).credited).toMatchObject({ quantity: [0], restocked: [0], cost: [0] });

    const again = await returnNote(invoice, { all: true });
    expect(again.note.status).toBe('issued');
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 100_000 });
  });

  it('no se puede devolver más de lo vendido ni dos veces lo mismo', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 4)]);
    await returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 3_000 }] });
    expect(await code(returnNote(invoice, { lines: [{ lineIndex: 0, quantity: 2_000 }] }))).toBe('OVER_CREDIT');
    expect(await stockRow(item)).toMatchObject({ quantity: 9_000, value: 90_000 });
    await expectReconciled();
  });

  it('dos devoluciones simultáneas de lo mismo: solo cabe una', async () => {
    const item = await makeItem();
    await receive(item, 10, 10_000);
    const invoice = await sell([line(item, 4)]);
    const results = await Promise.allSettled([returnNote(invoice, { all: true }), returnNote(invoice, { all: true })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stockRow(item)).toMatchObject({ quantity: 10_000, value: 100_000 });
    await expectReconciled();
  });

  it('con la factura sin contabilizar, no se devuelven sus bienes todavía', async () => {
    const item = await makeItem();
    await receive(item, 5, 10_000);
    provider = scriptedProvider(['timeout']);
    invoicing = buildInvoicing();
    const pending = (await invoicing.issueInvoice(tenant, invoiceInput([line(item, 4)]), ctx())).invoice;
    await drain(item, 3);
    await invoicing.submitInvoice(tenant, pending._id, ctx()); // emitida, contabilización pendiente
    expect(await code(returnNote(pending, { all: true }))).toBe('INVALID_STATE');
    expect((await reload(pending)).credited.restocked).toEqual([0]);
  });
});
