import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { createApiKeyService, MAX_KEY_LIFETIME_DAYS } from './apiKeys.js';
import { createAuthService } from './auth.js';
import { parseKey } from './secretbox.js';
import { totpAt } from './totp.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const NEW_PASSWORD = 'otra-contrasena-larga-y-nueva';
const KEY = parseKey(Buffer.alloc(32, 9).toString('base64'));
const MINUTE = 60_000;

let mongo;
let db;
let auth;
let apiKeys;
let mailer;
let clock;

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};
const company = (email, name = 'Marta') => ({ companyName: `Empresa de ${email}`, country: 'CO', currency: 'COP', ownerName: name, email, password: PASSWORD });

beforeAll(async () => {
  mongo = await startMongo('lulubiz_auth_session_test');
  db = mongo.db;
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  clock = new Date('2030-01-01T10:00:00Z');
  mailer = createMemoryMailer();
  auth = createAuthService(mongo.client, db, { now: () => clock, passwordParams: FAST, mailer, mfaKey: KEY });
  apiKeys = createApiKeyService({ client: mongo.client, db, now: () => clock });
});

describe('actividad de la sesión (menos escrituras)', () => {
  it('lastSeenAt se escribe como mucho una vez por minuto, y el vencimiento por inactividad sigue funcionando', async () => {
    await auth.registerTenant(company('marta@andina.co'));
    const { token } = await auth.login('marta@andina.co', PASSWORD);
    const seen = async () => (await db.collection(COLLECTIONS.sessions).findOne({})).lastSeenAt.getTime();
    const start = await seen();
    advance(10_000);
    await auth.verifySession(token);
    expect(await seen()).toBe(start); // dentro del minuto: sin escritura
    advance(55_000);
    await auth.verifySession(token);
    expect(await seen()).toBe(clock.getTime()); // pasado el minuto: se marca
    advance(31 * MINUTE);
    expect(await code(auth.verifySession(token))).toBe('INVALID_SESSION');
  });
});

describe('pertenencia en caché', () => {
  it('quitar o degradar a alguien surte efecto en el acto, sin esperar a que venza la caché', async () => {
    const { tenantId, userId: owner } = await auth.registerTenant(company('marta@andina.co'));
    const { userId: other } = await auth.registerTenant(company('segundo@andina.co', 'S'));
    const actor = { userId: owner, tenantId };
    await auth.addMember(actor, { email: 'segundo@andina.co', role: 'accountant' });
    const { token } = await auth.login('segundo@andina.co', PASSWORD);
    expect(await auth.authorize(token, tenantId, 'journals:post')).toMatchObject({ role: 'accountant' });
    expect(await auth.authorize(token, tenantId, 'journals:post')).toMatchObject({ role: 'accountant' }); // desde la caché
    await auth.changeRole(actor, other, 'viewer');
    expect(await code(auth.authorize(token, tenantId, 'journals:post'))).toBe('FORBIDDEN');
    expect(await auth.authorize(token, tenantId, 'journals:read')).toMatchObject({ role: 'viewer' });
    await auth.removeMember(actor, other);
    expect(await code(auth.authorize(token, tenantId, 'journals:read'))).toBe('FORBIDDEN');
  });
});

