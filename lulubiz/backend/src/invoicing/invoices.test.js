import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccountService } from '../accounts/accounts.js';
import { createAuthService } from '../auth/auth.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createLedger } from '../ledger/ledger.js';
import { createPartyService } from '../parties/parties.js';
import { startMongo } from '../testing/mongo.js';
import { createInvoicingService } from './invoices.js';
import { ProviderUnavailableError, createSandboxProvider } from './provider.js';
import { createResolutionService } from './resolutions.js';
import { createSettingsService } from './settings.js';

let mongo;
let db;
let ledger;
let accounts;
let parties;
let settings;
let resolutions;
let tenant;
let customer;
let events;
const user = new ObjectId();

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

/** Proveedor guionizado: cada llamada nueva consume el siguiente resultado; repetir una referencia ya aceptada devuelve lo mismo. */
function scriptedProvider(script = []) {
  const accepted = new Map();
  const queue = [...script];
  const calls = [];
  return {
    name: 'guionizado',
    sandbox: false,
    calls,
    async issue({ kind, reference, document }) {
      calls.push({ kind, reference });
      if (accepted.has(reference)) return accepted.get(reference);
      const step = queue.shift() ?? 'accept';
      if (step === 'timeout') throw new ProviderUnavailableError();
      if (step === 'reject') return { status: 'rejected', code: 'RECHAZO', message: 'documento rechazado por el proveedor' };
      const receipt = { status: 'accepted', cufe: `CUFE-${reference}`, qr: `QR-${reference}`, validatedAt: new Date(), reference };
      accepted.set(reference, receipt);
      void document;
      return receipt;
    },
    async status(reference) {
      return accepted.get(reference) ?? { status: 'unknown' };
    },
  };
}

const ctx = (key) => ({
  idempotencyKey: key,
  userId: user,
  auditTx: async (session, event) => {
    events.push(event);
    await db.collection(COLLECTIONS.audit).insertOne({ ...event, at: new Date(), tenantId: tenant }, { session });
  },
});

const invoiceInput = (overrides = {}) => ({
  customerId: String(customer._id),
  issueDate: new Date().toISOString().slice(0, 10),
  paymentMethod: 'credit',
  dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  lines: [
    { description: 'Servicio de consultoría', quantity: 2000, unitPrice: 50_000, vatBps: 1900 },
    { description: 'Mercancía', quantity: 1000, unitPrice: 20_000, discountBps: 1000, vatBps: 500 },
  ],
  ...overrides,
});

const issuerSettings = {
  issuer: {
    name: 'Comercial Andina SAS',
    taxIdType: 'NIT',
    taxId: '890903938',
    checkDigit: 8,
    regime: 'responsable_iva',
    address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' },
  },
  accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
};

const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;

