import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const NEW_PASSWORD = 'otra-contrasena-larga-y-nueva';
const MINUTE = 60_000;

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

const call = (method, url, { cookie, body } = {}) => app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body } : {}) });
const cookieOf = (res) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/#token=([^\s]+)/)[1]);
const login = async (email, password = PASSWORD) => {
  const res = await call('POST', '/v1/auth/login', { body: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
};
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};

async function company() {
  const reg = await call('POST', '/v1/auth/register', { body: { companyName: 'Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Ana', email: 'ana@andina.co', password: PASSWORD } });
  expect(reg.statusCode, reg.body).toBe(201);
  expect((await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last('ana@andina.co')) } })).statusCode).toBe(204);
  return { base: `/v1/tenants/${reg.json().tenantId}`, tenantId: reg.json().tenantId, userId: reg.json().userId, cookie: await login('ana@andina.co') };
}

async function addAdmin(c) {
  await call('POST', '/v1/auth/register', { body: { companyName: 'Otra', country: 'CO', currency: 'COP', ownerName: 'Beto', email: 'beto@andina.co', password: PASSWORD } });
  const cookie = await login('beto@andina.co');
  expect((await call('POST', `${c.base}/members`, { cookie: c.cookie, body: { email: 'beto@andina.co', role: 'admin' } })).statusCode).toBe(202);
  expect((await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last('beto@andina.co')) } })).statusCode).toBe(201);
  const members = (await call('GET', `${c.base}/members`, { cookie: c.cookie })).json().items;
  return { cookie, userId: members.find((m) => m.email === 'beto@andina.co').userId };
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_session_http_test');
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
  // Fecha lejana: el índice TTL real de MongoDB no toca las sesiones de la prueba.
  clock = new Date('2030-01-01T10:00:00Z');
  app = await makeApp();
});

