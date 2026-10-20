import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { toTenantId } from '../core/tenant.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createInvoicingService } from '../invoicing/invoices.js';
import { createSandboxProvider } from '../invoicing/provider.js';
import { createResolutionService } from '../invoicing/resolutions.js';
import { createSettingsService } from '../invoicing/settings.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { startMongo } from '../testing/mongo.js';
import { createReceivablesService } from './receivables.js';

const TODAY = '2026-10-20';
const NOW = new Date(`${TODAY}T15:00:00Z`);
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;

let mongo;
let db;
let ledger;
let accounts;
let parties;
let invoicing;
let receivables;
let tenant;
let customer;
let other;
let n = 0;
const user = new ObjectId();

const ctx = (key) => ({ idempotencyKey: key, userId: user });
const fresh = (label) => `${label}-${(n += 1)}-aaaaaaaa`;
const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

const settingsInput = (cash) => ({
  issuer: { name: 'Comercial Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
  accounts: { receivable: '130505', income: '413505', vatPayable: '240805', ...(cash ? { cash } : {}) },
});

async function open({ cash } = {}) {
  const make = (c, name, type, parentCode) => accounts.create(tenant, { code: c, name, type, ...(parentCode ? { parentCode } : { postable: false }) });
  await make('1', 'Activo', 'asset');
  await make('110505', 'Caja general', 'asset', '1');
  await make('111005', 'Bancos', 'asset', '1');
  await make('130505', 'Clientes', 'asset', '1');
  await make('2', 'Pasivo', 'liability');
  await make('240805', 'IVA por pagar', 'liability', '2');
  await make('4', 'Ingresos', 'income');
  await make('413505', 'Ventas', 'income', '4');
  const settings = createSettingsService(mongo.client, db, accounts);
  await settings.save(tenant, settingsInput(cash));
  const resolutions = createResolutionService(mongo.client, db);
  await resolutions.create(tenant, { docType: 'invoice', prefix: 'FE', number: '18760000001', from: 1, to: 500, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  await resolutions.create(tenant, { docType: 'credit_note', prefix: 'NC', number: '18760000002', from: 1, to: 500, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  invoicing = createInvoicingService({ client: mongo.client, db, ledger, accounts, parties, settings, resolutions, provider: createSandboxProvider() });
}

/** Factura a crédito por `amount` (centavos, sin IVA). */
async function invoice({ amount = 100_000, due = '2026-11-20', issue = '2026-05-01', paymentMethod = 'credit', who = customer } = {}) {
  const result = await invoicing.issueInvoice(
    tenant,
    {
      customerId: String(who._id),
      issueDate: issue,
      paymentMethod,
      ...(paymentMethod === 'credit' ? { dueDate: due } : {}),
      lines: [{ description: 'Servicio', quantity: 1000, unitPrice: amount, vatBps: 0 }],
    },
    ctx(fresh('inv')),
  );
  expect(result.invoice.status).toBe('issued');
  return result.invoice;
}

const receipt = (allocations, patch = {}, key = fresh('rc')) =>
  receivables.createReceipt(tenant, { partyId: String(customer._id), date: TODAY, depositAccount: '110505', allocations, ...patch }, ctx(key));
const pay = (inv, amount) => ({ invoiceId: String(inv._id), amount });
const reload = (inv) => db.collection(COLLECTIONS.invoices).findOne({ _id: inv._id });
const ledgerNet = async (account) => {
  const rows = await db.collection(COLLECTIONS.balances).find({ tenantId: tenant, accountId: account }).toArray();
  return rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
};

beforeAll(async () => {
  mongo = await startMongo('lulubiz_receivables_test');
  db = mongo.db;
  ledger = createLedger(mongo.client, db);
  accounts = createAccountService(mongo.client, db);
  parties = createPartyService(mongo.client, db);
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Comercial Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa' }));
  customer = await parties.create(tenant, { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
  other = await parties.create(tenant, { name: 'Ferretería El Sur', roles: ['customer'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 });
  await open();
  receivables = createReceivablesService({ client: mongo.client, db, ledger, accounts, parties, now: () => NOW });
});

describe('estado de cartera de una factura', () => {
  it('una factura a crédito nace con todo su valor por cobrar', async () => {
    const inv = await invoice({ amount: 119_000 });
    expect(await reload(inv)).toMatchObject({ collectible: true, paidTotal: 0, balance: 119_000 });
  });

  it('una venta de contado a caja no tiene cartera; sin cuenta de caja, sí', async () => {
    const withoutCash = await invoice({ paymentMethod: 'cash' });
    expect((await reload(withoutCash)).collectible).toBe(true);

    await createSettingsService(mongo.client, db, accounts).save(tenant, settingsInput('110505'));
    const cashSale = await invoice({ paymentMethod: 'cash', amount: 50_000 });
    expect((await reload(cashSale)).collectible).toBe(false);
    expect(await code(receipt([pay(cashSale, 1_000)]))).toBe('INVALID_STATE');
  });
});

describe('recibo de caja', () => {
  it('cobra una factura completa: asiento RC, saldo en cero y cuentas correctas', async () => {
    const inv = await invoice({ amount: 100_000 });
    const { receipt: rc, replayed } = await receipt([pay(inv, 100_000)], { notes: 'Pago en efectivo' });

    expect(replayed).toBe(false);
    expect(rc).toMatchObject({ status: 'posted', fullNumber: 'RC1', total: 100_000, currency: 'COP', depositAccount: '110505', notes: 'Pago en efectivo' });
    expect(rc.allocations).toEqual([{ invoiceId: inv._id, invoiceFullNumber: inv.fullNumber, amount: 100_000 }]);
    expect(await reload(inv)).toMatchObject({ paidTotal: 100_000, balance: 0 });

    const journal = await ledger.getJournal(tenant, rc.journalId);
    expect(journal).toMatchObject({ docType: 'RC', totalDebit: 100_000, totalCredit: 100_000, source: { kind: 'receipt' } });
    expect(await ledgerNet('110505')).toBe(100_000);
    expect(await ledgerNet('130505')).toBe(0); // la factura la debitó y el cobro la acreditó
  });

  it('repetir la misma clave devuelve el mismo recibo sin cobrar dos veces', async () => {
    const inv = await invoice();
    const key = fresh('rc');
    const first = await receipt([pay(inv, 40_000)], {}, key);
    const again = await receipt([pay(inv, 40_000)], {}, key);
    expect(again.replayed).toBe(true);
    expect(again.receipt._id).toEqual(first.receipt._id);
    expect((await reload(inv)).balance).toBe(60_000);
    expect(await db.collection(COLLECTIONS.receipts).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('cobros parciales acumulan y la numeración no deja huecos', async () => {
    const inv = await invoice({ amount: 100_000 });
    const a = await receipt([pay(inv, 30_000)]);
    const b = await receipt([pay(inv, 70_000)], { depositAccount: '111005' });
    expect([a.receipt.fullNumber, b.receipt.fullNumber]).toEqual(['RC1', 'RC2']);
    expect(await reload(inv)).toMatchObject({ paidTotal: 100_000, balance: 0 });
    expect(await ledgerNet('111005')).toBe(70_000);
  });

  it('un recibo puede aplicar a varias facturas y asienta un solo crédito a por cobrar', async () => {
    const a = await invoice({ amount: 100_000 });
    const b = await invoice({ amount: 50_000 });
    const { receipt: rc } = await receipt([pay(a, 100_000), pay(b, 20_000)]);
    expect(rc.total).toBe(120_000);
    const journal = await ledger.getJournal(tenant, rc.journalId);
    expect(journal.lines).toEqual([
      { accountId: '110505', debit: 120_000, credit: 0 },
      { accountId: '130505', debit: 0, credit: 120_000 },
    ]);
    expect((await reload(b)).balance).toBe(30_000);
  });

  it('cobrar de más se rechaza y no cambia nada, ni siquiera las facturas anteriores del mismo recibo', async () => {
    const a = await invoice({ amount: 100_000 });
    const b = await invoice({ amount: 10_000 });
    expect(await code(receipt([pay(a, 100_000), pay(b, 10_001)]))).toBe('OVER_PAYMENT');
    expect(await reload(a)).toMatchObject({ paidTotal: 0, balance: 100_000 });
    expect(await db.collection(COLLECTIONS.receipts).countDocuments({})).toBe(0);
    expect(await ledgerNet('110505')).toBe(0);
  });

  it('dos cobros simultáneos por todo el saldo: solo uno entra', async () => {
    const inv = await invoice({ amount: 100_000 });
    const attempts = await Promise.allSettled([
      receipt([pay(inv, 100_000)]),
      receipt([pay(inv, 100_000)], { depositAccount: '111005' }),
      receipt([pay(inv, 100_000)]),
    ]);
    const ok = attempts.filter((r) => r.status === 'fulfilled');
    const failed = attempts.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed.every((r) => r.reason.code === 'OVER_PAYMENT')).toBe(true);
    expect(await reload(inv)).toMatchObject({ paidTotal: 100_000, balance: 0 });
    expect((await ledgerNet('110505')) + (await ledgerNet('111005'))).toBe(100_000);
  });

  it('una nota crédito sobre una factura con abonos reduce lo que falta cobrar', async () => {
    const inv = await invoice({ amount: 100_000 });
    await receipt([pay(inv, 30_000)]);
    await invoicing.issueCreditNote(tenant, inv._id, { reasonCode: '1', all: true }, ctx(fresh('nc')));
    expect((await reload(inv)).balance).toBe(-30_000); // se acreditó todo y 30.000 ya estaban cobrados: saldo a favor del cliente
    expect(await code(receipt([pay(inv, 1)]))).toBe('OVER_PAYMENT');
  });

  it('valida cliente, cuentas, fechas, duplicados e importes', async () => {
    const mine = await invoice();
    const theirs = await invoice({ who: other });
    const bad = async (allocations, patch) => code(receipt(allocations, patch));

    expect(await bad([pay(theirs, 1_000)])).toBe('VALIDATION'); // factura de otro cliente
    expect(await bad([pay(mine, 1_000)], { depositAccount: '413505' })).toBe('VALIDATION'); // ingresos no es caja ni bancos
    expect(await bad([pay(mine, 1_000)], { depositAccount: '130505' })).toBe('VALIDATION'); // la misma cuenta por cobrar
    expect(await bad([pay(mine, 1_000)], { depositAccount: '1' })).toBe('VALIDATION'); // cuenta de grupo
    expect(await bad([pay(mine, 1_000)], { depositAccount: '999999' })).toBe('VALIDATION'); // inexistente
    expect(await bad([pay(mine, 1_000)], { date: '2026-04-30' })).toBe('VALIDATION'); // antes de la factura
    expect(await bad([pay(mine, 1_000)], { date: '20/10/2026' })).toBe('VALIDATION');
    expect(await bad([pay(mine, 1_000), pay(mine, 2_000)])).toBe('VALIDATION'); // factura repetida
    expect(await bad([pay(mine, 0)])).toBe('VALIDATION');
    expect(await bad([pay(mine, 1.5)])).toBe('VALIDATION');
    expect(await bad([])).toBe('VALIDATION');
    expect(await bad([{ invoiceId: new ObjectId().toHexString(), amount: 10 }])).toBe('NOT_FOUND');
    expect(await code(receivables.createReceipt(tenant, { partyId: String(new ObjectId()), date: TODAY, depositAccount: '110505', allocations: [pay(mine, 10)] }, ctx(fresh('rc'))))).toBe('NOT_FOUND');
    expect(await code(receivables.createReceipt(tenant, { partyId: String(customer._id), date: TODAY, depositAccount: '110505', allocations: [pay(mine, 10)] }, {}))).toBe('VALIDATION'); // sin clave
    expect(await ledgerNet('110505')).toBe(0);
  });

  it('no cobra facturas rechazadas ni de otra empresa', async () => {
    const mine = await invoice();
    const stranger = toTenantId(new ObjectId());
    expect(await code(receivables.createReceipt(stranger, { partyId: String(customer._id), date: TODAY, depositAccount: '110505', allocations: [pay(mine, 10)] }, ctx(fresh('rc'))))).toBe('NOT_FOUND');
    await db.collection(COLLECTIONS.invoices).updateOne({ _id: mine._id }, { $set: { status: 'rejected' } });
    expect(await code(receipt([pay(mine, 10)]))).toBe('INVALID_STATE');
  });

  it('un período cerrado rechaza el cobro y no deja saldos a medias', async () => {
    const inv = await invoice();
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(receipt([pay(inv, 10_000)]))).toBe('PeriodClosedError');
    expect(await reload(inv)).toMatchObject({ paidTotal: 0, balance: 100_000 });
    expect(await db.collection(COLLECTIONS.receipts).countDocuments({})).toBe(0);
  });
});

describe('anulación de un recibo', () => {
  it('reversa el asiento y devuelve el saldo a las facturas', async () => {
    const inv = await invoice({ amount: 100_000 });
    const { receipt: rc } = await receipt([pay(inv, 100_000)]);
    const voided = await receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x'));

    expect(voided.receipt).toMatchObject({ status: 'void' });
    expect(voided.receipt.voidJournalId).toBeDefined();
    expect(await reload(inv)).toMatchObject({ paidTotal: 0, balance: 100_000 });
    expect(await ledgerNet('110505')).toBe(0);
    expect(await ledgerNet('130505')).toBe(100_000);
    // Se puede volver a cobrar.
    await receipt([pay(inv, 100_000)]);
    expect((await reload(inv)).balance).toBe(0);
  });

  it('anular dos veces no devuelve el saldo dos veces', async () => {
    const inv = await invoice({ amount: 100_000 });
    const { receipt: rc } = await receipt([pay(inv, 40_000)]);
    await receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x'));
    const again = await receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x'));
    expect(again.replayed).toBe(true);
    expect((await reload(inv)).balance).toBe(100_000);
  });

  it('dos anulaciones simultáneas devuelven el saldo una sola vez', async () => {
    const inv = await invoice({ amount: 100_000 });
    const { receipt: rc } = await receipt([pay(inv, 100_000)]);
    await Promise.allSettled([receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x')), receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x'))]);
    expect(await reload(inv)).toMatchObject({ paidTotal: 0, balance: 100_000 });
    expect(await ledgerNet('110505')).toBe(0);
  });

  it('un período cerrado impide anular y todo queda como estaba', async () => {
    const inv = await invoice();
    const { receipt: rc } = await receipt([pay(inv, 10_000)]);
    await ledger.closePeriod(tenant, '2026-10', user);
    expect(await code(receivables.voidReceipt(tenant, String(rc._id), {}, ctx('x')))).toBe('PeriodClosedError');
    expect((await receivables.getReceipt(tenant, String(rc._id))).status).toBe('posted');
    expect((await reload(inv)).balance).toBe(90_000);
  });

  it('un recibo inexistente o de otra empresa no se anula', async () => {
    expect(await code(receivables.voidReceipt(tenant, String(new ObjectId()), {}, ctx('x')))).toBe('NOT_FOUND');
    const inv = await invoice();
    const { receipt: rc } = await receipt([pay(inv, 10)]);
    expect(await code(receivables.voidReceipt(toTenantId(new ObjectId()), String(rc._id), {}, ctx('x')))).toBe('NOT_FOUND');
  });
});

describe('listas y cartera por edades', () => {
  it('lista las facturas abiertas de un cliente por vencimiento y sin las pagadas', async () => {
    const late = await invoice({ amount: 10_000, due: '2026-09-01' });
    const soon = await invoice({ amount: 20_000, due: '2026-12-01' });
    const paid = await invoice({ amount: 30_000, due: '2026-10-05' });
    await invoice({ amount: 40_000, who: other });
    await receipt([pay(paid, 30_000)]);
    const open = await receivables.listOpenInvoices(tenant, { partyId: String(customer._id), currency: 'COP' });
    expect(open.map((o) => o.fullNumber)).toEqual([late.fullNumber, soon.fullNumber]);
    expect(open[0]).toMatchObject({ total: 10_000, paid: 0, balance: 10_000 });
  });

  it('reparte el saldo en vigente, 1-30, 31-60, 61-90 y más de 90 días, por cliente', async () => {
    await invoice({ amount: 1_000, due: '2026-10-25' }); // vigente
    await invoice({ amount: 2_000, due: '2026-10-20' }); // vence hoy: vigente
    await invoice({ amount: 3_000, due: '2026-10-10' }); // 10 días
    await invoice({ amount: 4_000, due: '2026-09-20' }); // 30 días: aún 1-30
    await invoice({ amount: 5_000, due: '2026-09-19' }); // 31 días
    await invoice({ amount: 6_000, due: '2026-08-01' }); // 80 días
    await invoice({ amount: 7_000, due: '2026-06-01' }); // 141 días
    await invoice({ amount: 8_000, due: '2026-06-01', who: other });
    const paid = await invoice({ amount: 9_000, due: '2026-06-01' });
    await receipt([pay(paid, 9_000)]);
    const partial = await invoice({ amount: 10_000, due: '2026-10-10' });
    await receipt([pay(partial, 4_000)]);

    const report = await receivables.aging(tenant, { currency: 'COP' });
    expect(report).toMatchObject({ asOf: TODAY, currency: 'COP', customers: 2, truncated: false });
    const mine = report.rows.find((r) => r.name === 'Droguería Los Andes');
    expect(mine).toMatchObject({ current: 3_000, d1_30: 3_000 + 4_000 + 6_000, d31_60: 5_000, d61_90: 6_000, d90plus: 7_000, invoices: 8 });
    expect(mine.total).toBe(3_000 + 13_000 + 5_000 + 6_000 + 7_000);
    expect(report.rows.find((r) => r.name === 'Ferretería El Sur')).toMatchObject({ d90plus: 8_000, total: 8_000 });
    expect(report.totals.total).toBe(report.rows.reduce((acc, r) => acc + r.total, 0));
    expect(report.rows[0].total).toBeGreaterThanOrEqual(report.rows[1].total);
  });

  it('una empresa sin cartera devuelve un informe vacío', async () => {
    expect(await receivables.aging(tenant, { currency: 'COP' })).toMatchObject({ rows: [], customers: 0, totals: { total: 0, invoices: 0 } });
  });

  it('lista los recibos del más reciente al más antiguo, con filtros y cursor', async () => {
    const inv = await invoice({ amount: 100_000 });
    for (let i = 0; i < 5; i += 1) await receipt([pay(inv, 1_000)]);
    const first = await receivables.listReceipts(tenant, { limit: 2 });
    expect(first.items.map((r) => r.fullNumber)).toEqual(['RC5', 'RC4']);
    const second = await receivables.listReceipts(tenant, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((r) => r.fullNumber)).toEqual(['RC3', 'RC2']);
    const { receipt: last } = await receipt([pay(inv, 1_000)]);
    await receivables.voidReceipt(tenant, String(last._id), {}, ctx('x'));
    expect((await receivables.listReceipts(tenant, { status: 'void' })).items).toHaveLength(1);
    expect((await receivables.listReceipts(tenant, { partyId: String(other._id) })).items).toEqual([]);
  });
});

describe('coherencia con el libro', () => {
  it('la suma de saldos por cobrar de las facturas es el saldo de la cuenta por cobrar tras facturar, cobrar, acreditar y anular', async () => {
    const a = await invoice({ amount: 100_000 });
    const b = await invoice({ amount: 250_000, who: other });
    const c = await invoice({ amount: 70_000 });
    const { receipt: r1 } = await receipt([pay(a, 60_000), pay(c, 70_000)]);
    await receipt([pay(a, 10_000)]);
    await invoicing.issueCreditNote(tenant, b._id, { reasonCode: '1', all: true }, ctx(fresh('nc')));
    await receivables.voidReceipt(tenant, String(r1._id), {}, ctx('x'));
    await receivables.createReceipt(tenant, { partyId: String(other._id), date: TODAY, depositAccount: '111005', allocations: [] }, ctx(fresh('rc'))).catch(() => {});

    const invoices = await db.collection(COLLECTIONS.invoices).find({ tenantId: tenant, collectible: true }).toArray();
    const sum = invoices.reduce((acc, inv) => acc + inv.balance, 0);
    expect(await ledgerNet('130505')).toBe(sum);
    // 100.000 + 250.000 + 70.000 − 10.000 cobrado − 250.000 acreditado
    expect(sum).toBe(160_000);
  });
});
