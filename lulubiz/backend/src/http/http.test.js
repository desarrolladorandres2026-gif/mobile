import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totpAt } from '../auth/totp.js';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { statusFor } from './errors.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const NEW_PASSWORD = 'otra-clave-muy-larga-7';
const ORIGIN = 'http://localhost:3100';
const MFA_KEY = Buffer.alloc(32, 5).toString('base64');

let mongo;
let db;
let app;
let mailer;
let reports;

function configWith(rateOverrides = {}, overrides = {}) {
  const config = loadConfig({});
  config.mfaEncryptionKey = MFA_KEY;
  config.rateLimit = { ...config.rateLimit, global: { max: 10_000, timeWindow: '1 minute' }, ...rateOverrides };
  return { ...config, ...overrides };
}

const makeApp = (rateOverrides, overrides) =>
  buildApp({
    client: mongo.client,
    db,
    config: configWith(rateOverrides, overrides),
    passwordParams: FAST,
    mailer,
    reporter: { report: async (err, context) => { reports.push({ err, context }); return true; } },
  });

const call = (method, url, { cookie, body, headers = {} } = {}) =>
  app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { payload: body } : {}),
  });

const cookieOf = (res) => {
  const c = res.cookies.find((x) => x.name === 'lulubiz_session');
  return c ? `${c.name}=${c.value}` : null;
};
const tokenIn = (message) => decodeURIComponent(message.text.match(/#token=([^\s]+)/)[1]);

async function register(email, company = 'Empresa SAS') {
  const res = await call('POST', '/v1/auth/register', {
    body: { companyName: company, country: 'CO', currency: 'COP', ownerName: 'Ana', email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function verifyEmail(email) {
  const res = await call('POST', '/v1/auth/verify-email', { body: { token: tokenIn(mailer.last(email)) } });
  expect(res.statusCode).toBe(204);
}

async function login(email, password = PASSWORD) {
  const res = await call('POST', '/v1/auth/login', { body: { email, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

/** Empresa con propietario verificado, sesión iniciada, plan sembrado y dos cuentas movibles. */
async function readyTenant(email = 'ana@empresa.co') {
  const { tenantId } = await register(email);
  await verifyEmail(email);
  const cookie = await login(email);
  const base = `/v1/tenants/${tenantId}`;
  await call('POST', `${base}/accounts/seed`, { cookie });
  await call('POST', `${base}/accounts`, { cookie, body: { code: '110505', name: 'Caja', type: 'asset', parentCode: '11' } });
  await call('POST', `${base}/accounts`, { cookie, body: { code: '413505', name: 'Ventas', type: 'income', parentCode: '41' } });
  return { tenantId, cookie, base };
}

/** Crea una cuenta nueva y la mete a la empresa con el rol dado, por el camino real: invitación y aceptación. */
async function joinAs(tenant, email, role, { verify = false } = {}) {
  const created = await register(email, `Empresa de ${email}`);
  if (verify) await verifyEmail(email);
  const cookie = await login(email);
  const invite = await call('POST', `${tenant.base}/members`, { cookie: tenant.cookie, body: { email, role } });
  expect(invite.statusCode).toBe(202);
  const accept = await call('POST', '/v1/invitations/accept', { cookie, body: { token: tokenIn(mailer.last(email)) } });
  expect(accept.statusCode).toBe(201);
  return { cookie, userId: created.userId };
}

const sale = (amount = 119_000) => ({
  docType: 'CC',
  date: '2026-10-15T12:00:00Z',
  currency: 'COP',
  lines: [
    { accountId: '110505', debit: amount },
    { accountId: '413505', credit: amount },
  ],
});

beforeAll(async () => {
  mongo = await startMongo('lulubiz_http_test');
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
  reports = [];
  app = await makeApp();
});

describe('estado del servicio', () => {
  it('responde vivo y listo', async () => {
    expect((await call('GET', '/healthz')).json()).toEqual({ status: 'ok' });
    expect((await call('GET', '/readyz')).json()).toEqual({ status: 'ready' });
  });

  it('una ruta inexistente responde 404 en JSON', async () => {
    const res = await call('GET', '/v1/nada');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  it('envía cabeceras de seguridad y prohíbe cachear la API', async () => {
    const res = await call('GET', '/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect((await call('GET', '/v1/me')).headers['cache-control']).toBe('no-store');
  });
});

describe('autenticación', () => {
  it('registra, inicia sesión con cookie httpOnly SameSite=Strict y no filtra el hash', async () => {
    await register('ana@empresa.co');
    const res = await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'lulubiz_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.value).toHaveLength(43);
    expect(res.json().memberships).toHaveLength(1);
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('scrypt$');
  });

  it('credenciales incorrectas y correo inexistente dan la misma respuesta', async () => {
    await register('ana@empresa.co');
    const wrong = await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: 'incorrecta-incorrecta' } });
    const unknown = await call('POST', '/v1/auth/login', { body: { email: 'nadie@empresa.co', password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect(cookieOf(wrong)).toBeNull();
  });

  it('/v1/me exige sesión y devuelve la cuenta; cerrar sesión la invalida', async () => {
    await register('ana@empresa.co');
    expect((await call('GET', '/v1/me')).statusCode).toBe(401);
    const cookie = await login('ana@empresa.co');
    const me = (await call('GET', '/v1/me', { cookie })).json();
    expect(me.account).toMatchObject({ email: 'ana@empresa.co', emailVerified: false, mfaEnabled: false });
    expect(me.memberships).toHaveLength(1);
    expect((await call('POST', '/v1/auth/logout', { cookie })).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', { cookie })).statusCode).toBe(401);
  });

  it('registro: correo repetido 409, contraseña débil 400, campos extra 400', async () => {
    await register('ana@empresa.co');
    const body = { companyName: 'X', country: 'CO', currency: 'COP', email: 'ANA@empresa.co', password: PASSWORD };
    expect((await call('POST', '/v1/auth/register', { body })).statusCode).toBe(409);
    expect((await call('POST', '/v1/auth/register', { body: { ...body, email: 'otro@x.co', password: 'corta' } })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/register', { body: { ...body, email: 'otro@x.co', rol: 'admin' } })).statusCode).toBe(400);
  });
});

describe('verificación de correo y recuperación de contraseña', () => {
  it('verifica el correo con el enlace recibido, una sola vez', async () => {
    await register('ana@empresa.co');
    const token = tokenIn(mailer.last('ana@empresa.co'));
    expect((await call('POST', '/v1/auth/verify-email', { body: { token } })).statusCode).toBe(204);
    expect((await call('POST', '/v1/auth/verify-email', { body: { token } })).statusCode).toBe(400);
    const cookie = await login('ana@empresa.co');
    expect((await call('GET', '/v1/me', { cookie })).json().account.emailVerified).toBe(true);
  });

  it('reenviar la verificación exige sesión y respeta el intervalo', async () => {
    await register('ana@empresa.co');
    expect((await call('POST', '/v1/auth/resend-verification')).statusCode).toBe(401);
    const cookie = await login('ana@empresa.co');
    expect((await call('POST', '/v1/auth/resend-verification', { cookie })).json()).toEqual({ sent: false, reason: 'TOO_SOON' });
  });

  it('recuperación: responde igual exista o no el correo, y el enlace cambia la contraseña y cierra sesiones', async () => {
    await register('ana@empresa.co');
    const cookie = await login('ana@empresa.co');
    const known = await call('POST', '/v1/auth/password/forgot', { body: { email: 'ana@empresa.co' } });
    const unknown = await call('POST', '/v1/auth/password/forgot', { body: { email: 'nadie@empresa.co' } });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.body).toBe(known.body);
    expect(mailer.sent.filter((m) => m.to === 'nadie@empresa.co')).toHaveLength(0);

    const token = tokenIn(mailer.last('ana@empresa.co'));
    expect((await call('POST', '/v1/auth/password/reset', { body: { token, password: 'corta' } })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/password/reset', { body: { token, password: NEW_PASSWORD } })).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', { cookie })).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: PASSWORD } })).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: NEW_PASSWORD } })).statusCode).toBe(200);
    expect((await call('POST', '/v1/auth/password/reset', { body: { token, password: NEW_PASSWORD } })).statusCode).toBe(400);
  });

  it('limita las solicitudes de recuperación por IP', async () => {
    await app.close();
    app = await makeApp({ passwordReset: { max: 2, timeWindow: '1 hour' } });
    const ask = () => call('POST', '/v1/auth/password/forgot', { body: { email: 'ana@empresa.co' } });
    expect([(await ask()).statusCode, (await ask()).statusCode, (await ask()).statusCode]).toEqual([202, 202, 429]);
  });
});

describe('verificación en dos pasos', () => {
  it('activar, iniciar sesión en dos pasos y desactivar, por la API', async () => {
    await register('ana@empresa.co');
    const cookie = await login('ana@empresa.co');

    expect((await call('POST', '/v1/auth/mfa/enroll')).statusCode).toBe(401);
    const enroll = (await call('POST', '/v1/auth/mfa/enroll', { cookie })).json();
    expect(enroll.otpauthUri).toContain('otpauth://totp/');
    expect((await call('POST', '/v1/auth/mfa/confirm', { cookie, body: { code: '000000' } })).statusCode).toBe(401);
    const confirmed = await call('POST', '/v1/auth/mfa/confirm', { cookie, body: { code: totpAt(enroll.secret, Date.now()) } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().recoveryCodes).toHaveLength(10);

    // Con los dos pasos activos, la contraseña sola ya no da cookie.
    const first = await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: PASSWORD } });
    expect(first.json().mfaRequired).toBe(true);
    expect(cookieOf(first)).toBeNull();
    const challenge = first.json().challenge;

    expect((await call('POST', '/v1/auth/mfa/verify', { body: { challenge, code: '000000' } })).statusCode).toBe(401);
    // El código usado al activar no vale (un código sirve una sola vez): se espera al siguiente paso con otro código de recuperación.
    const recovery = confirmed.json().recoveryCodes[0];
    const second = await call('POST', '/v1/auth/mfa/verify', { body: { challenge, code: recovery } });
    expect(second.statusCode).toBe(200);
    expect(second.json().usedRecoveryCode).toBe(true);
    const session = cookieOf(second);
    expect(session).not.toBeNull();
    expect((await call('GET', '/v1/me', { cookie: session })).json().account.mfaEnabled).toBe(true);

    const codes = confirmed.json().recoveryCodes;
    const disable = await call('POST', '/v1/auth/mfa/disable', { cookie: session, body: { password: PASSWORD, code: codes[1] } });
    expect(disable.statusCode).toBe(204);
    expect((await call('GET', '/v1/me', { cookie: session })).json().account.mfaEnabled).toBe(false);
  });

  it('el desafío mal formado se rechaza antes de llegar al servicio', async () => {
    expect((await call('POST', '/v1/auth/mfa/verify', { body: { challenge: 'corto', code: '123456' } })).statusCode).toBe(400);
  });
});

describe('protecciones de la API', () => {
  it('rechaza un Origin no permitido en peticiones que modifican, y acepta el permitido', async () => {
    await register('ana@empresa.co');
    const body = { email: 'ana@empresa.co', password: PASSWORD };
    const evil = await call('POST', '/v1/auth/login', { body, headers: { origin: 'https://sitio-malo.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error).toBe('FORBIDDEN_ORIGIN');
    expect((await call('POST', '/v1/auth/login', { body, headers: { origin: ORIGIN } })).statusCode).toBe(200);
  });

  it('solo acepta JSON: text/plain se rechaza', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ email: 'a@b.co', password: PASSWORD }),
    });
    expect(res.statusCode).toBe(415);
  });

  it('limita los intentos de inicio de sesión por IP', async () => {
    await app.close();
    app = await makeApp({ login: { max: 3, timeWindow: '1 minute' } });
    await register('ana@empresa.co');
    const attempt = () => call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: 'incorrecta-incorrecta' } });
    expect([(await attempt()).statusCode, (await attempt()).statusCode, (await attempt()).statusCode]).toEqual([401, 401, 401]);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('un error inesperado responde 500 genérico y se reporta, sin filtrar cookies ni cuerpo', async () => {
    await app.close();
    app = await makeApp();
    app.get('/v1/boom', async () => {
      throw new Error('detalle interno secreto');
    });
    const res = await call('GET', '/v1/boom', { cookie: 'lulubiz_session=abc' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'INTERNAL', message: 'error interno' });
    expect(res.body).not.toContain('detalle interno secreto');
    expect(reports).toHaveLength(1);
    expect(reports[0].err.message).toBe('detalle interno secreto');
    expect(reports[0].context).toMatchObject({ method: 'GET', route: '/v1/boom', status: 500 });
    expect(JSON.stringify(reports[0].context)).not.toContain('abc');
  });

  it('los errores de dominio no se reportan como fallos del servidor', async () => {
    await register('ana@empresa.co');
    await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: 'incorrecta-incorrecta' } });
    expect(reports).toHaveLength(0);
    expect(statusFor(new Error('boom'))).toBe(500);
    expect(statusFor(Object.assign(new Error('x'), { code: 'FORBIDDEN' }))).toBe(403);
    expect(statusFor(Object.assign(new Error('x'), { name: 'PeriodClosedError' }))).toBe(409);
  });
});

