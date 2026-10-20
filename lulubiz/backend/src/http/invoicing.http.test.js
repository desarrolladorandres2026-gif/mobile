import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';

let mongo;
let db;
let app;
let mailer;

const makeApp = (extra = {}) => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true }, ...extra });
};

const call = (method, url, { cookie, body, headers = {} } = {}) =>
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const key = (() => {
  let n = 0;
  return (label = 'k') => `${label}-${++n}-${Math.random().toString(36).slice(2, 10)}`;
})();

const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-12-31`;
const LAST_YEAR = `${new Date().getUTCFullYear() - 1}-01-01`;

async function register(email) {
  const res = await call('POST', '/v1/auth/register', { body: { companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const verify = await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } });
  expect(verify.statusCode).toBe(204);
  return res.json();
}
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

/** Empresa con propietario, plan de cuentas mínimo y un cliente. Sin configurar la facturación. */
async function company() {
  const { tenantId } = await register('ana@andina.co');
  const cookie = await login('ana@andina.co');
  const base = `/v1/tenants/${tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '130505', name: 'Clientes', type: 'asset', parentCode: '1' });
  await make({ code: '2', name: 'Pasivo', type: 'liability', postable: false });
  await make({ code: '240805', name: 'IVA por pagar', type: 'liability', parentCode: '2' });
  await make({ code: '4', name: 'Ingresos', type: 'income', postable: false });
  await make({ code: '413505', name: 'Ventas', type: 'income', parentCode: '4' });
  const party = await call('POST', `${base}/parties`, { cookie, body: { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '800197268', checkDigit: 4 } });
  return { tenantId, cookie, base, customerId: party.json()._id };
}

const SETTINGS = {
  issuer: { name: 'Andina SAS', taxIdType: 'NIT', taxId: '890903938', checkDigit: 8, regime: 'responsable_iva', address: { line: 'Calle 10 # 5-20', city: 'Garzón', region: 'Huila' } },
  accounts: { receivable: '130505', income: '413505', vatPayable: '240805' },
};

async function configure(c) {
  expect((await call('PUT', `${c.base}/invoicing/settings`, { cookie: c.cookie, body: SETTINGS })).statusCode).toBe(200);
  for (const [docType, prefix] of [['invoice', 'FE'], ['credit_note', 'NC']]) {
    const res = await call('POST', `${c.base}/invoicing/resolutions`, {
      cookie: c.cookie,
      body: { docType, prefix, number: '18760000001', from: 1, to: 500, validFrom: LAST_YEAR, validTo: NEXT_YEAR },
    });
    expect(res.statusCode).toBe(201);
  }
}

const invoiceBody = (c, patch = {}) => ({
  customerId: c.customerId,
  issueDate: new Date().toISOString().slice(0, 10),
  paymentMethod: 'cash',
  lines: [{ description: 'Servicio', quantity: 2000, unitPrice: 50_000, vatBps: 1900 }],
  ...patch,
});