async function openResolutions({ from = 1, to = 100 } = {}) {
  await resolutions.create(tenant, { docType: 'invoice', prefix: 'FE', number: '18760000001', from, to, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
  await resolutions.create(tenant, { docType: 'credit_note', prefix: 'NC', number: '18760000002', from: 1, to: 100, validFrom: LAST_YEAR, validTo: NEXT_YEAR });
}

async function setup({ provider = scriptedProvider(), withSettings = true, withResolutions = true } = {}) {
  await accounts.create(tenant, { code: '1', name: 'Activo', type: 'asset', postable: false });
  await accounts.create(tenant, { code: '110505', name: 'Caja', type: 'asset', parentCode: '1' });
  await accounts.create(tenant, { code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await accounts.create(tenant, { code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await accounts.create(tenant, { code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await accounts.create(tenant, { code: '4', name: 'Ingresos', type: 'income', postable: false });
  await accounts.create(tenant, { code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  await accounts.create(tenant, { code: '413510', name: 'Otros ingresos', type: 'income', parentCode: '4' });
  if (withSettings) await settings.save(tenant, issuerSettings);
  if (withResolutions) await openResolutions();
  return createInvoicingService({ client: mongo.client, db, ledger, accounts, parties, settings, resolutions, provider });
}

const balance = (account) => ledger.getBalance(tenant, account, new Date().toISOString().slice(0, 7), 'COP');

beforeAll(async () => {
  mongo = await startMongo('lulubiz_invoicing_test');
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
  events = [];
  const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  ({ tenantId: tenant } = await auth.registerTenant({
    companyName: 'Comercial Andina SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'm@andina.co', password: 'correcto-caballo-grapa',
  }));
  customer = await parties.create(tenant, { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
});

describe('configuración del emisor', () => {
  it('guarda al emisor y las cuentas, y es repetible', async () => {
    await setup({ withSettings: false, withResolutions: false });
    const saved = await settings.save(tenant, issuerSettings);
    expect(saved.issuer.address.country).toBe('CO');
    await settings.save(tenant, { ...issuerSettings, accounts: { ...issuerSettings.accounts, cash: '110505' } });
    expect((await settings.get(tenant)).accounts.cash).toBe('110505');
    expect(await db.collection(COLLECTIONS.settings).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('rechaza NIT con dígito incorrecto, régimen ausente, cuentas inexistentes o de agrupación', async () => {
    await setup({ withSettings: false, withResolutions: false });
    const bad = (patch) => settings.save(tenant, { ...issuerSettings, ...patch });
    expect(await code(bad({ issuer: { ...issuerSettings.issuer, checkDigit: 3 } }))).toBe('VALIDATION');
    expect(await code(bad({ issuer: { ...issuerSettings.issuer, regime: 'otro' } }))).toBe('VALIDATION');
    expect(await code(bad({ issuer: { ...issuerSettings.issuer, address: {} } }))).toBe('VALIDATION');
    expect(await code(bad({ accounts: { ...issuerSettings.accounts, income: '999999' } }))).toBe('VALIDATION');
    expect(await code(bad({ accounts: { ...issuerSettings.accounts, vatPayable: '2' } }))).toBe('VALIDATION'); // agrupación
    expect(await code(bad({ accounts: { receivable: '130505' } }))).toBe('VALIDATION');
  });

  it('no mezcla la configuración de empresas distintas', async () => {
    await setup();
    expect(await settings.get(new ObjectId())).toBeNull();
  });
});

describe('resoluciones de numeración', () => {
  it('valida el rango y la vigencia, y no admite rangos solapados', async () => {
    await setup({ withResolutions: false });
    const make = (patch) => resolutions.create(tenant, { docType: 'invoice', prefix: 'FE', number: 'R1', from: 1, to: 10, validFrom: LAST_YEAR, validTo: NEXT_YEAR, ...patch });
    expect(await code(make({ from: 10, to: 5 }))).toBe('VALIDATION');
    expect(await code(make({ from: 0 }))).toBe('VALIDATION');
    expect(await code(make({ prefix: 'DEMASIADO-LARGO' }))).toBe('VALIDATION');
    expect(await code(make({ docType: 'recibo' }))).toBe('VALIDATION');
    expect(await code(make({ validFrom: '2026/01/01' }))).toBe('VALIDATION');
    expect(await code(make({ validFrom: NEXT_YEAR, validTo: LAST_YEAR }))).toBe('VALIDATION');
    expect(await code(make({}))).toBeNull();
    expect(await code(make({ from: 5, to: 20 }))).toBe('DUPLICATE'); // solapa 5..10
    expect(await code(make({ from: 11, to: 20 }))).toBeNull();
    expect(await code(make({ prefix: 'FX', from: 5, to: 20 }))).toBeNull(); // otro prefijo
  });

  it('asigna números consecutivos, sin repetir, aunque se pidan a la vez', async () => {
    const invoicing = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => invoicing.issueInvoice(tenant, invoiceInput(), ctx(`k-${i}-xxxxxxxx`))));
    const numbers = results.map((r) => r.invoice.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.invoice.fullNumber)).size).toBe(12);
  });

  it('al agotarse el rango o vencer la resolución, no emite y lo dice', async () => {
    const invoicing = await setup({ withResolutions: false });
    await openResolutions({ from: 1, to: 2 });
    await invoicing.issueInvoice(tenant, invoiceInput(), ctx('a-1-xxxxxxxx'));
    await invoicing.issueInvoice(tenant, invoiceInput(), ctx('a-2-xxxxxxxx'));
    expect(await code(invoicing.issueInvoice(tenant, invoiceInput(), ctx('a-3-xxxxxxxx')))).toBe('NO_RESOLUTION');
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({ tenantId: tenant })).toBe(2);

    // Una resolución vencida tampoco sirve, aunque le sobren números.
    await db.collection(COLLECTIONS.resolutions).updateMany({}, { $set: { to: 100, validTo: new Date('2020-01-01') } });
    expect(await code(invoicing.issueInvoice(tenant, invoiceInput(), ctx('a-4-xxxxxxxx')))).toBe('NO_RESOLUTION');
  });

  it('desactivar una resolución impide usarla', async () => {
    const invoicing = await setup();
    const [first] = await resolutions.list(tenant);
    for (const r of await resolutions.list(tenant)) await resolutions.deactivate(tenant, r._id);
    expect(first).toBeDefined();
    expect(await code(invoicing.issueInvoice(tenant, invoiceInput(), ctx('d-1-xxxxxxxx')))).toBe('NO_RESOLUTION');
  });
});

describe('emitir una factura', () => {
  it('queda emitida con la validación del proveedor y contabilizada en la misma operación', async () => {
    const invoicing = await setup();
    const { invoice, replayed } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('f-1-xxxxxxxx'));
    expect(replayed).toBe(false);
    expect(invoice).toMatchObject({ status: 'issued', fullNumber: 'FE1', cufe: expect.stringMatching(/^CUFE-/), accounting: { status: 'posted' }, creditStatus: 'none' });

    // 2 × 50 000 = 100 000 neto con IVA 19 % = 19 000; 20 000 − 10 % = 18 000 neto con IVA 5 % = 900. Total 137 900.
    expect(invoice.totals).toMatchObject({ subtotal: 118_000, tax: 19_900, total: 137_900 });
    expect(invoice.totals.taxByRate.map((r) => [r.vatBps, r.base, r.tax])).toEqual([[500, 18_000, 900], [1900, 100_000, 19_000]]);

    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
    expect(await balance('413505')).toEqual({ debit: 0, credit: 118_000 });
    expect(await balance('240805')).toEqual({ debit: 0, credit: 19_900 });

    const journal = await ledger.getJournal(tenant, invoice.accounting.journalId);
    expect(journal).toMatchObject({ docType: 'FV', totalDebit: 137_900, totalCredit: 137_900 });
    expect(events.map((e) => e.action)).toEqual(['invoice.create', 'invoice.issue']);
  });

  it('repetir la misma clave devuelve la misma factura y no duplica nada', async () => {
    const invoicing = await setup();
    const first = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('r-1-xxxxxxxx'));
    const again = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('r-1-xxxxxxxx'));
    expect(again.replayed).toBe(true);
    expect(again.invoice._id.equals(first.invoice._id)).toBe(true);
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({ tenantId: tenant })).toBe(1);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(1);
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
  });

  it('diez envíos simultáneos con la misma clave producen una sola factura y un solo asiento', async () => {
    const invoicing = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => invoicing.issueInvoice(tenant, invoiceInput(), ctx('s-1-xxxxxxxx'))));
    expect(new Set(results.map((r) => String(r.invoice._id))).size).toBe(1);
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({ tenantId: tenant })).toBe(1);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(1);
    expect(results.every((r) => r.invoice.status === 'issued')).toBe(true);
  });

  it('a contado usa la cuenta de caja si está configurada; si no, la de por cobrar', async () => {
    const invoicing = await setup();
    await invoicing.issueInvoice(tenant, invoiceInput({ paymentMethod: 'cash', dueDate: undefined }), ctx('c-1-xxxxxxxx'));
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
    await settings.save(tenant, { ...issuerSettings, accounts: { ...issuerSettings.accounts, cash: '110505' } });
    await invoicing.issueInvoice(tenant, invoiceInput({ paymentMethod: 'cash', dueDate: undefined }), ctx('c-2-xxxxxxxx'));
    expect(await balance('110505')).toEqual({ debit: 137_900, credit: 0 });
  });

  it('cada línea puede ir a otra cuenta de ingresos', async () => {
    const invoicing = await setup();
    const input = invoiceInput();
    input.lines[1].accountId = '413510';
    await invoicing.issueInvoice(tenant, input, ctx('o-1-xxxxxxxx'));
    expect(await balance('413505')).toEqual({ debit: 0, credit: 100_000 });
    expect(await balance('413510')).toEqual({ debit: 0, credit: 18_000 });
  });

  it('una factura posterior no cambia por cambiar la configuración de cuentas (usa las fijadas al crearla)', async () => {
    const provider = scriptedProvider(['timeout']);
    const invoicing = await setup({ provider });
    const { invoice } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('x-1-xxxxxxxx')); // queda pendiente
    expect(invoice.status).toBe('pending_provider');
    await accounts.create(tenant, { code: '130510', name: 'Otra por cobrar', type: 'asset', parentCode: '1' });
    await settings.save(tenant, { ...issuerSettings, accounts: { ...issuerSettings.accounts, receivable: '130510' } });
    await invoicing.submitInvoice(tenant, invoice._id, ctx('x-1-xxxxxxxx'));
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
    expect(await balance('130510')).toEqual({ debit: 0, credit: 0 });
  });
});

describe('validación de la entrada', () => {
  const rejects = async (invoicing, patch, expectedCode = 'VALIDATION', pattern) => {
    const err = await invoicing.issueInvoice(tenant, invoiceInput(patch), ctx(`v-${Math.random()}-xxxxxxxx`)).then(() => null, (e) => e);
    expect(err, JSON.stringify(patch)).not.toBeNull();
    expect(err.code).toBe(expectedCode);
    if (pattern) expect(err.message).toMatch(pattern);
  };

  it('rechaza líneas inválidas, tarifas de IVA no permitidas y totales en cero', async () => {
    const invoicing = await setup();
    await rejects(invoicing, { lines: [] }, 'VALIDATION', /al menos una línea/);
    await rejects(invoicing, { lines: [{ description: '', quantity: 1000, unitPrice: 100, vatBps: 0 }] }, 'VALIDATION', /descripción/);
    await rejects(invoicing, { lines: [{ description: 'x', quantity: 1500.5, unitPrice: 100, vatBps: 0 }] }, 'VALIDATION', /cantidad/);
    await rejects(invoicing, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100, vatBps: 1600 }] }, 'VALIDATION', /tarifa de IVA/);
    await rejects(invoicing, { lines: [{ description: 'x', quantity: 1000, unitPrice: 0, vatBps: 0 }] }, 'VALIDATION', /mayor que cero/);
    await rejects(invoicing, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100, vatBps: 0, accountId: '999999' }] }, 'VALIDATION', /999999/);
  });

  it('rechaza cliente inexistente, inactivo o que no es cliente, y fechas inválidas', async () => {
    const invoicing = await setup();
    await rejects(invoicing, { customerId: String(new ObjectId()) }, 'NOT_FOUND');
    const supplier = await parties.create(tenant, { name: 'Proveedor', roles: ['supplier'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 });
    await rejects(invoicing, { customerId: String(supplier._id) }, 'VALIDATION', /cliente/);
    await parties.setActive(tenant, customer._id, false);
    await rejects(invoicing, {}, 'VALIDATION', /inactivo/);
    await parties.setActive(tenant, customer._id, true);
    await rejects(invoicing, { issueDate: '2999-01-01' }, 'VALIDATION', /futura/);
    await rejects(invoicing, { issueDate: '2026-02-30' }, 'VALIDATION', /fecha válida/);
    await rejects(invoicing, { paymentMethod: 'trueque' }, 'VALIDATION', /contado o crédito/);
    await rejects(invoicing, { dueDate: undefined }, 'VALIDATION', /vencimiento/);
    await rejects(invoicing, { dueDate: '2000-01-01' }, 'VALIDATION', /anterior/);
  });

  it('un emisor no responsable de IVA no puede facturar con IVA', async () => {
    const invoicing = await setup();
    await settings.save(tenant, { ...issuerSettings, issuer: { ...issuerSettings.issuer, regime: 'no_responsable' } });
    await rejects(invoicing, {}, 'VALIDATION', /no responsable de IVA/);
    const ok = invoiceInput({ lines: [{ description: 'Servicio', quantity: 1000, unitPrice: 50_000, vatBps: 0 }] });
    expect((await invoicing.issueInvoice(tenant, ok, ctx('n-1-xxxxxxxx'))).invoice.status).toBe('issued');
  });

  it('sin configuración, sin resolución o sin proveedor no emite, y dice qué falta', async () => {
    const noSettings = await setup({ withSettings: false });
    await rejects(noSettings, {}, 'SETTINGS_INCOMPLETE', /emisor/);
    expect(await db.collection(COLLECTIONS.invoices).countDocuments({})).toBe(0);

    await db.dropDatabase();
    await ensureIndexes(db);
    const auth = createAuthService(mongo.client, db, { passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
    ({ tenantId: tenant } = await auth.registerTenant({ companyName: 'Otra SAS', country: 'CO', currency: 'COP', ownerName: 'M', email: 'o@x.co', password: 'correcto-caballo-grapa' }));
    customer = await parties.create(tenant, { name: 'Cliente', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 });
    const noResolution = await setup({ withResolutions: false });
    await rejects(noResolution, {}, 'NO_RESOLUTION');
    const status = await noResolution.status(tenant);
    expect(status).toMatchObject({ configured: true, ready: false });
    expect(status.missing.join(' ')).toMatch(/resolución/);

    const noProvider = createInvoicingService({ client: mongo.client, db, ledger, accounts, parties, settings, resolutions, provider: null });
    await rejects(noProvider, {}, 'NOT_CONFIGURED');
    expect((await noProvider.status(tenant)).configured).toBe(false);
  });
});

describe('respuestas del proveedor', () => {
  it('un rechazo deja la factura rechazada, conserva el número y no contabiliza', async () => {
    const provider = scriptedProvider(['reject']);
    const invoicing = await setup({ provider });
    const { invoice, rejected } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('j-1-xxxxxxxx'));
    expect(rejected).toBe(true);
    expect(invoice).toMatchObject({ status: 'rejected', fullNumber: 'FE1', rejection: { code: 'RECHAZO' } });
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await balance('130505')).toEqual({ debit: 0, credit: 0 });

    // Reenviarla: el proveedor ahora la acepta, y se emite con el mismo número.
    const retried = await invoicing.submitInvoice(tenant, invoice._id, ctx('j-1-xxxxxxxx'));
    expect(retried.invoice).toMatchObject({ status: 'issued', fullNumber: 'FE1', accounting: { status: 'posted' } });
    expect(retried.invoice.rejection).toBeUndefined();
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
  });

  it('si el proveedor no responde, queda pendiente sin contabilizar, y al reintentar se emite una sola vez', async () => {
    const provider = scriptedProvider(['timeout']);
    const invoicing = await setup({ provider });
    const first = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('t-1-xxxxxxxx'));
    expect(first.pending).toBe(true);
    expect(first.invoice.status).toBe('pending_provider');
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);

    const [a, b] = await Promise.all([invoicing.submitInvoice(tenant, first.invoice._id, ctx('t-1-xxxxxxxx')), invoicing.submitInvoice(tenant, first.invoice._id, ctx('t-1-xxxxxxxx'))]);
    expect(a.invoice.status).toBe('issued');
    expect(b.invoice.status).toBe('issued');
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(1);
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });
    // El proveedor se llamó con la misma referencia en cada intento: así puede ser idempotente.
    expect(new Set(provider.calls.map((c) => c.reference)).size).toBe(1);
  });

  it('el simulador valida lo mismo que un proveedor y se marca como no válido ante la autoridad', async () => {
    const invoicing = await setup({ provider: createSandboxProvider() });
    const { invoice } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('z-1-xxxxxxxx'));
    expect(invoice).toMatchObject({ status: 'issued', provider: { name: 'sandbox', sandbox: true } });
    expect(invoice.cufe).toMatch(/^SANDBOX-/);
    expect(invoice.qr).toMatch(/^SANDBOX-QR:/);

    const rechazar = await parties.create(tenant, { name: 'Cliente RECHAZAR', roles: ['customer'], taxIdType: 'CC', taxId: '1075123456' });
    const rejected = await invoicing.issueInvoice(tenant, invoiceInput({ customerId: String(rechazar._id) }), ctx('z-2-xxxxxxxx'));
    expect(rejected.invoice).toMatchObject({ status: 'rejected', rejection: { code: 'SANDBOX_REJECTED' } });

    const timeout = await parties.create(tenant, { name: 'Cliente TIMEOUT', roles: ['customer'], taxIdType: 'CC', taxId: '1075123457' });
    const pending = await invoicing.issueInvoice(tenant, invoiceInput({ customerId: String(timeout._id) }), ctx('z-3-xxxxxxxx'));
    expect(pending.pending).toBe(true);
    const done = await invoicing.submitInvoice(tenant, pending.invoice._id, ctx('z-3-xxxxxxxx'));
    expect(done.invoice.status).toBe('issued');
  });

  it('el simulador rechaza un documento cuyos totales no coinciden con sus líneas', async () => {
    const sandbox = createSandboxProvider();
    const document = {
      kind: 'invoice',
      issuer: { taxId: '1' },
      customer: { taxId: '2', name: 'Cliente' },
      number: { fullNumber: 'FE1' },
      lines: [{ quantity: 1000, unitPrice: 10_000, discountBps: 0, vatBps: 1900 }],
      totals: { subtotal: 10_000, discount: 0, tax: 1900, total: 99_999 },
    };
    const result = await sandbox.issue({ kind: 'invoice', reference: 'r1', document });
    expect(result).toMatchObject({ status: 'rejected', code: 'SANDBOX_VALIDATION' });
    expect(result.message).toMatch(/totales no coinciden/);
  });
});