describe('confirmación reciente (step-up)', () => {
  let tenantId;
  let userId;
  let token;

  beforeEach(async () => {
    ({ tenantId, userId } = await auth.registerTenant(company('marta@andina.co')));
    ({ token } = await auth.login('marta@andina.co', PASSWORD));
  });

  it('el inicio de sesión cuenta como confirmación; pasado el plazo se exige de nuevo y la contraseña la renueva', async () => {
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBeNull();
    advance(9 * MINUTE);
    await auth.verifySession(token);
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBeNull();
    advance(2 * MINUTE); // 11 minutos desde el inicio de sesión (la sesión sigue viva)
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBe('STEP_UP_REQUIRED');
    // Lo demás no se ve afectado: solo las operaciones que lo exigen.
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage'))).toBeNull();

    expect(await code(auth.stepUp(token, userId, { password: 'incorrecta-incorrecta' }))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBe('STEP_UP_REQUIRED');
    const done = await auth.stepUp(token, userId, { password: PASSWORD });
    expect(done.validUntil.getTime()).toBe(clock.getTime() + 10 * MINUTE);
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBeNull();
  });

  it('los fallos de confirmación cuentan contra la cuenta y la bloquean', async () => {
    for (let i = 0; i < 5; i += 1) expect(await code(auth.stepUp(token, userId, { password: 'incorrecta-incorrecta' }))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.stepUp(token, userId, { password: PASSWORD }))).toBe('INVALID_CREDENTIALS'); // cuenta bloqueada
  });

  it('con dos pasos activos exige también un código vigente', async () => {
    const started = await auth.startMfaEnrollment(userId);
    await auth.confirmMfaEnrollment(userId, totpAt(started.secret, clock.getTime()));
    advance(11 * MINUTE);
    await auth.verifySession(token);
    expect(await code(auth.stepUp(token, userId, { password: PASSWORD }))).toBe('VALIDATION'); // falta el código
    expect(await code(auth.stepUp(token, userId, { password: PASSWORD, code: '000000' }))).toBe('INVALID_MFA');
    expect(await code(auth.stepUp(token, userId, { password: PASSWORD, code: totpAt(started.secret, clock.getTime()) }))).toBeNull();
    expect(await code(auth.authorize(token, tenantId, 'tenant:manage', { stepUp: true }))).toBeNull();
    // El mismo código no sirve dos veces.
    advance(11 * MINUTE);
    expect(await code(auth.stepUp(token, userId, { password: PASSWORD, code: totpAt(started.secret, clock.getTime() - 11 * MINUTE) }))).toBe('INVALID_MFA');
  });

  it('una sesión que no es de la persona no se puede marcar', async () => {
    const { userId: other } = await auth.registerTenant(company('otra@andina.co', 'O'));
    expect(await code(auth.stepUp(token, other, { password: PASSWORD }))).toBe('INVALID_SESSION');
  });
});

describe('sesiones abiertas y cambio de contraseña', () => {
  let userId;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    ({ userId } = await auth.registerTenant(company('marta@andina.co')));
    tokenA = (await auth.login('marta@andina.co', PASSWORD)).token;
    advance(MINUTE);
    tokenB = (await auth.login('marta@andina.co', PASSWORD)).token;
  });

  it('lista las sesiones propias sin su token y marca la actual; cada quien cierra solo las suyas', async () => {
    const list = await auth.listSessions(userId, tokenA);
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/tokenHash/);
    const other = list.find((s) => !s.current);

    const { userId: stranger } = await auth.registerTenant(company('otra@andina.co', 'O'));
    expect(await code(auth.revokeSession(stranger, String(other.id), tokenA))).toBe('NOT_FOUND'); // de otra persona
    expect(await code(auth.revokeSession(userId, 'no-es-un-id', tokenA))).toBe('NOT_FOUND');

    const revoked = await auth.revokeSession(userId, String(other.id), tokenA);
    expect(revoked.current).toBe(false);
    expect(await code(auth.verifySession(tokenB))).toBe('INVALID_SESSION');
    expect(await code(auth.verifySession(tokenA))).toBeNull();
    const self = (await auth.listSessions(userId, tokenA))[0];
    expect((await auth.revokeSession(userId, String(self.id), tokenA)).current).toBe(true);
    expect(await code(auth.verifySession(tokenA))).toBe('INVALID_SESSION');
  });

  it('cambiar la contraseña exige la actual, cierra las demás sesiones y conserva esta', async () => {
    expect(await code(auth.changePassword(userId, tokenA, { currentPassword: 'incorrecta-incorrecta', newPassword: NEW_PASSWORD }))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.changePassword(userId, tokenA, { currentPassword: PASSWORD, newPassword: 'corta' }))).toBe('PasswordError');
    expect(await code(auth.changePassword(userId, tokenA, { currentPassword: PASSWORD, newPassword: PASSWORD }))).toBe('VALIDATION');
    const done = await auth.changePassword(userId, tokenA, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(done.loggedOut).toBe(false);
    expect(await code(auth.verifySession(tokenA))).toBeNull();
    expect(await code(auth.verifySession(tokenB))).toBe('INVALID_SESSION');
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.login('marta@andina.co', NEW_PASSWORD))).toBeNull();
    expect(mailer.last('marta@andina.co').text).toBeTruthy();
  });

  it('con logoutAll cierra también la sesión actual', async () => {
    const done = await auth.changePassword(userId, tokenA, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, logoutAll: true });
    expect(done.loggedOut).toBe(true);
    expect(await code(auth.verifySession(tokenA))).toBe('INVALID_SESSION');
    expect(await code(auth.verifySession(tokenB))).toBe('INVALID_SESSION');
  });

  it('un enlace de recuperación pendiente deja de servir al cambiar la contraseña', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    await auth.changePassword(userId, tokenA, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(await db.collection(COLLECTIONS.tokens).countDocuments({ purpose: 'password_reset', usedAt: null })).toBe(0);
  });
});