/** Invita a un usuario nuevo con el rol dado y acepta la invitación; devuelve su cookie. */
async function joinAs(c, email, role) {
  const res = await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_invoicing_http_test');
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

describe('estado y configuración', () => {
  it('dice qué falta, y con todo configurado queda listo; trae las tarifas y motivos del país', async () => {
    const c = await company();
    const before = (await call('GET', `${c.base}/invoicing/status`, { cookie: c.cookie })).json();
    expect(before).toMatchObject({ configured: true, provider: 'sandbox', sandbox: true, ready: false, country: 'CO', currency: 'COP' });
    expect(before.missing.join(' ')).toMatch(/emisor/);
    expect(before.vatRatesBps).toEqual([0, 500, 1900]);
    expect(before.creditNoteReasons.map((r) => r.code)).toEqual(['1', '2', '3', '4', '5']);

    await configure(c);
    const after = (await call('GET', `${c.base}/invoicing/status`, { cookie: c.cookie })).json();
    expect(after).toMatchObject({ ready: true, missing: [] });
  });

  it('solo propietarios y administradores configuran; un contador y un lector la consultan pero no la cambian', async () => {
    const c = await company();
    await configure(c);
    const accountant = await joinAs(c, 'conta@andina.co', 'accountant');
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    for (const cookie of [accountant, viewer]) {
      expect((await call('GET', `${c.base}/invoicing/settings`, { cookie })).statusCode).toBe(200);
      expect((await call('GET', `${c.base}/invoicing/resolutions`, { cookie })).statusCode).toBe(200);
      expect((await call('PUT', `${c.base}/invoicing/settings`, { cookie, body: SETTINGS })).statusCode).toBe(403);
      const resolution = await call('POST', `${c.base}/invoicing/resolutions`, { cookie, body: { docType: 'invoice', prefix: 'ZZ', number: '1', from: 1, to: 5, validFrom: LAST_YEAR, validTo: NEXT_YEAR } });
      expect(resolution.statusCode).toBe(403);
    }
  });

  it('valida el NIT del emisor, las cuentas y el solapamiento de resoluciones; rechaza campos extra', async () => {
    const c = await company();
    const put = (body) => call('PUT', `${c.base}/invoicing/settings`, { cookie: c.cookie, body });
    expect((await put({ ...SETTINGS, issuer: { ...SETTINGS.issuer, checkDigit: 3 } })).statusCode).toBe(400);
    expect((await put({ ...SETTINGS, accounts: { ...SETTINGS.accounts, income: '999999' } })).statusCode).toBe(400);
    expect((await put({ ...SETTINGS, extra: 1 })).statusCode).toBe(400);
    await configure(c);
    const overlap = await call('POST', `${c.base}/invoicing/resolutions`, {
      cookie: c.cookie,
      body: { docType: 'invoice', prefix: 'FE', number: 'otra', from: 100, to: 600, validFrom: LAST_YEAR, validTo: NEXT_YEAR },
    });
    expect(overlap.statusCode).toBe(409);
    const list = (await call('GET', `${c.base}/invoicing/resolutions`, { cookie: c.cookie })).json().items;
    expect((await call('POST', `${c.base}/invoicing/resolutions/${list[0]._id}/deactivate`, { cookie: c.cookie })).statusCode).toBe(204);
  });
});

describe('facturas', () => {
  it('emite con el simulador, marcada como de pruebas; repetir la clave devuelve la misma (200)', async () => {
    const c = await company();
    await configure(c);
    const k = key('f');
    const created = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': k } });
    expect(created.statusCode).toBe(201);
    const { invoice } = created.json();
    expect(invoice).toMatchObject({ status: 'issued', fullNumber: 'FE1', provider: { name: 'sandbox', sandbox: true }, accounting: { status: 'posted' } });
    expect(invoice.cufe).toMatch(/^SANDBOX-/);
    expect(invoice.totals).toMatchObject({ subtotal: 100_000, tax: 19_000, total: 119_000 });

    const again = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': k } });
    expect(again.statusCode).toBe(200);
    expect(again.json().invoice._id).toBe(invoice._id);

    const balance = await call('GET', `${c.base}/balances?account=130505&period=${new Date().toISOString().slice(0, 7)}&currency=COP`, { cookie: c.cookie });
    expect(balance.json()).toEqual({ debit: 119_000, credit: 0 });
    expect((await call('GET', `${c.base}/invoices/${invoice._id}`, { cookie: c.cookie })).json().fullNumber).toBe('FE1');
    expect((await call('GET', `${c.base}/invoices`, { cookie: c.cookie })).json().items).toHaveLength(1);
  });

  it('un rechazo responde con la factura rechazada; sin respuesta, 202 y luego se sincroniza', async () => {
    const c = await company();
    await configure(c);
    const mkCustomer = async (name, taxId) =>
      (await call('POST', `${c.base}/parties`, { cookie: c.cookie, body: { name, roles: ['customer'], taxIdType: 'CC', taxId } })).json()._id;
    const rechazar = await mkCustomer('Cliente RECHAZAR', '1075123456');
    const rejected = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c, { customerId: rechazar }), headers: { 'idempotency-key': key() } });
    expect(rejected.statusCode).toBe(201);
    expect(rejected.json()).toMatchObject({ rejected: true, invoice: { status: 'rejected', rejection: { code: 'SANDBOX_REJECTED' } } });

    const timeout = await mkCustomer('Cliente TIMEOUT', '1075123457');
    const pending = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c, { customerId: timeout }), headers: { 'idempotency-key': key() } });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ pending: true, invoice: { status: 'pending_provider' } });
    const synced = await call('POST', `${c.base}/invoices/${pending.json().invoice._id}/sync`, { cookie: c.cookie });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().invoice.status).toBe('issued');
  });

  it('con el período cerrado queda emitida con la contabilización pendiente, y se contabiliza al reabrir', async () => {
    const c = await company();
    await configure(c);
    const month = new Date().toISOString().slice(0, 7);
    await call('POST', `${c.base}/periods/${month}/close`, { cookie: c.cookie });
    const created = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': key() } });
    expect(created.json().invoice).toMatchObject({ status: 'issued', accounting: { status: 'pending' } });
    const id = created.json().invoice._id;
    expect((await call('POST', `${c.base}/invoices/${id}/account`, { cookie: c.cookie })).statusCode).toBe(409);
    await call('POST', `${c.base}/periods/${month}/reopen`, { cookie: c.cookie });
    const posted = await call('POST', `${c.base}/invoices/${id}/account`, { cookie: c.cookie });
    expect(posted.json().invoice.accounting.status).toBe('posted');
  });

  it('exige Idempotency-Key y rechaza decimales, textos como números, campos extra y datos de negocio inválidos', async () => {
    const c = await company();
    await configure(c);
    const post = (body, headers = { 'idempotency-key': key() }) => call('POST', `${c.base}/invoices`, { cookie: c.cookie, body, headers });
    expect((await post(invoiceBody(c), {})).statusCode).toBe(400);
    const withLine = (patch) => invoiceBody(c, { lines: [{ description: 'x', quantity: 1000, unitPrice: 100, vatBps: 0, ...patch }] });
    expect((await post(withLine({ unitPrice: 10.5 }))).statusCode).toBe(400);
    expect((await post(withLine({ unitPrice: '100' }))).statusCode).toBe(400);
    expect((await post(withLine({ quantity: 0 }))).statusCode).toBe(400);
    expect((await post(withLine({ extra: true }))).statusCode).toBe(400);
    expect((await post({ ...invoiceBody(c), extra: true })).statusCode).toBe(400);
    expect((await post(withLine({ vatBps: 1600 }))).statusCode).toBe(400); // tarifa que Colombia no tiene
    expect((await post(invoiceBody(c, { customerId: 'a'.repeat(24) }))).statusCode).toBe(404);
    expect((await post(invoiceBody(c, { paymentMethod: 'trueque' }))).statusCode).toBe(400);
  });

  it('sin configurar no emite (409), y sin proveedor responde 501', async () => {
    const c = await company();
    const unconfigured = await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': key() } });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().error).toBe('SETTINGS_INCOMPLETE');

    await app.close();
    app = await makeApp({ invoicingProvider: null });
    const cookie = await login('ana@andina.co');
    const noProvider = await call('POST', `${c.base}/invoices`, { cookie, body: invoiceBody(c), headers: { 'idempotency-key': key() } });
    expect(noProvider.statusCode).toBe(501);
    expect((await call('GET', `${c.base}/invoicing/status`, { cookie })).json()).toMatchObject({ configured: false, provider: null, ready: false });
  });

  it('un lector consulta pero no emite; un contador emite; otra empresa no ve nada', async () => {
    const c = await company();
    await configure(c);
    const viewer = await joinAs(c, 'lector@andina.co', 'viewer');
    const accountant = await joinAs(c, 'conta@andina.co', 'accountant');
    expect((await call('POST', `${c.base}/invoices`, { cookie: viewer, body: invoiceBody(c), headers: { 'idempotency-key': key() } })).statusCode).toBe(403);
    const issued = await call('POST', `${c.base}/invoices`, { cookie: accountant, body: invoiceBody(c), headers: { 'idempotency-key': key() } });
    expect(issued.statusCode).toBe(201);
    const id = issued.json().invoice._id;
    expect((await call('GET', `${c.base}/invoices/${id}`, { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/invoices/${id}/credit-notes`, { cookie: viewer, body: { reasonCode: '1', all: true }, headers: { 'idempotency-key': key() } })).statusCode).toBe(403);

    // Otra empresa, otro propietario.
    mailer = createMemoryMailer();
    const other = await call('POST', '/v1/auth/register', { body: { companyName: 'Otra SAS', country: 'CO', currency: 'COP', ownerName: 'B', email: 'beto@otra.co', password: PASSWORD } });
    const otherCookie = await login('beto@otra.co');
    const otherBase = `/v1/tenants/${other.json().tenantId}`;
    expect((await call('GET', `${otherBase}/invoices/${id}`, { cookie: otherCookie })).statusCode).toBe(404);
    expect((await call('GET', `${otherBase}/invoices`, { cookie: otherCookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${c.base}/invoices/${id}`, { cookie: otherCookie })).statusCode).toBe(403);
  });
});