describe('confirmación reciente para operaciones delicadas', () => {
  it('exportar, crear claves de API, cambiar roles y quitar miembros piden confirmar la contraseña pasado el plazo', async () => {
    const c = await company();
    const beto = await addAdmin(c);
    const key = { name: 'Integración', scopes: ['journals:read'] };
    // Recién iniciada la sesión, todo pasa.
    expect((await call('GET', `${c.base}/export`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: key })).statusCode).toBe(201);

    advance(11 * MINUTE);
    const blocked = [
      await call('GET', `${c.base}/export`, { cookie: c.cookie }),
      await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: key }),
      await call('PATCH', `${c.base}/members/${beto.userId}`, { cookie: c.cookie, body: { role: 'viewer' } }),
      await call('DELETE', `${c.base}/members/${beto.userId}`, { cookie: c.cookie }),
    ];
    for (const res of blocked) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe('STEP_UP_REQUIRED');
    }
    // Lo demás sigue funcionando sin confirmar.
    expect((await call('GET', `${c.base}/members`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('GET', `${c.base}/api-keys`, { cookie: c.cookie })).statusCode).toBe(200);

    const wrong = await call('POST', '/v1/auth/step-up', { cookie: c.cookie, body: { password: 'incorrecta-incorrecta' } });
    expect(wrong.statusCode).toBe(401);
    expect((await call('POST', `${c.base}/api-keys`, { cookie: c.cookie, body: key })).statusCode).toBe(403);

    const ok = await call('POST', '/v1/auth/step-up', { cookie: c.cookie, body: { password: PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(new Date(ok.json().validUntil).getTime()).toBe(clock.getTime() + 10 * MINUTE);
    expect((await call('GET', `${c.base}/export`, { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('PATCH', `${c.base}/members/${beto.userId}`, { cookie: c.cookie, body: { role: 'viewer' } })).statusCode).toBe(204);
    expect((await call('DELETE', `${c.base}/members/${beto.userId}`, { cookie: c.cookie })).statusCode).toBe(204);
    const audit = await db.collection(COLLECTIONS.audit).find({ tenantId: null, action: 'auth.step_up' }).toArray();
    expect(audit).toHaveLength(1);
  });

  it('degradar o quitar a quien creó una clave la revoca, y queda en la auditoría', async () => {
    const c = await company();
    const beto = await addAdmin(c);
    const created = await call('POST', `${c.base}/api-keys`, { cookie: beto.cookie, body: { name: 'de Beto', scopes: ['journals:post', 'journals:read'] } });
    expect(created.statusCode, created.body).toBe(201);
    const { token } = created.json();
    const use = () => app.inject({ method: 'GET', url: `${c.base}/journals`, headers: { authorization: `Bearer ${token}` } });
    expect((await use()).statusCode).toBe(200);
    expect((await call('PATCH', `${c.base}/members/${beto.userId}`, { cookie: c.cookie, body: { role: 'viewer' } })).statusCode).toBe(204);
    expect((await use()).statusCode).toBe(401); // revocada
    expect((await db.collection(COLLECTIONS.audit).findOne({ action: 'member.change_role' })).details.revokedApiKeys).toBe(1);
  });
});

describe('sesiones abiertas y contraseña', () => {
  it('lista las sesiones, cierra otra y la actual limpia la cookie', async () => {
    const c = await company();
    const second = await login('ana@andina.co');
    const list = (await call('GET', '/v1/auth/sessions', { cookie: c.cookie })).json().items;
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/tokenHash/);
    expect((await call('GET', '/v1/auth/sessions')).statusCode).toBe(401);

    const other = list.find((s) => !s.current);
    expect((await call('DELETE', `/v1/auth/sessions/${other.id}`, { cookie: c.cookie })).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', { cookie: second })).statusCode).toBe(401);
    expect((await call('DELETE', `/v1/auth/sessions/${other.id}`, { cookie: c.cookie })).statusCode).toBe(404);
    expect((await call('DELETE', '/v1/auth/sessions/xyz', { cookie: c.cookie })).statusCode).toBe(400);

    const self = (await call('GET', '/v1/auth/sessions', { cookie: c.cookie })).json().items[0];
    const closed = await call('DELETE', `/v1/auth/sessions/${self.id}`, { cookie: c.cookie });
    expect(closed.statusCode).toBe(204);
    expect(closed.cookies[0].value).toBe('');
    expect((await call('GET', '/v1/me', { cookie: c.cookie })).statusCode).toBe(401);
  });

  it('cambiar la contraseña cierra las demás sesiones; con logoutAll, también esta', async () => {
    const c = await company();
    const second = await login('ana@andina.co');
    const bad = await call('POST', '/v1/auth/password/change', { cookie: c.cookie, body: { currentPassword: 'incorrecta-incorrecta', newPassword: NEW_PASSWORD } });
    expect(bad.statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/password/change', { cookie: c.cookie, body: { currentPassword: PASSWORD, newPassword: 'corta' } })).statusCode).toBe(400);
    const done = await call('POST', '/v1/auth/password/change', { cookie: c.cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(done.statusCode, done.body).toBe(204);
    expect((await call('GET', '/v1/me', { cookie: c.cookie })).statusCode).toBe(200);
    expect((await call('GET', '/v1/me', { cookie: second })).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/login', { body: { email: 'ana@andina.co', password: PASSWORD } })).statusCode).toBe(401);

    const fresh = await login('ana@andina.co', NEW_PASSWORD);
    const all = await call('POST', '/v1/auth/password/change', { cookie: fresh, body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD, logoutAll: true } });
    expect(all.statusCode, all.body).toBe(204);
    expect((await call('GET', '/v1/me', { cookie: fresh })).statusCode).toBe(401);
    expect((await call('GET', '/v1/me', { cookie: c.cookie })).statusCode).toBe(401);
    const events = await db.collection(COLLECTIONS.audit).find({ action: 'auth.password_changed' }).toArray();
    expect(events).toHaveLength(2);
  });
});