describe('contabilización tras la validación del proveedor', () => {
  const month = () => new Date().toISOString().slice(0, 7);

  it('si el período está cerrado, la factura queda emitida con la contabilización pendiente, y se contabiliza al reabrir', async () => {
    const invoicing = await setup();
    await ledger.closePeriod(tenant, month(), user);
    const { invoice } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('p-1-xxxxxxxx'));

    // La validación del proveedor no se pierde.
    expect(invoice).toMatchObject({ status: 'issued', cufe: expect.stringMatching(/^CUFE-/), accounting: { status: 'pending' } });
    expect(invoice.accounting.error).toMatch(/cerrado/);
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(0);
    expect(await code(invoicing.accountInvoice(tenant, invoice._id, ctx('p-1-xxxxxxxx')))).toBe('PeriodClosedError');

    await ledger.reopenPeriod(tenant, month(), user);
    const posted = await invoicing.accountInvoice(tenant, invoice._id, ctx('p-1-xxxxxxxx'));
    expect(posted.accounting.status).toBe('posted');
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });

    // Contabilizar otra vez no duplica el asiento.
    await invoicing.accountInvoice(tenant, invoice._id, ctx('p-1-xxxxxxxx'));
    expect(await db.collection(COLLECTIONS.journals).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('solo se contabilizan facturas ya emitidas', async () => {
    const invoicing = await setup({ provider: scriptedProvider(['reject']) });
    const { invoice } = await invoicing.issueInvoice(tenant, invoiceInput(), ctx('q-1-xxxxxxxx'));
    expect(await code(invoicing.accountInvoice(tenant, invoice._id, ctx('q-1-xxxxxxxx')))).toBe('INVALID_STATE');
  });
});

