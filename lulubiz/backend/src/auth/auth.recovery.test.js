import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { createAuthService } from './auth.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const NEW_PASSWORD = 'otra-clave-muy-larga-7';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let mongo;
let db;
let auth;
let mailer;
let clock;
let mailErrors;

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);
const tokenIn = (message) => decodeURIComponent(message.text.match(/#token=([^\s]+)/)[1]);
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};

const company = (overrides = {}) => ({
  companyName: 'Comercial Andina SAS',
  country: 'CO',
  currency: 'COP',
  ownerName: 'Marta Ruiz',
  email: 'marta@andina.co',
  password: PASSWORD,
  ...overrides,
});

/** Registra una empresa y confirma el correo del propietario. */
async function verifiedOwner(email = 'marta@andina.co', overrides = {}) {
  const made = await auth.registerTenant(company({ email, ...overrides }));
  await auth.verifyEmail(tokenIn(mailer.last(email)));
  return made;
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_recovery_test');
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
  mailErrors = [];
  auth = createAuthService(mongo.client, db, {
    now: () => clock,
    passwordParams: FAST,
    mailer,
    appBaseUrl: 'https://app.lulubiz.test',
    onMailError: (err) => mailErrors.push(err.message),
  });
});

describe('verificación de correo', () => {
  it('el registro envía un enlace, y confirmarlo marca el correo como verificado', async () => {
    const { userId } = await auth.registerTenant(company());
    const mail = mailer.last('marta@andina.co');
    expect(mail.subject).toMatch(/Confirma/);
    expect(mail.text).toContain('https://app.lulubiz.test/verificar-correo#token=');
    expect((await auth.getAccount(userId)).emailVerified).toBe(false);

    await auth.verifyEmail(tokenIn(mail));
    expect((await auth.getAccount(userId)).emailVerified).toBe(true);
  });

  it('el enlace sirve una sola vez, vence a las 24 horas y rechaza basura', async () => {
    await auth.registerTenant(company());
    const token = tokenIn(mailer.last('marta@andina.co'));
    await auth.verifyEmail(token);
    expect(await code(auth.verifyEmail(token))).toBe('EXPIRED_TOKEN');
    expect(await code(auth.verifyEmail('x'))).toBe('EXPIRED_TOKEN');
    expect(await code(auth.verifyEmail('a'.repeat(43)))).toBe('EXPIRED_TOKEN');

    await auth.registerTenant(company({ email: 'otra@andina.co' }));
    const late = tokenIn(mailer.last('otra@andina.co'));
    advance(25 * HOUR);
    expect(await code(auth.verifyEmail(late))).toBe('EXPIRED_TOKEN');
  });

  it('un token de otro propósito no sirve para verificar el correo', async () => {
    const { userId } = await auth.registerTenant(company());
    await auth.requestPasswordReset('marta@andina.co');
    const resetToken = tokenIn(mailer.last('marta@andina.co'));
    expect(await code(auth.verifyEmail(resetToken))).toBe('EXPIRED_TOKEN');
    expect((await auth.getAccount(userId)).emailVerified).toBe(false);
  });

  it('reenviar: no antes de un minuto, y no si ya está verificado', async () => {
    const { userId } = await auth.registerTenant(company());
    expect(await auth.resendVerification(userId)).toEqual({ sent: false, reason: 'TOO_SOON' });
    advance(61_000);
    expect((await auth.resendVerification(userId)).sent).toBe(true);
    await auth.verifyEmail(tokenIn(mailer.last('marta@andina.co')));
    expect(await auth.resendVerification(userId)).toEqual({ sent: false, reason: 'ALREADY_VERIFIED' });
  });

  it('un fallo del servidor de correo no impide registrarse, y queda anotado', async () => {
    const failing = { send: () => Promise.reject(new Error('SMTP caído')) };
    const broken = createAuthService(mongo.client, db, { passwordParams: FAST, mailer: failing, onMailError: (e) => mailErrors.push(e.message) });
    const { userId } = await broken.registerTenant(company({ email: 'x@andina.co' }));
    expect(userId).toBeDefined();
    expect(mailErrors).toContain('SMTP caído');
  });
});