describe('claves de API y su creador', () => {
  let tenantId;
  let owner;
  let other;
  const make = (name, scopes, expiresAt) => apiKeys.create({ tenantId, userId: other, role: 'admin' }, { name, scopes, ...(expiresAt ? { expiresAt } : {}) });

  beforeEach(async () => {
    ({ tenantId, userId: owner } = await auth.registerTenant(company('marta@andina.co')));
    ({ userId: other } = await auth.registerTenant(company('segundo@andina.co', 'S')));
    await auth.addMember({ userId: owner, tenantId }, { email: 'segundo@andina.co', role: 'admin' });
  });

  it('degradar a quien las creó revoca las que exceden su nuevo rol, y quitarlo revoca todas', async () => {
    const reads = (await make('lectura', ['journals:read'])).apiKey;
    const writes = (await make('escritura', ['journals:post', 'journals:read'])).apiKey;
    const mine = (await apiKeys.create({ tenantId, userId: owner, role: 'owner' }, { name: 'del dueño', scopes: ['journals:post'] })).apiKey;

    let seen;
    await auth.changeRole({ userId: owner, tenantId }, other, 'viewer', { inTx: async (_s, r) => (seen = r) });
    expect(seen.revokedApiKeys).toBe(1);
    const state = async (key) => (await apiKeys.list(tenantId)).find((k) => String(k._id) === String(key._id)).revokedAt;
    expect(await state(writes)).toBeInstanceOf(Date);
    expect(await state(reads)).toBeUndefined(); // un lector sigue pudiendo leer
    expect(await state(mine)).toBeUndefined(); // las de otras personas no se tocan

    await auth.removeMember({ userId: owner, tenantId }, other, { inTx: async (_s, r) => (seen = r) });
    expect(seen.revokedApiKeys).toBe(1);
    expect(await state(reads)).toBeInstanceOf(Date);
    expect(await state(mine)).toBeUndefined();
  });

  it('una clave siempre vence y no más allá del máximo; sin fecha, vence al máximo', async () => {
    const without = (await make('sin fecha', ['journals:read'])).apiKey;
    const days = (without.expiresAt.getTime() - clock.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(MAX_KEY_LIFETIME_DAYS - 1);
    expect(days).toBeLessThan(MAX_KEY_LIFETIME_DAYS + 1); // el vencimiento es una fecha de calendario (mediodía)
    expect(await code(make('lejana', ['journals:read'], '2999-01-01'))).toBe('VALIDATION');
    expect(await code(make('pasado el máximo', ['journals:read'], '2031-01-03'))).toBe('VALIDATION');
    expect(await code(make('justo', ['journals:read'], '2030-12-31'))).toBeNull();
    expect(await code(make('corta', ['journals:read'], '2030-03-01'))).toBeNull();
  });
});