describe('notas crédito', () => {
  const issue = async (invoicing, key = 'i-1-xxxxxxxx', input = invoiceInput()) => (await invoicing.issueInvoice(tenant, input, ctx(key))).invoice;
  const credit = (invoicing, invoice, input, key) => invoicing.issueCreditNote(tenant, invoice._id, { reasonCode: '1', ...input }, ctx(key));

  it('acredita toda la factura: el asiento compensa exactamente y la factura queda acreditada', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    const { note } = await credit(invoicing, invoice, { all: true }, 'n-1-xxxxxxxx');
    expect(note).toMatchObject({ status: 'issued', fullNumber: 'NC1', invoiceFullNumber: 'FE1', accounting: { status: 'posted' } });
    expect(note.totals.total).toBe(invoice.totals.total);

    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 137_900 });
    expect(await balance('413505')).toEqual({ debit: 118_000, credit: 118_000 });
    expect(await balance('240805')).toEqual({ debit: 19_900, credit: 19_900 });

    const reloaded = await invoicing.getInvoice(tenant, invoice._id);
    expect(reloaded).toMatchObject({ creditedTotal: 137_900, creditStatus: 'full' });
    expect(await code(credit(invoicing, invoice, { all: true }, 'n-2-xxxxxxxx'))).toBe('OVER_CREDIT');
  });

  it('acredita por partes: tres notas de una línea de tres unidades suman justo la línea', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing, 'i-2-xxxxxxxx', invoiceInput({ lines: [{ description: 'Pieza', quantity: 3000, unitPrice: 3_333, vatBps: 1900 }] }));
    const one = (key) => credit(invoicing, invoice, { lines: [{ lineIndex: 0, quantity: 1000 }] }, key);
    const a = await one('p-1-xxxxxxxx');
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditStatus).toBe('partial');
    const b = await one('p-2-xxxxxxxx');
    const c = await one('p-3-xxxxxxxx');
    const sum = (field) => [a, b, c].reduce((s, r) => s + r.note.totals[field], 0);
    expect(sum('subtotal')).toBe(invoice.totals.subtotal);
    expect(sum('tax')).toBe(invoice.totals.tax);
    expect(sum('total')).toBe(invoice.totals.total);
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditStatus).toBe('full');
    expect(await code(one('p-4-xxxxxxxx'))).toBe('OVER_CREDIT');
    expect(await balance('130505')).toEqual({ debit: invoice.totals.total, credit: invoice.totals.total });
  });

  it('no deja acreditar más de lo facturado ni líneas inexistentes ni motivos inventados', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    expect(await code(credit(invoicing, invoice, { lines: [{ lineIndex: 0, quantity: 2001 }] }, 'e-1-xxxxxxxx'))).toBe('OVER_CREDIT');
    expect(await code(credit(invoicing, invoice, { lines: [{ lineIndex: 9, quantity: 1 }] }, 'e-2-xxxxxxxx'))).toBe('VALIDATION');
    expect(await code(credit(invoicing, invoice, { lines: [{ lineIndex: 0, quantity: 1 }, { lineIndex: 0, quantity: 1 }] }, 'e-3-xxxxxxxx'))).toBe('VALIDATION');
    expect(await code(invoicing.issueCreditNote(tenant, invoice._id, { reasonCode: '99', all: true }, ctx('e-4-xxxxxxxx')))).toBe('VALIDATION');
    expect(await code(credit(invoicing, invoice, { lines: [] }, 'e-5-xxxxxxxx'))).toBe('OVER_CREDIT');
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditedTotal).toBe(0);
  });

  it('solo se acreditan facturas emitidas', async () => {
    const invoicing = await setup({ provider: scriptedProvider(['reject']) });
    const invoice = await issue(invoicing);
    expect(invoice.status).toBe('rejected');
    expect(await code(credit(invoicing, invoice, { all: true }, 'r-1-xxxxxxxx'))).toBe('INVALID_STATE');
  });

  it('dos notas simultáneas por todo lo que queda: solo una prospera y no se acredita de más', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    const outcomes = await Promise.all(
      ['c-1-xxxxxxxx', 'c-2-xxxxxxxx', 'c-3-xxxxxxxx'].map((key) => credit(invoicing, invoice, { all: true }, key).then(() => 'ok', (e) => e.code)),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'OVER_CREDIT')).toHaveLength(2);
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditedTotal).toBe(invoice.totals.total);
    expect(await db.collection(COLLECTIONS.creditNotes).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('repetir la misma clave devuelve la misma nota', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    const first = await credit(invoicing, invoice, { all: true }, 'k-1-xxxxxxxx');
    const again = await credit(invoicing, invoice, { all: true }, 'k-1-xxxxxxxx');
    expect(again.replayed).toBe(true);
    expect(again.note._id.equals(first.note._id)).toBe(true);
    expect(await db.collection(COLLECTIONS.creditNotes).countDocuments({ tenantId: tenant })).toBe(1);
  });

  it('si el proveedor rechaza la nota, se libera lo reservado y se puede volver a intentar', async () => {
    const provider = scriptedProvider(['accept', 'reject']); // factura aceptada, primera nota rechazada
    const invoicing = await setup({ provider });
    const invoice = await issue(invoicing);
    const first = await credit(invoicing, invoice, { all: true }, 'x-1-xxxxxxxx');
    expect(first.rejected).toBe(true);
    expect(first.note.status).toBe('rejected');
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditedTotal).toBe(0);
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 0 });

    const second = await credit(invoicing, invoice, { all: true }, 'x-2-xxxxxxxx');
    expect(second.note.status).toBe('issued');
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditStatus).toBe('full');
    // Una nota rechazada es definitiva: reenviarla no la revive.
    expect((await invoicing.submitCreditNote(tenant, first.note._id, ctx('x-1-xxxxxxxx'))).rejected).toBe(true);
  });

  it('si el proveedor no responde queda pendiente, y la reserva se mantiene hasta resolverse', async () => {
    const provider = scriptedProvider(['accept', 'timeout']);
    const invoicing = await setup({ provider });
    const invoice = await issue(invoicing);
    const pending = await credit(invoicing, invoice, { all: true }, 'w-1-xxxxxxxx');
    expect(pending.pending).toBe(true);
    expect((await invoicing.getInvoice(tenant, invoice._id)).creditedTotal).toBe(invoice.totals.total); // reservado
    expect(await code(credit(invoicing, invoice, { all: true }, 'w-2-xxxxxxxx'))).toBe('OVER_CREDIT');
    const done = await invoicing.submitCreditNote(tenant, pending.note._id, ctx('w-1-xxxxxxxx'));
    expect(done.note.status).toBe('issued');
  });

  it('con el período cerrado, la nota queda emitida con la contabilización pendiente, y se contabiliza al reabrir', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    await ledger.closePeriod(tenant, new Date().toISOString().slice(0, 7), user);
    const { note } = await credit(invoicing, invoice, { all: true }, 'z-1-xxxxxxxx');
    expect(note).toMatchObject({ status: 'issued', accounting: { status: 'pending' } });
    await ledger.reopenPeriod(tenant, new Date().toISOString().slice(0, 7), user);
    expect((await invoicing.accountCreditNote(tenant, note._id, ctx('z-1-xxxxxxxx'))).accounting.status).toBe('posted');
    // La factura y su nota crédito se compensan por completo en la cuenta por cobrar.
    expect(await balance('130505')).toEqual({ debit: 137_900, credit: 137_900 });
  });

  it('una empresa no ve ni acredita las facturas de otra', async () => {
    const invoicing = await setup();
    const invoice = await issue(invoicing);
    const stranger = new ObjectId();
    expect(await invoicing.getInvoice(stranger, invoice._id)).toBeNull();
    expect(await code(invoicing.issueCreditNote(stranger, invoice._id, { reasonCode: '1', all: true }, ctx('o-1-xxxxxxxx')))).toBe('NOT_FOUND');
    expect((await invoicing.listInvoices(stranger)).items).toHaveLength(0);
  });
});

