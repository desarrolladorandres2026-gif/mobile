import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GRANTABLE_SCOPES, MAX_ACTIVE_KEYS, createApiKeyService } from '../auth/apiKeys.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const TOKEN = /^lbk_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/;

let mongo;
let db;
let app;
let mailer;
let clock;

const makeApp = () => {
  const config = loadConfig({});
  config.mfaEncryptionKey = Buffer.alloc(32, 5).toString('base64');
  config.rateLimit = Object.fromEntries(Object.entries(config.rateLimit).map(([k, v]) => [k, { ...v, max: 10_000 }]));
  return buildApp({ client: mongo.client, db, config, passwordParams: FAST, mailer, reporter: { report: async () => true }, now: () => clock });
};

const call = (method, url, { cookie, bearer, body, headers = {} } = {}) =>
  app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    ...(body !== undefined ? { payload: body } : {}),
  });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email) => cookieOf(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }));

async function company(name = 'Andina SAS', email = 'ana@andina.co') {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: name, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD } });
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(204);
  const cookie = await login(email);
  const base = `/v1/tenants/${reg.json().tenantId}`;
  const make = (body) => call('POST', `${base}/accounts`, { cookie, body });
  await make({ code: '1', name: 'Activo', type: 'asset', postable: false });
  await make({ code: '143505', name: 'Mercancías', type: 'asset', parentCode: '1' });
  await make({ code: '6', name: 'Costos', type: 'cost', postable: false });
  await make({ code: '613505', name: 'Costo de ventas', type: 'cost', parentCode: '6' });
  return { cookie, base, tenantId: reg.json().tenantId };
}

async function joinAs(c, email, role) {
  await call('POST', '/v1/auth/register', { body: { companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: 'X', email, password: PASSWORD } });
  const cookie = await login(email);
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email, role } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } })).statusCode).toBe(201);
  return cookie;
}

const newKey = async (c, patch = {}) => {
  const res = await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: { name: 'Integración contable', scopes: ['inventory:read', 'inventory:manage'], ...patch } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const item = { sku: 'tornillo-1', name: 'Tornillo', type: 'goods', inventoryAccount: '143505', cogsAccount: '613505' };

beforeAll(async () => {
  mongo = await startMongo('lulubiz_apikeys_http_test');
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
  clock = new Date();
  app = await makeApp();
});

describe('claves de API: creación', () => {
  it('muestra el token una sola vez y no guarda el secreto', async () => {
    const c = await company();
    const { token, apiKey } = await newKey(c);
    expect(token).toMatch(TOKEN);
    expect(token.startsWith(`lbk_${apiKey.prefix}_`)).toBe(true);
    expect(apiKey).toMatchObject({ name: 'Integración contable', scopes: ['inventory:read', 'inventory:manage'] });
    expect(JSON.stringify(apiKey)).not.toContain(token.split('_').slice(2).join('_'));

    const listed = (await call('GET', `${c.base}/api-keys`, { cookie: c.cookie })).json().items;
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(['_id', 'createdAt', 'createdBy', 'name', 'prefix', 'scopes']);

    const stored = await db.collection(COLLECTIONS.apiKeys).findOne({ prefix: apiKey.prefix });
    const secret = token.slice(`lbk_${apiKey.prefix}_`.length);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.secretHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ofrece solo permisos que se pueden dar y nunca los de administración', async () => {
    const c = await company();
    const scopes = (await call('GET', `${c.base}/api-keys/scopes`, { cookie: c.cookie })).json().scopes;
    expect(scopes).toEqual(GRANTABLE_SCOPES);
    for (const forbidden of ['tenant:manage', 'users:manage', 'apikeys:manage', 'periods:reopen', 'settings:manage']) expect(scopes).not.toContain(forbidden);
    expect(scopes).toContain('invoices:issue');
  });

  it('valida nombre, permisos y vencimiento', async () => {
    const c = await company();
    const post = (body) => call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body });
    expect((await post({ name: '', scopes: ['inventory:read'] })).statusCode).toBe(400);
    expect((await post({ name: 'x', scopes: [] })).statusCode).toBe(400);
    expect((await post({ name: 'x' })).statusCode).toBe(400);
    expect((await post({ name: 'x', scopes: ['inventory:read'], extra: 1 })).statusCode).toBe(400);
    for (const scope of ['users:manage', 'apikeys:manage', 'tenant:manage', 'periods:reopen', 'settings:manage', 'inexistente:read']) {
      const res = await post({ name: 'x', scopes: [scope] });
      expect(res.statusCode, scope).toBe(400);
    }
    expect((await post({ name: 'x', scopes: ['inventory:read'], expiresAt: '2000-01-01' })).statusCode).toBe(400);
    expect((await post({ name: 'x', scopes: ['inventory:read'], expiresAt: '2999-13-40' })).statusCode).toBe(400);
    expect((await post({ name: 'x', scopes: ['inventory:read'], expiresAt: '2999-01-01' })).statusCode).toBe(201);
  });

  it('limita las claves activas por empresa, y revocar libera cupo', async () => {
    const c = await company();
    const first = await newKey(c, { name: 'k0' });
    for (let i = 1; i < MAX_ACTIVE_KEYS; i += 1) await newKey(c, { name: `k${i}` });
    const over = await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: { name: 'una más', scopes: ['inventory:read'] } });
    expect(over.statusCode).toBe(409);
    await call('POST', `${c.base}/api-keys/${first.apiKey._id}/revoke`, { cookie: c.cookie });
    expect((await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: { name: 'cabe', scopes: ['inventory:read'] } })).statusCode).toBe(201);
  });

  it('solo propietario y administrador administran claves; sin sesión nada', async () => {
    const c = await company();
    const accountant = await joinAs(c, 'contador@andina.co', 'accountant');
    const admin = await joinAs(c, 'admin@andina.co', 'admin');
    const body = { name: 'x', scopes: ['inventory:read'] };
    expect((await call('POST', `${c.base}/api-keys`, { cookie: accountant, body })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/api-keys`, { cookie: accountant })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/api-keys`, { cookie: admin, body })).statusCode).toBe(201);
    expect((await call('POST', `${c.base}/api-keys`, { body })).statusCode).toBe(401);
    expect((await call('GET', `${c.base}/api-keys`)).statusCode).toBe(401);
  });
});