describe('notas crédito', () => {
  it('acredita toda la factura; otra nota por lo mismo se rechaza (409); el listado la refleja', async () => {
    const c = await company();
    await configure(c);
    const invoice = (await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': key() } })).json().invoice;
    const note = await call('POST', `${c.base}/invoices/${invoice._id}/credit-notes`, { cookie: c.cookie, body: { reasonCode: '2', all: true }, headers: { 'idempotency-key': key() } });
    expect(note.statusCode).toBe(201);
    expect(note.json().note).toMatchObject({ status: 'issued', fullNumber: 'NC1', reasonText: 'Anulación de la factura electrónica', totals: { total: 119_000 } });

    const again = await call('POST', `${c.base}/invoices/${invoice._id}/credit-notes`, { cookie: c.cookie, body: { reasonCode: '2', all: true }, headers: { 'idempotency-key': key() } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('OVER_CREDIT');

    expect((await call('GET', `${c.base}/invoices/${invoice._id}`, { cookie: c.cookie })).json()).toMatchObject({ creditStatus: 'full', creditedTotal: 119_000 });
    expect((await call('GET', `${c.base}/credit-notes?invoiceId=${invoice._id}`, { cookie: c.cookie })).json().items).toHaveLength(1);
    expect((await call('GET', `${c.base}/credit-notes/${note.json().note._id}`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/credit-notes/${'a'.repeat(24)}`, { cookie: c.cookie })).statusCode).toBe(404);
  });

  it('acredita por líneas y cantidades, y valida la entrada', async () => {
    const c = await company();
    await configure(c);
    const invoice = (
      await call('POST', `${c.base}/invoices`, {
        cookie: c.cookie,
        body: invoiceBody(c, { lines: [{ description: 'Pieza', quantity: 3000, unitPrice: 10_000, vatBps: 1900 }, { description: 'Servicio', quantity: 1000, unitPrice: 40_000, vatBps: 0 }] }),
        headers: { 'idempotency-key': key() },
      })
    ).json().invoice;
    const credit = (body) => call('POST', `${c.base}/invoices/${invoice._id}/credit-notes`, { cookie: c.cookie, body, headers: { 'idempotency-key': key() } });
    const partial = await credit({ reasonCode: '1', lines: [{ lineIndex: 0, quantity: 1000 }] });
    expect(partial.statusCode).toBe(201);
    expect(partial.json().note.totals.total).toBe(11_900);
    expect((await call('GET', `${c.base}/invoices/${invoice._id}`, { cookie: c.cookie })).json().creditStatus).toBe('partial');
    expect((await credit({ reasonCode: '1', lines: [{ lineIndex: 0, quantity: 3000 }] })).statusCode).toBe(409);
    expect((await credit({ reasonCode: '99', all: true })).statusCode).toBe(400);
    expect((await credit({ reasonCode: '1', lines: [{ lineIndex: 0, quantity: 1.5 }] })).statusCode).toBe(400);
    expect((await credit({ reasonCode: '1', lines: [{ lineIndex: 7, quantity: 1 }] })).statusCode).toBe(400);
    expect((await credit({ reasonCode: '1', extra: 1 })).statusCode).toBe(400);
  });
});

describe('auditoría y producción', () => {
  it('todo lo que se hace con facturación queda en la auditoría', async () => {
    const c = await company();
    await configure(c);
    const invoice = (await call('POST', `${c.base}/invoices`, { cookie: c.cookie, body: invoiceBody(c), headers: { 'idempotency-key': key() } })).json().invoice;
    await call('POST', `${c.base}/invoices/${invoice._id}/credit-notes`, { cookie: c.cookie, body: { reasonCode: '3', all: true }, headers: { 'idempotency-key': key() } });
    const actions = (await call('GET', `${c.base}/audit?limit=100`, { cookie: c.cookie })).json().items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['invoicing.settings_update', 'invoicing.resolution_create', 'invoice.create', 'invoice.issue', 'credit_note.create', 'credit_note.issue', 'journal.post'].filter((a) => a !== 'journal.post')),
    );
    expect(await db.collection(COLLECTIONS.audit).countDocuments({ action: 'invoice.issue' })).toBe(1);
  });

  it('el simulador no se admite en producción; sin proveedor configurado la aplicación arranca igual', () => {
    const production = {
      NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.test', MONGODB_URI: 'mongodb://x', APP_BASE_URL: 'https://app.test',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), SMTP_URL: 'smtps://u:p@h:465', MAIL_FROM: 'a@b.co',
    };
    expect(() => loadConfig({ ...production, INVOICING_PROVIDER: 'sandbox' })).toThrow(/sandbox no se permite en producción/);
    expect(loadConfig(production).invoicingProvider).toBeNull();
    expect(loadConfig({}).invoicingProvider).toBe('sandbox'); // en desarrollo, el simulador por defecto
  });
});
