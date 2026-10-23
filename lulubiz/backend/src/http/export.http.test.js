import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createExportService } from '../exporting/tenantExport.js';
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

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true } });
};

const call = (method, url, { cookie, body } = {}) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const parse = (res) => res.payload.split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function register(email, companyName) {
  const res = await call('POST', '/v1/auth/register', { body: { companyName, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));
  const { tenantId } = res.json();
  const base = `/v1/tenants/${tenantId}`;
  return { tenantId, cookie, base };
}

const addAccount = async (c, body) => expect((await call('POST', `${c.base}/accounts`, { cookie: c.cookie, body })).statusCode).toBe(201);

async function joinAs(c, email, role) {
  const other = await register(email, `Empresa de ${email}`);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie: other.cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return other.cookie;
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_export_http_test');
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

describe('exportación de los datos de una empresa', () => {
  it('entrega un archivo de líneas que empieza y termina con marcas, con los documentos y los miembros', async () => {
    const c = await register('ana@andina.co', 'Andina SAS');
    await addAccount(c, { code: '1', name: 'Activo', type: 'asset', postable: false });
    await addAccount(c, { code: '110505', name: 'Caja general', type: 'asset', parentCode: '1' });
    const res = await call('GET', `${c.base}/export`, { cookie: c.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="lulubiz-.*\.ndjson"/);
    expect(res.headers['cache-control']).toBe('no-store');

    const lines = parse(res);
    expect(lines[0]).toMatchObject({ type: 'start', format: 'lulubiz-export/1' });
    const end = lines.at(-1);
    expect(end.type).toBe('end');
    expect(end.counts).toMatchObject({ tenants: 1, memberships: 1, accounts: 2 });

    const docs = lines.filter((l) => l.collection);
    expect(docs.filter((l) => l.collection === 'accounts').map((l) => l.doc.code).sort()).toEqual(['1', '110505']);
    expect(docs.filter((l) => l.collection === 'accounts')).toHaveLength(end.counts.accounts);
    const member = docs.find((l) => l.collection === 'memberships').doc;
    expect(member).toMatchObject({ email: 'ana@andina.co', role: 'owner' });
    expect(docs.find((l) => l.collection === 'tenants').doc.name).toBe('Andina SAS');
  });

  it('nunca incluye credenciales, sesiones, tokens ni claves de API, ni datos de otras empresas', async () => {
    const c = await register('ana@andina.co', 'Andina SAS');
    const other = await register('luis@otra.co', 'Otra SAS');
    await addAccount(other, { code: '9', name: 'Cuenta ajena secreta', type: 'asset', postable: false });
    const key = await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: { name: 'Integración', scopes: ['accounts:read'] } });
    expect(key.statusCode).toBe(201);

    const res = await call('GET', `${c.base}/export`, { cookie: c.cookie });
    const text = res.payload;
    for (const secret of ['passwordHash', 'tokenHash', 'secretHash', 'mfaSecret', 'Cuenta ajena secreta', 'luis@otra.co']) expect(text).not.toContain(secret);
    const names = new Set(parse(res).filter((l) => l.collection).map((l) => l.collection));
    for (const hidden of ['users', 'sessions', 'tokens', 'apiKeys']) expect(names.has(hidden)).toBe(false);
  });

  it('solo la pide el propietario, y queda en la auditoría', async () => {
    const c = await register('ana@andina.co', 'Andina SAS');
    const admin = await joinAs(c, 'admin@andina.co', 'admin');
    const accountant = await joinAs(c, 'conta@andina.co', 'accountant');
    expect((await call('GET', `${c.base}/export`)).statusCode).toBe(401);
    expect((await call('GET', `${c.base}/export`, { cookie: admin })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/export`, { cookie: accountant })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/export`, { cookie: c.cookie })).statusCode).toBe(200);
    const audit = (await call('GET', `${c.base}/audit`, { cookie: c.cookie })).json().items;
    expect(audit.filter((e) => e.action === 'tenant.export')).toHaveLength(1);
  });

  it('una clave de API no puede exportar', async () => {
    const c = await register('ana@andina.co', 'Andina SAS');
    const created = await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: { name: 'Lectura', scopes: ['accounts:read'] } });
    const token = created.json().token;
    const res = await app.inject({ method: 'GET', url: `${c.base}/export`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('servicio de exportación', () => {
  it('permite una exportación a la vez por empresa y libera al cerrarse', async () => {
    const service = createExportService({ db });
    const tenantId = (await register('ana@andina.co', 'Andina SAS')).tenantId;
    const other = (await register('luis@otra.co', 'Otra SAS')).tenantId;
    const { release } = service.start(tenantId);
    expect(() => service.start(tenantId)).toThrowError(/en curso/);
    expect(() => service.start(other)).not.toThrow();
    release();
    release();
    expect(() => service.start(tenantId)).not.toThrow();
  });

  it('cada colección está o exportada o excluida a propósito', () => {
    const service = createExportService({ db });
    expect([...service.collections(), ...service.excluded()].sort()).toEqual(Object.values(COLLECTIONS).sort());
  });
});