describe('autorización por empresa y rol', () => {
  it('sin sesión es 401 aunque el cuerpo sea basura (se autentica antes de validar)', async () => {
    const { tenantId } = await register('ana@empresa.co');
    const res = await call('POST', `/v1/tenants/${tenantId}/journals`, { body: { basura: true } });
    expect(res.statusCode).toBe(401);
  });

  it('otra empresa y una empresa inexistente dan el mismo 403, y un id mal formado 400', async () => {
    const a = await readyTenant('ana@empresa.co');
    await register('beto@otra.co', 'Otra SAS');
    const cookieB = await login('beto@otra.co');
    const foreign = await call('GET', `${a.base}/accounts`, { cookie: cookieB });
    const ghost = await call('GET', '/v1/tenants/aaaaaaaaaaaaaaaaaaaaaaaa/accounts', { cookie: cookieB });
    expect(foreign.statusCode).toBe(403);
    expect(ghost.statusCode).toBe(403);
    expect(foreign.body).toBe(ghost.body);
    expect((await call('GET', '/v1/tenants/abc/accounts', { cookie: cookieB })).statusCode).toBe(400);
  });

  it('un lector consulta pero no modifica; un administrador no invita propietarios', async () => {
    const a = await readyTenant('ana@empresa.co');
    const viewer = await joinAs(a, 'lector@empresa.co', 'viewer');
    const admin = await joinAs(a, 'admin@empresa.co', 'admin', { verify: true });

    expect((await call('GET', `${a.base}/accounts`, { cookie: viewer.cookie })).statusCode).toBe(200);
    expect((await call('POST', `${a.base}/accounts`, { cookie: viewer.cookie, body: { code: '9', name: 'x', type: 'memo', nature: 'debit' } })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/journals`, { cookie: viewer.cookie, body: sale(), headers: { 'idempotency-key': 'clave-uno-1' } })).statusCode).toBe(403);
    expect((await call('GET', `${a.base}/members`, { cookie: viewer.cookie })).statusCode).toBe(403);

    const grant = await call('POST', `${a.base}/members`, { cookie: admin.cookie, body: { email: 'nuevo@x.co', role: 'owner' } });
    expect(grant.statusCode).toBe(403);
    expect((await call('POST', `${a.base}/members`, { cookie: admin.cookie, body: { email: 'nuevo@x.co', role: 'viewer' } })).statusCode).toBe(202);
  });

  it('quien no verificó su correo no puede invitar', async () => {
    const { tenantId } = await register('ana@empresa.co');
    const cookie = await login('ana@empresa.co');
    const res = await call('POST', `/v1/tenants/${tenantId}/members`, { cookie, body: { email: 'otro@x.co', role: 'viewer' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('invitaciones y miembros', () => {
  it('una persona sin cuenta ve la invitación, crea su cuenta al aceptar y entra con el rol dado', async () => {
    const a = await readyTenant('ana@empresa.co');
    const invite = await call('POST', `${a.base}/members`, { cookie: a.cookie, body: { email: 'carlos@contadores.co', role: 'accountant' } });
    expect(invite.json()).toEqual({ invited: true, delivered: true });
    const token = tokenIn(mailer.last('carlos@contadores.co'));

    const lookup = await call('POST', '/v1/invitations/lookup', { body: { token } });
    expect(lookup.json()).toEqual({ email: 'carlos@contadores.co', role: 'accountant', company: 'Empresa SAS', accountExists: false });

    expect((await call('POST', '/v1/invitations/accept', { body: { token, name: 'Carlos', password: 'corta' } })).statusCode).toBe(400);
    const accepted = await call('POST', '/v1/invitations/accept', { body: { token, name: 'Carlos Peña', password: NEW_PASSWORD } });
    expect(accepted.statusCode).toBe(201);
    const cookie = await login('carlos@contadores.co', NEW_PASSWORD);
    expect((await call('GET', `${a.base}/accounts`, { cookie })).statusCode).toBe(200);
    expect((await call('POST', '/v1/invitations/accept', { body: { token, name: 'Otro', password: NEW_PASSWORD } })).statusCode).toBe(400);
  });

  it('quien ya tiene cuenta debe iniciar sesión con ella para aceptar', async () => {
    const a = await readyTenant('ana@empresa.co');
    await register('lucia@otra.co', 'Lucía SAS');
    await call('POST', `${a.base}/members`, { cookie: a.cookie, body: { email: 'lucia@otra.co', role: 'viewer' } });
    const token = tokenIn(mailer.last('lucia@otra.co'));
    const noSession = await call('POST', '/v1/invitations/accept', { body: { token } });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.json().error).toBe('LOGIN_REQUIRED');
    const wrong = await call('POST', '/v1/invitations/accept', { cookie: a.cookie, body: { token } });
    expect(wrong.statusCode).toBe(401);
    const right = await call('POST', '/v1/invitations/accept', { cookie: await login('lucia@otra.co'), body: { token } });
    expect(right.statusCode).toBe(201);
  });

  it('lista, cambia el rol y quita miembros, sin dejar la empresa sin propietario', async () => {
    const a = await readyTenant('ana@empresa.co');
    const luis = await joinAs(a, 'luis@empresa.co', 'viewer');
    const members = (await call('GET', `${a.base}/members`, { cookie: a.cookie })).json().items;
    expect(members.map((m) => m.email).sort()).toEqual(['ana@empresa.co', 'luis@empresa.co']);
    expect(JSON.stringify(members)).not.toContain('passwordHash');

    expect((await call('PATCH', `${a.base}/members/${luis.userId}`, { cookie: a.cookie, body: { role: 'accountant' } })).statusCode).toBe(204);
    expect((await call('DELETE', `${a.base}/members/${luis.userId}`, { cookie: a.cookie })).statusCode).toBe(204);
    const me = (await call('GET', '/v1/me', { cookie: a.cookie })).json().account;
    expect((await call('DELETE', `${a.base}/members/${me.userId}`, { cookie: a.cookie })).statusCode).toBe(409);
  });
});

describe('plan de cuentas y terceros', () => {
  it('siembra el plan de Colombia como borrador, sin duplicar al repetir', async () => {
    const { tenantId, cookie } = await readyTenant();
    const again = await call('POST', `/v1/tenants/${tenantId}/accounts/seed`, { cookie });
    expect(again.json()).toMatchObject({ country: 'CO', created: 0, draft: true });
    const list = await call('GET', `/v1/tenants/${tenantId}/accounts?activeOnly=true`, { cookie });
    expect(list.json().items.length).toBeGreaterThan(30);
  });

  it('crea cuentas con validación y rechaza duplicadas', async () => {
    const { base, cookie } = await readyTenant();
    expect((await call('POST', `${base}/accounts`, { cookie, body: { code: '110505', name: 'Otra', type: 'asset', parentCode: '11' } })).statusCode).toBe(409);
    expect((await call('POST', `${base}/accounts`, { cookie, body: { code: '12a', name: 'x', type: 'asset' } })).statusCode).toBe(400);
    expect((await call('POST', `${base}/accounts/110505/deactivate`, { cookie })).statusCode).toBe(204);
    expect((await call('POST', `${base}/accounts/999999/deactivate`, { cookie })).statusCode).toBe(404);
    expect((await call('POST', `${base}/accounts/110505/activate`, { cookie })).statusCode).toBe(204);
    expect((await call('POST', `${base}/accounts/999999/activate`, { cookie })).statusCode).toBe(404);
    const accounts = (await call('GET', `${base}/accounts?activeOnly=true`, { cookie })).json().items;
    expect(accounts.some((a) => a.code === '110505')).toBe(true);
  });

  it('terceros: crea con NIT válido, rechaza dígito incorrecto y duplicados, no edita la identificación', async () => {
    const { base, cookie } = await readyTenant();
    const body = { name: 'Droguería Los Andes', roles: ['customer'], taxIdType: 'NIT', taxId: '890903938', checkDigit: 8 };
    const created = await call('POST', `${base}/parties`, { cookie, body });
    expect(created.statusCode).toBe(201);
    expect((await call('POST', `${base}/parties`, { cookie, body: { ...body, taxId: '800197268' } })).statusCode).toBe(400);
    expect((await call('POST', `${base}/parties`, { cookie, body })).statusCode).toBe(409);

    const id = created.json()._id;
    expect((await call('PATCH', `${base}/parties/${id}`, { cookie, body: { taxId: '800197268' } })).statusCode).toBe(422);
    expect((await call('PATCH', `${base}/parties/${id}`, { cookie, body: { phone: '3001234567' } })).json().phone).toBe('3001234567');
    expect((await call('GET', `${base}/parties/aaaaaaaaaaaaaaaaaaaaaaaa`, { cookie })).statusCode).toBe(404);
    const found = await call('GET', `${base}/parties?search=drog&role=customer`, { cookie });
    expect(found.json().items).toHaveLength(1);
    expect((await call('POST', `${base}/parties/${id}/active`, { cookie, body: { active: false } })).statusCode).toBe(204);
  });
});

describe('libro contable por la API', () => {
  it('exige Idempotency-Key, registra, repite sin duplicar y consulta el saldo', async () => {
    const { base, cookie } = await readyTenant();
    expect((await call('POST', `${base}/journals`, { cookie, body: sale() })).statusCode).toBe(400);

    const headers = { 'idempotency-key': 'venta-0001-abc' };
    const first = await call('POST', `${base}/journals`, { cookie, body: sale(), headers });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, journal: { number: 1, period: '2026-10' } });

    const again = await call('POST', `${base}/journals`, { cookie, body: sale(), headers });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);

    const balance = await call('GET', `${base}/balances?account=110505&period=2026-10&currency=COP`, { cookie });
    expect(balance.json()).toEqual({ debit: 119_000, credit: 0 });
    expect((await call('GET', `${base}/balances?account=110505&period=2026-13&currency=COP`, { cookie })).statusCode).toBe(400);
    expect((await call('GET', `${base}/journals/${first.json().journal._id}`, { cookie })).statusCode).toBe(200);
  });

  it('rechaza asientos descuadrados, decimales, textos como números y campos extra', async () => {
    const { base, cookie } = await readyTenant();
    const headers = { 'idempotency-key': 'venta-0002-abc' };
    const post = (body) => call('POST', `${base}/journals`, { cookie, body, headers });

    const unbalanced = sale();
    unbalanced.lines[1].credit = 100;
    expect((await post(unbalanced)).statusCode).toBe(422);

    const decimal = sale();
    decimal.lines[0].debit = 10.5;
    expect((await post(decimal)).statusCode).toBe(400);

    const asText = sale();
    asText.lines[0].debit = '119000';
    expect((await post(asText)).statusCode).toBe(400);

    expect((await post({ ...sale(), extra: 1 })).statusCode).toBe(400);
    expect((await post({ ...sale(), date: 'ayer' })).statusCode).toBe(422);
  });

  it('la clave manual lleva su propio prefijo y repetirla con otro contenido es un conflicto, no un reintento', async () => {
    const { base, cookie } = await readyTenant();
    const headers = { 'idempotency-key': 'payroll-aaaaaaaaaaaaaaaaaaaaaaaa' };
    const first = await call('POST', `${base}/journals`, { cookie, body: sale(), headers });
    expect(first.statusCode).toBe(201);
    // Una clave de usuario nunca coincide con la de un documento del sistema.
    expect(first.json().journal.idempotencyKey).toBe('manual:payroll-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(first.json().journal.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    // Mismo contenido: reintento. Otro contenido con la misma clave: 409, y no se asienta nada.
    expect((await call('POST', `${base}/journals`, { cookie, body: sale(), headers })).json().replayed).toBe(true);
    const other = await call('POST', `${base}/journals`, { cookie, body: sale(120_000), headers });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('IDEMPOTENCY_CONFLICT');
    expect((await call('GET', `${base}/journals`, { cookie })).json().items).toHaveLength(1);
  });

  it('el tipo de documento se normaliza y debe ser de 1 a 10 letras o números', async () => {
    const { base, cookie } = await readyTenant();
    const post = (docType, key) => call('POST', `${base}/journals`, { cookie, body: { ...sale(), docType }, headers: { 'idempotency-key': key } });
    const ok = await post(' aj ', 'tipo-0001-abcdef');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().journal.docType).toBe('AJ');
    for (const [i, bad] of ['A J', 'A-J', 'a/b', '   '].entries()) expect((await post(bad, `tipo-bad${i}-abcdef`)).statusCode, bad).toBe(422);
  });

  it('no contabiliza en una cuenta de agrupación', async () => {
    const { base, cookie } = await readyTenant();
    const body = sale();
    body.lines[0].accountId = '11';
    const res = await call('POST', `${base}/journals`, { cookie, body, headers: { 'idempotency-key': 'venta-0003-abc' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/agrupación/);
  });

  it('revierte una vez; la repetición exacta es idempotente y otra reversión da 409', async () => {
    const { base, cookie } = await readyTenant();
    const first = await call('POST', `${base}/journals`, { cookie, body: sale(), headers: { 'idempotency-key': 'venta-0004-abc' } });
    const id = first.json().journal._id;

    const reverse = await call('POST', `${base}/journals/${id}/reverse`, { cookie, headers: { 'idempotency-key': 'rev-0004-abcdef' } });
    expect(reverse.statusCode).toBe(201);
    const replay = await call('POST', `${base}/journals/${id}/reverse`, { cookie, headers: { 'idempotency-key': 'rev-0004-abcdef' } });
    expect(replay.statusCode).toBe(200);
    const second = await call('POST', `${base}/journals/${id}/reverse`, { cookie, headers: { 'idempotency-key': 'rev-0004-otra-clave' } });
    expect(second.statusCode).toBe(409);
    expect((await call('GET', `${base}/balances?account=110505&period=2026-10&currency=COP`, { cookie })).json()).toEqual({ debit: 119_000, credit: 119_000 });
  });

  it('lista los asientos con filtros, paginación y marca de revertido', async () => {
    const { base, cookie } = await readyTenant();
    const ids = [];
    for (const [i, date] of ['2026-09-10', '2026-10-10', '2026-10-11'].entries()) {
      const res = await call('POST', `${base}/journals`, {
        cookie,
        body: { ...sale(), date: `${date}T12:00:00Z` },
        headers: { 'idempotency-key': `lista-000${i}-abcd` },
      });
      ids.push(res.json().journal._id);
    }
    await call('POST', `${base}/journals/${ids[2]}/reverse`, {
      cookie,
      body: { date: '2026-10-20T12:00:00Z' },
      headers: { 'idempotency-key': 'lista-rev-abcd' },
    });

    const all = (await call('GET', `${base}/journals`, { cookie })).json();
    expect(all.items).toHaveLength(4);
    expect(all.items.find((j) => j._id === ids[2]).reversedByJournalId).toBeDefined();
    expect((await call('GET', `${base}/journals?period=2026-09`, { cookie })).json().items).toHaveLength(1);

    const page = (await call('GET', `${base}/journals?limit=3`, { cookie })).json();
    expect(page.items).toHaveLength(3);
    const next = (await call('GET', `${base}/journals?limit=3&cursor=${page.nextCursor}`, { cookie })).json();
    expect(next.items).toHaveLength(1);
    expect((await call('GET', `${base}/journals?period=2026-13`, { cookie })).statusCode).toBe(400);
  });

  it('una empresa no ve los asientos de otra', async () => {
    const a = await readyTenant('ana@empresa.co');
    const first = await call('POST', `${a.base}/journals`, { cookie: a.cookie, body: sale(), headers: { 'idempotency-key': 'venta-0005-abc' } });
    const b = await readyTenant('beto@otra.co');
    expect((await call('GET', `${b.base}/journals/${first.json().journal._id}`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call('GET', `${b.base}/journals`, { cookie: b.cookie })).json().items).toHaveLength(0);
  });
});

describe('períodos', () => {
  it('cerrar un período bloquea asientos y reversiones en él, y reabrirlo los permite', async () => {
    const { base, cookie } = await readyTenant();
    const headers = (n) => ({ 'idempotency-key': `periodo-000${n}-abc` });
    const first = await call('POST', `${base}/journals`, { cookie, body: sale(), headers: headers(1) });

    expect((await call('POST', `${base}/periods/2026-10/close`, { cookie })).json()).toEqual({ period: '2026-10', status: 'closed' });
    expect((await call('POST', `${base}/periods/2026-10/close`, { cookie })).statusCode).toBe(409);

    const blocked = await call('POST', `${base}/journals`, { cookie, body: sale(), headers: headers(2) });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/cerrado/);
    const reverseClosed = await call('POST', `${base}/journals/${first.json().journal._id}/reverse`, {
      cookie,
      body: { date: '2026-10-20T12:00:00Z' },
      headers: headers(3),
    });
    expect(reverseClosed.statusCode).toBe(409);

    const periods = (await call('GET', `${base}/periods`, { cookie })).json().items;
    expect(periods.find((p) => p.period === '2026-10').status).toBe('closed');

    expect((await call('POST', `${base}/periods/2026-10/reopen`, { cookie })).json().status).toBe('open');
    expect((await call('POST', `${base}/journals`, { cookie, body: sale(), headers: headers(4) })).statusCode).toBe(201);
    expect((await call('POST', `${base}/periods/2026-13/close`, { cookie })).statusCode).toBe(400);
  });

  it('un contador cierra pero no reabre; un lector no cierra', async () => {
    const a = await readyTenant('ana@empresa.co');
    const accountant = await joinAs(a, 'conta@empresa.co', 'accountant');
    const viewer = await joinAs(a, 'lector@empresa.co', 'viewer');
    expect((await call('POST', `${a.base}/periods/2026-10/close`, { cookie: viewer.cookie })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/periods/2026-10/close`, { cookie: accountant.cookie })).statusCode).toBe(200);
    expect((await call('POST', `${a.base}/periods/2026-10/reopen`, { cookie: accountant.cookie })).statusCode).toBe(403);
    expect((await call('POST', `${a.base}/periods/2026-10/reopen`, { cookie: a.cookie })).statusCode).toBe(200);
  });
});