describe('claves de API: uso', () => {
  it('con la clave se llama a la API sin cookie, y cada ruta sigue pidiendo su permiso', async () => {
    const c = await company();
    const { token } = await newKey(c);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    const created = await call('POST', `${c.base}/items`, { bearer: token, body: item });
    expect(created.statusCode, created.body).toBe(201);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).json().items).toHaveLength(1);

    // Sin el permiso de la ruta: 403.
    expect((await call('GET', `${c.base}/invoices`, { bearer: token })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/journals`, { bearer: token })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/stock/adjustments`, { bearer: token, headers: { 'idempotency-key': 'k-adj-aaaaaaaa' }, body: {} })).statusCode).toBe(403);
  });

  it('una clave de solo lectura no escribe', async () => {
    const c = await company();
    const { token } = await newKey(c, { scopes: ['inventory:read'] });
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/items`, { bearer: token, body: item })).statusCode).toBe(403);
  });

  it('nunca administra empresa, miembros ni claves, aunque se intente', async () => {
    const c = await company();
    const { token } = await newKey(c);
    expect((await call('GET', `${c.base}/members`, { bearer: token })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/members`, { bearer: token, body: { email: 'x@y.co', role: 'owner' } })).statusCode).toBe(403);
    expect((await call('GET', `${c.base}/api-keys`, { bearer: token })).statusCode).toBe(403);
    expect((await call('POST', `${c.base}/api-keys`, { bearer: token, body: { name: 'otra', scopes: ['inventory:read'] } })).statusCode).toBe(403);
    expect((await call('PUT', `${c.base}/invoicing/settings`, { bearer: token, body: {} })).statusCode).toBe(403);
    // Las rutas de sesión no admiten claves.
    expect((await call('GET', '/v1/me', { bearer: token })).statusCode).toBe(401);
  });

  it('no sirve en otra empresa, y responde igual que una clave inexistente', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const { token } = await newKey(a);
    const other = await call('GET', `${b.base}/items`, { bearer: token });
    expect(other.statusCode).toBe(401);
    const unknown = await call('GET', `${a.base}/items`, { bearer: 'lbk_00000000_' + 'A'.repeat(43) });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(other.json());
  });

  it('rechaza secreto equivocado, formato roto y cabeceras que no son de clave', async () => {
    const c = await company();
    const { token, apiKey } = await newKey(c);
    const wrong = `lbk_${apiKey.prefix}_${'B'.repeat(43)}`;
    for (const bad of [wrong, 'lbk_xyz', `${token}x`, token.slice(0, -1), 'abc']) {
      const res = await call('GET', `${c.base}/items`, { bearer: bad });
      expect(res.statusCode, bad).toBe(401);
      expect(res.json().error).toBe('INVALID_CREDENTIALS');
    }
    const basic = await call('GET', `${c.base}/items`, { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(basic.statusCode).toBe(401); // sin sesión
  });

  it('una clave revocada deja de servir de inmediato, y revocar dos veces no cambia nada', async () => {
    const c = await company();
    const { token, apiKey } = await newKey(c);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    const revoked = await call('POST', `${c.base}/api-keys/${apiKey._id}/revoke`, { cookie: c.cookie });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().apiKey.revokedAt).toBeDefined();
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(401);
    const again = await call('POST', `${c.base}/api-keys/${apiKey._id}/revoke`, { cookie: c.cookie });
    expect(again.statusCode).toBe(200);
    expect(again.json().apiKey.revokedAt).toBe(revoked.json().apiKey.revokedAt);
    expect((await call('POST', `${c.base}/api-keys/${'a'.repeat(24)}/revoke`, { cookie: c.cookie })).statusCode).toBe(404);
  });

  it('una empresa no revoca las claves de otra', async () => {
    const a = await company('Andina SAS', 'ana@andina.co');
    const b = await company('Boreal SAS', 'bea@boreal.co');
    const { token, apiKey } = await newKey(a);
    expect((await call('POST', `${b.base}/api-keys/${apiKey._id}/revoke`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${b.base}/api-keys`, { cookie: b.cookie })).json().items).toHaveLength(0);
    expect((await call('GET', `${a.base}/items`, { bearer: token })).statusCode).toBe(200);
  });

  it('vence al final de su día de vencimiento', async () => {
    const c = await company();
    const day = new Date(clock.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const { token } = await newKey(c, { expiresAt: day });
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    clock = new Date(`${day}T23:00:00Z`);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    clock = new Date(`${day}T23:59:59Z`);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(200);
    clock = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000 + 1000);
    expect((await call('GET', `${c.base}/items`, { bearer: token })).statusCode).toBe(401);
  });

  it('marca el último uso, sin escribir en cada petición', async () => {
    const c = await company();
    const { token, apiKey } = await newKey(c);
    expect((await call('GET', `${c.base}/api-keys`, { cookie: c.cookie })).json().items[0].lastUsedAt).toBeUndefined();
    await call('GET', `${c.base}/items`, { bearer: token });
    const first = (await db.collection(COLLECTIONS.apiKeys).findOne({ prefix: apiKey.prefix })).lastUsedAt;
    expect(first).toBeInstanceOf(Date);
    clock = new Date(clock.getTime() + 60_000);
    await call('GET', `${c.base}/items`, { bearer: token });
    expect((await db.collection(COLLECTIONS.apiKeys).findOne({ prefix: apiKey.prefix })).lastUsedAt).toEqual(first);
    clock = new Date(clock.getTime() + 10 * 60_000);
    await call('GET', `${c.base}/items`, { bearer: token });
    expect((await db.collection(COLLECTIONS.apiKeys).findOne({ prefix: apiKey.prefix })).lastUsedAt.getTime()).toBeGreaterThan(first.getTime());
  });

  it('desde un navegador, la clave no está sujeta al origen; la sesión por cookie sí', async () => {
    const c = await company();
    const { token } = await newKey(c);
    const evil = { origin: 'https://sitio-ajeno.example' };
    expect((await call('POST', `${c.base}/items`, { bearer: token, headers: evil, body: item })).statusCode).toBe(201);
    const withCookie = await call('POST', `${c.base}/items`, { cookie: c.cookie, headers: evil, body: { ...item, sku: 'otro' } });
    expect(withCookie.statusCode).toBe(403);
    expect(withCookie.json().error).toBe('FORBIDDEN_ORIGIN');
  });
});

describe('claves de API: auditoría', () => {
  it('lo que hace una clave queda a nombre de la clave, y crear y revocar también se audita', async () => {
    const c = await company();
    const { token, apiKey } = await newKey(c);
    await call('POST', `${c.base}/items`, { bearer: token, body: item });
    await call('POST', `${c.base}/api-keys/${apiKey._id}/revoke`, { cookie: c.cookie });
    const events = (await call('GET', `${c.base}/audit?limit=50`, { cookie: c.cookie })).json().items;
    const byAction = (action) => events.find((e) => e.action === action);
    expect(byAction('apikey.create')).toMatchObject({ target: apiKey._id, details: { name: 'Integración contable', prefix: apiKey.prefix } });
    expect(byAction('apikey.create').apiKeyId).toBeUndefined();
    expect(byAction('apikey.create').userId).toBeTruthy();
    expect(byAction('item.create')).toMatchObject({ userId: null, apiKeyId: apiKey._id });
    expect(byAction('apikey.revoke')).toMatchObject({ target: apiKey._id });
  });
});

describe('claves de API: servicio', () => {
  it('no deja dar a una clave más permisos de los que tiene quien la crea', async () => {
    const service = createApiKeyService({ client: mongo.client, db });
    const err = await service.create({ tenantId: 'x', userId: null, role: 'viewer' }, { name: 'x', scopes: ['journals:post'] }).catch((e) => e);
    expect(err.code).toBe('FORBIDDEN');
  });
});