describe('recuperación de contraseña', () => {
  beforeEach(async () => {
    await verifiedOwner();
  });

  it('un correo inexistente responde igual y no envía nada', async () => {
    const before = mailer.sent.length;
    expect(await auth.requestPasswordReset('nadie@andina.co')).toEqual({ ok: true });
    expect(mailer.sent.length).toBe(before);
  });

  it('con el enlace se cambia la contraseña: la nueva sirve, la vieja no, y avisa por correo', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    const mail = mailer.last('marta@andina.co');
    expect(mail.text).toContain('/restablecer-contrasena#token=');

    await auth.resetPassword(tokenIn(mail), NEW_PASSWORD);
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.login('marta@andina.co', NEW_PASSWORD))).toBeNull();
    expect(mailer.last('marta@andina.co').subject).toMatch(/cambió/);
  });

  it('cierra todas las sesiones abiertas y limpia un bloqueo', async () => {
    const { token } = await auth.login('marta@andina.co', PASSWORD);
    for (let i = 0; i < 5; i += 1) await code(auth.login('marta@andina.co', 'incorrecta-incorrecta'));
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBe('INVALID_CREDENTIALS'); // bloqueada

    await auth.requestPasswordReset('marta@andina.co');
    await auth.resetPassword(tokenIn(mailer.last('marta@andina.co')), NEW_PASSWORD);
    expect(await code(auth.verifySession(token))).toBe('INVALID_SESSION');
    expect(await code(auth.login('marta@andina.co', NEW_PASSWORD))).toBeNull();
  });

  it('el enlace sirve una vez y vence a la hora', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    const token = tokenIn(mailer.last('marta@andina.co'));
    await auth.resetPassword(token, NEW_PASSWORD);
    expect(await code(auth.resetPassword(token, 'una-tercera-clave-larga'))).toBe('EXPIRED_TOKEN');

    advance(2 * MINUTE);
    await auth.requestPasswordReset('marta@andina.co');
    const late = tokenIn(mailer.last('marta@andina.co'));
    advance(61 * MINUTE);
    expect(await code(auth.resetPassword(late, 'una-cuarta-clave-larga'))).toBe('EXPIRED_TOKEN');
  });

  it('una contraseña débil se rechaza sin gastar el enlace', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    const token = tokenIn(mailer.last('marta@andina.co'));
    expect(await code(auth.resetPassword(token, 'corta'))).toBe('PasswordError');
    await auth.resetPassword(token, NEW_PASSWORD);
  });

  it('pedir el enlace varias veces seguidas envía uno solo; uno nuevo invalida el anterior', async () => {
    const start = mailer.sent.length;
    await auth.requestPasswordReset('marta@andina.co');
    await auth.requestPasswordReset('marta@andina.co');
    await auth.requestPasswordReset('marta@andina.co');
    expect(mailer.sent.length - start).toBe(1);
    const first = tokenIn(mailer.last('marta@andina.co'));

    advance(2 * MINUTE);
    await auth.requestPasswordReset('marta@andina.co');
    const second = tokenIn(mailer.last('marta@andina.co'));
    expect(await code(auth.resetPassword(first, NEW_PASSWORD))).toBe('EXPIRED_TOKEN');
    expect(await code(auth.resetPassword(second, NEW_PASSWORD))).toBeNull();
  });

  it('dos usos simultáneos del mismo enlace: gana uno', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    const token = tokenIn(mailer.last('marta@andina.co'));
    const results = await Promise.all([auth.resetPassword(token, NEW_PASSWORD), auth.resetPassword(token, 'otra-clave-concurrente-9')].map(code));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'EXPIRED_TOKEN')).toHaveLength(1);
  });

  it('el token no queda guardado en claro', async () => {
    await auth.requestPasswordReset('marta@andina.co');
    const token = tokenIn(mailer.last('marta@andina.co'));
    const stored = await db.collection(COLLECTIONS.tokens).find({}).toArray();
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe('invitaciones', () => {
  let tenantId;
  let ownerId;

  beforeEach(async () => {
    ({ tenantId, userId: ownerId } = await verifiedOwner());
  });

  const actor = () => ({ userId: ownerId, tenantId });

  it('quien no verificó su correo no puede invitar', async () => {
    const other = await auth.registerTenant(company({ email: 'nuevo@andina.co', companyName: 'Otra SAS' }));
    expect(await code(auth.inviteMember({ userId: other.userId, tenantId: other.tenantId }, { email: 'x@y.co', role: 'viewer' }))).toBe('EMAIL_NOT_VERIFIED');
  });

  it('invita a una persona sin cuenta: recibe el enlace, ve la invitación y crea su cuenta al aceptar', async () => {
    const result = await auth.inviteMember(actor(), { email: 'Carlos@Contadores.co', role: 'accountant' });
    expect(result).toEqual({ invited: true, delivered: true });
    const mail = mailer.last('carlos@contadores.co');
    expect(mail.subject).toContain('Marta Ruiz');
    expect(mail.subject).toContain('Comercial Andina SAS');
    const token = tokenIn(mail);

    expect(await auth.getInvitation(token)).toEqual({
      email: 'carlos@contadores.co',
      role: 'accountant',
      company: 'Comercial Andina SAS',
      accountExists: false,
    });

    expect(await code(auth.acceptInvitation(token, { name: '', password: PASSWORD }))).toBe('VALIDATION');
    expect(await code(auth.acceptInvitation(token, { name: 'Carlos', password: 'corta' }))).toBe('PasswordError');

    const accepted = await auth.acceptInvitation(token, { name: 'Carlos Peña', password: NEW_PASSWORD });
    expect(accepted).toMatchObject({ tenantId, role: 'accountant', createdAccount: true });
    expect((await auth.getAccount(accepted.userId)).emailVerified).toBe(true);
    expect((await auth.login('carlos@contadores.co', NEW_PASSWORD)).userId.equals(accepted.userId)).toBe(true);
    expect(await code(auth.acceptInvitation(token, { name: 'Otro', password: NEW_PASSWORD }))).toBe('EXPIRED_TOKEN');
  });

  it('a alguien que ya tiene cuenta le exige haber iniciado sesión con ella', async () => {
    const existing = await auth.registerTenant(company({ email: 'lucia@andina.co', companyName: 'Lucía SAS' }));
    await auth.inviteMember(actor(), { email: 'lucia@andina.co', role: 'viewer' });
    const token = tokenIn(mailer.last('lucia@andina.co'));
    expect((await auth.getInvitation(token)).accountExists).toBe(true);

    expect(await code(auth.acceptInvitation(token, {}))).toBe('LOGIN_REQUIRED');
    expect(await code(auth.acceptInvitation(token, { sessionUserId: ownerId }))).toBe('LOGIN_REQUIRED');
    const accepted = await auth.acceptInvitation(token, { sessionUserId: existing.userId });
    expect(accepted).toMatchObject({ tenantId, role: 'viewer', createdAccount: false });
    expect((await auth.listMemberships(existing.userId)).map((m) => m.role).sort()).toEqual(['owner', 'viewer']);
    expect((await auth.getAccount(existing.userId)).emailVerified).toBe(true);
  });

  it('respeta los permisos: un lector no invita, un administrador no invita propietarios', async () => {
    await auth.registerTenant(company({ email: 'lector@andina.co', companyName: 'L' }));
    await auth.registerTenant(company({ email: 'admin@andina.co', companyName: 'A' }));
    await auth.addMember(actor(), { email: 'lector@andina.co', role: 'viewer' });
    await auth.addMember(actor(), { email: 'admin@andina.co', role: 'admin' });
    const readerId = (await auth.login('lector@andina.co', PASSWORD)).userId;
    const adminId = (await auth.login('admin@andina.co', PASSWORD)).userId;
    await auth.verifyEmail(tokenIn(mailer.last('admin@andina.co')));

    expect(await code(auth.inviteMember({ userId: readerId, tenantId }, { email: 'x@y.co', role: 'viewer' }))).toBe('FORBIDDEN');
    expect(await code(auth.inviteMember({ userId: adminId, tenantId }, { email: 'x@y.co', role: 'owner' }))).toBe('FORBIDDEN');
    expect(await code(auth.inviteMember({ userId: adminId, tenantId }, { email: 'x@y.co', role: 'viewer' }))).toBeNull();
  });

  it('valida el rol y el correo, y no invita a quien ya es miembro', async () => {
    expect(await code(auth.inviteMember(actor(), { email: 'a@b.co', role: 'jefe' }))).toBe('VALIDATION');
    expect(await code(auth.inviteMember(actor(), { email: 'sin-arroba', role: 'viewer' }))).toBe('VALIDATION');
    expect(await code(auth.inviteMember(actor(), { email: 'marta@andina.co', role: 'viewer' }))).toBe('ALREADY_MEMBER');
  });

  it('una invitación nueva a la misma persona invalida la anterior', async () => {
    await auth.inviteMember(actor(), { email: 'carlos@contadores.co', role: 'viewer' });
    const first = tokenIn(mailer.last('carlos@contadores.co'));
    await auth.inviteMember(actor(), { email: 'carlos@contadores.co', role: 'accountant' });
    const second = tokenIn(mailer.last('carlos@contadores.co'));
    expect(await code(auth.getInvitation(first))).toBe('EXPIRED_TOKEN');
    expect((await auth.getInvitation(second)).role).toBe('accountant');
  });

  it('vence a los 7 días', async () => {
    await auth.inviteMember(actor(), { email: 'carlos@contadores.co', role: 'viewer' });
    const token = tokenIn(mailer.last('carlos@contadores.co'));
    advance(8 * 24 * HOUR);
    expect(await code(auth.getInvitation(token))).toBe('EXPIRED_TOKEN');
  });

  it('si el correo no sale, la invitación existe y lo informa a quien invita', async () => {
    const failing = { send: () => Promise.reject(new Error('SMTP caído')) };
    const broken = createAuthService(mongo.client, db, { now: () => clock, passwordParams: FAST, mailer: failing, onMailError: () => {} });
    expect(await broken.inviteMember(actor(), { email: 'carlos@contadores.co', role: 'viewer' })).toEqual({ invited: true, delivered: false });
  });

  it('si el evento de auditoría falla, la invitación no se crea', async () => {
    await expect(
      auth.inviteMember(actor(), { email: 'carlos@contadores.co', role: 'viewer' }, { inTx: () => Promise.reject(new Error('auditoría caída')) }),
    ).rejects.toThrow(/auditoría caída/);
    expect(await db.collection(COLLECTIONS.tokens).countDocuments({ purpose: 'invite' })).toBe(0);
  });

  it('una invitación a otra empresa no sirve para esta (el token lleva su empresa)', async () => {
    const other = await verifiedOwner('beto@otra.co', { companyName: 'Otra SAS' });
    await auth.inviteMember({ userId: other.userId, tenantId: other.tenantId }, { email: 'carlos@contadores.co', role: 'viewer' });
    const accepted = await auth.acceptInvitation(tokenIn(mailer.last('carlos@contadores.co')), { name: 'Carlos', password: NEW_PASSWORD });
    expect(accepted.tenantId.equals(other.tenantId)).toBe(true);
    expect(accepted.tenantId.equals(tenantId)).toBe(false);
    expect(new ObjectId(accepted.userId)).toBeDefined();
  });
});