describe('métricas', () => {
  it('están deshabilitadas sin token configurado', async () => {
    expect((await call('GET', '/metrics')).statusCode).toBe(404);
  });

  it('exigen el token, y usan el patrón de la ruta como etiqueta, no la URL real', async () => {
    await app.close();
    app = await makeApp({}, { metricsToken: 'token-de-metricas-123' });
    const { tenantId, cookie } = await readyTenant();
    await call('GET', `/v1/tenants/${tenantId}/accounts`, { cookie });

    expect((await call('GET', '/metrics')).statusCode).toBe(401);
    expect((await call('GET', '/metrics', { headers: { authorization: 'Bearer incorrecto' } })).statusCode).toBe(401);
    const res = await call('GET', '/metrics', { headers: { authorization: 'Bearer token-de-metricas-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('lulubiz_http_requests_total{method="GET",route="/v1/tenants/:tenantId/accounts",status="200"}');
    expect(res.body).toContain('lulubiz_http_request_duration_seconds_bucket');
    expect(res.body).not.toContain(tenantId);
    await call('GET', '/ruta/inventada/123');
    expect((await call('GET', '/metrics', { headers: { authorization: 'Bearer token-de-metricas-123' } })).body).toContain('route="sin-ruta"');
  });
});

describe('auditoría', () => {
  it('registra las acciones sensibles, la más reciente primero, sin duplicar repeticiones idempotentes', async () => {
    const { base, cookie } = await readyTenant();
    const headers = { 'idempotency-key': 'venta-aud-0001' };
    await call('POST', `${base}/journals`, { cookie, body: sale(), headers });
    await call('POST', `${base}/journals`, { cookie, body: sale(), headers });

    const list = (await call('GET', `${base}/audit`, { cookie })).json();
    const actions = list.items.map((e) => e.action);
    expect(actions[0]).toBe('journal.post');
    expect(actions.filter((a) => a === 'journal.post')).toHaveLength(1);
    expect(actions).toEqual(expect.arrayContaining(['tenant.register', 'account.seed', 'account.create']));
    // El inicio de sesión ocurre antes de elegir empresa: se anota con el usuario, sin empresa.
    expect(actions).not.toContain('auth.login');
    expect(await db.collection(COLLECTIONS.audit).countDocuments({ action: 'auth.login', tenantId: null })).toBeGreaterThan(0);
    expect(list.items[0]).toMatchObject({ details: { docType: 'CC', number: 1 } });
    expect(list.items[0].requestId).toBeTruthy();
  });

  it('anota cierre y reapertura de períodos, invitaciones y cambios de miembros', async () => {
    const a = await readyTenant('ana@empresa.co');
    const luis = await joinAs(a, 'luis@empresa.co', 'viewer');
    await call('POST', `${a.base}/periods/2026-10/close`, { cookie: a.cookie });
    await call('POST', `${a.base}/periods/2026-10/reopen`, { cookie: a.cookie });
    await call('PATCH', `${a.base}/members/${luis.userId}`, { cookie: a.cookie, body: { role: 'accountant' } });
    await call('DELETE', `${a.base}/members/${luis.userId}`, { cookie: a.cookie });
    const actions = (await call('GET', `${a.base}/audit`, { cookie: a.cookie })).json().items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['member.invite', 'member.accept_invitation', 'period.close', 'period.reopen', 'member.change_role', 'member.remove']),
    );
  });

  it('pagina con cursor', async () => {
    const { base, cookie } = await readyTenant();
    const first = (await call('GET', `${base}/audit?limit=2`, { cookie })).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await call('GET', `${base}/audit?limit=2&cursor=${first.nextCursor}`, { cookie })).json();
    const ids = new Set([...first.items, ...second.items].map((e) => e._id));
    expect(ids.size).toBe(first.items.length + second.items.length);
  });

  it('solo propietarios y administradores la leen, y cada empresa ve la suya', async () => {
    const a = await readyTenant('ana@empresa.co');
    const viewer = await joinAs(a, 'lector@empresa.co', 'viewer');
    expect((await call('GET', `${a.base}/audit`, { cookie: viewer.cookie })).statusCode).toBe(403);

    const b = await readyTenant('beto@otra.co');
    const mine = (await call('GET', `${b.base}/audit`, { cookie: b.cookie })).json();
    expect(mine.items.every((e) => String(e.tenantId) === b.tenantId)).toBe(true);
  });

  it('anota los inicios de sesión fallidos sin empresa', async () => {
    await register('ana@empresa.co');
    await call('POST', '/v1/auth/login', { body: { email: 'ana@empresa.co', password: 'incorrecta-incorrecta' } });
    const failed = await db.collection(COLLECTIONS.audit).findOne({ action: 'auth.login_failed' });
    expect(failed).toMatchObject({ tenantId: null, userId: null, details: { email: 'ana@empresa.co' } });
  });

  it('si el evento de auditoría no se puede escribir, la operación tampoco se confirma', async () => {
    const { base, cookie } = await readyTenant();
    // Se rompe la escritura de auditoría en la base: el asiento no debe quedar.
    await db.collection(COLLECTIONS.audit).drop();
    await db.createCollection(COLLECTIONS.audit, { validator: { $jsonSchema: { bsonType: 'object', required: ['campoImposible'] } }, validationAction: 'error' });
    const res = await call('POST', `${base}/journals`, { cookie, body: sale(), headers: { 'idempotency-key': 'venta-sin-audit' } });
    expect(res.statusCode).toBe(500);
    expect(await db.collection(COLLECTIONS.journals).countDocuments()).toBe(0);
    expect(reports).toHaveLength(1);
  });
});