describe('consulta', () => {
  it('lista con filtros y paginación, y marca el estado de acreditación', async () => {
    const invoicing = await setup({ provider: scriptedProvider(['accept', 'accept', 'reject']) });
    const a = (await invoicing.issueInvoice(tenant, invoiceInput(), ctx('l-1-xxxxxxxx'))).invoice;
    await invoicing.issueInvoice(tenant, invoiceInput(), ctx('l-2-xxxxxxxx'));
    await invoicing.issueInvoice(tenant, invoiceInput(), ctx('l-3-xxxxxxxx')); // rechazada
    await invoicing.issueCreditNote(tenant, a._id, { reasonCode: '3', lines: [{ lineIndex: 1, quantity: 500 }] }, ctx('l-4-xxxxxxxx'));

    const all = await invoicing.listInvoices(tenant);
    expect(all.items.map((i) => i.fullNumber)).toEqual(['FE3', 'FE2', 'FE1']);
    expect((await invoicing.listInvoices(tenant, { status: 'rejected' })).items.map((i) => i.fullNumber)).toEqual(['FE3']);
    expect((await invoicing.listInvoices(tenant, { customerId: String(customer._id), limit: 2 })).nextCursor).not.toBeNull();
    expect(all.items.find((i) => i.fullNumber === 'FE1').creditStatus).toBe('partial');
    expect((await invoicing.listCreditNotes(tenant, { invoiceId: String(a._id) })).items).toHaveLength(1);
    expect(await code(invoicing.listInvoices(tenant, { from: 'ayer' }))).toBe('VALIDATION');
  });
});
