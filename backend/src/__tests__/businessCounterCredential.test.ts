import { describe, it, expect, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Notification, SecurityEvent, SecurityEventType, User } from '../models';
import { AuditAction, AuditLog, Session, OTP_SLOTS, otpSetFields } from '../security';
import { hashPassword } from '../security/password';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makePricingConfig, makeStaff, authHeader, counterAuthHeader } from './factories';

/**
 * Clave del mostrador (decisión 2026-10-15): una credencial del local,
 * SEPARADA de la contraseña personal del dueño.
 *
 * Lo que se prueba es lo que NO debe pasar: que alguien distinto del dueño la
 * fije, que se fije sin rotar la personal ya compartida, que las dos sean la
 * misma, que la personal siga abriendo el panel del local una vez fijada, que
 * la clave del mostrador abra otra cosa que un mostrador, o que rotarla deje
 * vivas las sesiones del equipo.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123'; // la de `makeUser` por defecto
const NEW_PASSWORD = 'Personal.Nueva789';
const COUNTER_KEY = 'Mostrador.Local456';
const code = (res: request.Response) => res.body.code ?? res.body.error?.code;

let owner: any;
let business: any;
const bid = () => business._id.toString();

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueño Daniel' });
  business = await makeBusiness(owner._id);
});

const putCounterPassword = async (
  body: Record<string, unknown>,
  header?: Record<string, string>
) => request(app).put(`${API}/auth/counter/password`).set(header ?? (await authHeader(owner))).send(body);

/** La primera vez: clave del mostrador + rotación de la personal. */
const setFirstTime = async (extra: Record<string, unknown> = {}) =>
  putCounterPassword({ currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD, ...extra });

const login = (password: string, email = owner.email, extra: Record<string, unknown> = {}) =>
  request(app).post(`${API}/auth/login`).send({ email, password, ...extra });

const bearer = (res: request.Response) => ({ Authorization: `Bearer ${res.body.data.accessToken}` });
const myRole = async (header: Record<string, string>) =>
  (await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).body.data.role;
const permissionsStatus = async (header: Record<string, string>) =>
  (await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status;
const events = (userId: any, type: SecurityEventType) => SecurityEvent.countDocuments({ userId, type });

async function enroll2fa(user: any): Promise<string> {
  const header = await authHeader(user);
  const setup = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: PASSWORD }).expect(200);
  const { secret } = setup.body.data;
  await request(app).post(`${API}/auth/2fa/verify`).set(header)
    .send({ token: speakeasy.totp({ secret, encoding: 'base32' }) }).expect(200);
  return secret;
}

describe('PUT /auth/counter/password: quién y cómo', () => {
  it('solo el dueño: un administrador del negocio recibe 403 y no se guarda nada', async () => {
    const ana = await makeUser({ role: UserRole.BUSINESS, name: 'Administradora Ana' });
    await BusinessStaff.create({ businessId: business._id, userId: ana._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });

    const res = await putCounterPassword(
      { currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD },
      await authHeader(ana)
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('BUSINESS_PERMISSION_DENIED');
    const after = await User.findById(ana._id).select('+counterPasswordHash');
    expect(after!.counterPasswordHash).toBeUndefined();
  });

  it('un cliente tampoco', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const res = await putCounterPassword(
      { currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD },
      await authHeader(client)
    );
    expect(res.status).toBe(403);
  });

  it('sin sesión, 401', async () => {
    const res = await request(app).put(`${API}/auth/counter/password`).send({ currentPassword: PASSWORD, counterPassword: COUNTER_KEY });
    expect(res.status).toBe(401);
  });

  it('desde el mostrador, 403 COUNTER_SESSION_FORBIDDEN', async () => {
    const res = await putCounterPassword(
      { currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD },
      await counterAuthHeader(owner)
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('COUNTER_SESSION_FORBIDDEN');
  });

  it('desde una sesión elevada con PIN, 403: es la cuenta del dueño en un equipo compartido', async () => {
    await User.updateOne({ _id: owner._id }, { counterPinHash: await hashPassword('482915'), counterPinSetAt: new Date() });
    const elevated = await request(app)
      .post(`${API}/auth/counter/elevate`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: bid(), userId: owner._id.toString(), pin: '482915' })
      .expect(200);
    const res = await putCounterPassword(
      { currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD },
      bearer(elevated)
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('COUNTER_SESSION_FORBIDDEN');
  });

  it('tener PIN no impide fijarla desde la sesión completa', async () => {
    await User.updateOne({ _id: owner._id }, { counterPinHash: await hashPassword('482915'), counterPinSetAt: new Date() });
    expect((await setFirstTime()).status).toBe(200);
  });

  it('contraseña actual equivocada: 401 REAUTH_FAILED', async () => {
    const res = await setFirstTime({ currentPassword: 'Equivocada.123' });
    expect(res.status).toBe(401);
    expect(code(res)).toBe('REAUTH_FAILED');
    expect((await User.findById(owner._id))!.counterPasswordSetAt).toBeNull();
  });

  it('la primera vez exige `newPassword`: la personal ya la conoce el local', async () => {
    const res = await putCounterPassword({ currentPassword: PASSWORD, counterPassword: COUNTER_KEY });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('NEW_PASSWORD_REQUIRED');
    const after = await User.findById(owner._id).select('+counterPasswordHash');
    expect(after!.counterPasswordHash).toBeUndefined();
  });

  it('rechaza una clave igual a la contraseña actual', async () => {
    const res = await setFirstTime({ counterPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('COUNTER_PASSWORD_SAME_AS_PERSONAL');
  });

  it('rechaza una clave igual a la contraseña nueva', async () => {
    const res = await setFirstTime({ counterPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('COUNTER_PASSWORD_SAME_AS_PERSONAL');
  });

  it('rechaza una contraseña personal nueva igual a la actual', async () => {
    const res = await setFirstTime({ newPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('PASSWORD_UNCHANGED');
  });

  it('rechaza claves débiles', async () => {
    const weakCounter = await setFirstTime({ counterPassword: 'corta' });
    expect(weakCounter.status).toBe(400);
    expect(code(weakCounter)).toBe('COUNTER_PASSWORD_WEAK');
    const weakNew = await setFirstTime({ newPassword: 'corta' });
    expect(weakNew.status).toBe(400);
    expect(code(weakNew)).toBe('PASSWORD_WEAK');
    expect((await User.findById(owner._id))!.counterPasswordSetAt).toBeNull();
  });
});

describe('Después de fijarla la primera vez', () => {
  it('guarda el hash (nunca en claro), rota la personal y corta todas las sesiones', async () => {
    const header = await authHeader(owner);
    const res = await putCounterPassword(
      { currentPassword: PASSWORD, counterPassword: COUNTER_KEY, newPassword: NEW_PASSWORD },
      header
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ hasCounterPassword: true, personalPasswordChanged: true });
    expect(JSON.stringify(res.body)).not.toContain(COUNTER_KEY);

    const stored = await User.findById(owner._id).select('+counterPasswordHash +password');
    expect(stored!.counterPasswordHash).toMatch(/^\$argon2/);
    expect(stored!.counterPasswordHash).not.toContain(COUNTER_KEY);
    expect(stored!.counterPasswordSetAt).toBeInstanceOf(Date);
    expect(await stored!.comparePassword(NEW_PASSWORD)).toBe(true);
    expect(await stored!.comparePassword(PASSWORD)).toBe(false);

    // La sesión de quien la fijó murió con la rotación de la personal.
    expect((await request(app).get(`${API}/auth/me`).set(header)).status).toBe(401);
  });

  it('el hash no sale por ninguna respuesta; la fecha sí, en `/auth/me` y en el login', async () => {
    await setFirstTime();
    const loggedIn = await login(COUNTER_KEY).expect(200);
    const me = await request(app).get(`${API}/auth/me`).set(bearer(loggedIn)).expect(200);
    expect(me.body.data.user.counterPasswordSetAt).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toContain('counterPasswordHash');
    expect(JSON.stringify(loggedIn.body)).not.toContain('counterPasswordHash');
    expect(loggedIn.body.data.user.counterPasswordSetAt).toBeTruthy();
  });

  it('antes de fijarla, `/auth/me` dice que no hay clave (null)', async () => {
    const me = await request(app).get(`${API}/auth/me`).set(await authHeader(owner)).expect(200);
    expect(me.body.data.user.counterPasswordSetAt).toBeNull();
  });

  it('la contraseña personal ya no abre el panel del local: 401 igual que una equivocada', async () => {
    await setFirstTime();
    for (const password of [NEW_PASSWORD, PASSWORD]) {
      const res = await login(password);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Credenciales inválidas');
    }
    expect(await Session.countDocuments({ userId: owner._id.toString(), isActive: true })).toBe(0);
  });

  it('la clave del mostrador abre una sesión de mostrador con método counter_credential', async () => {
    await setFirstTime();
    const res = await login(COUNTER_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.requiresTOTP).toBeUndefined();
    expect(await myRole(bearer(res))).toBe('employee');
    const session = await Session.findOne({ userId: owner._id.toString(), isActive: true });
    expect(session!.scope).toBe('counter');
    expect(session!.authMethod).toBe('counter_credential');
    expect(session!.elevatedFrom).toBeNull();
  });

  it('con 2FA activo, la clave del mostrador no pide TOTP y sigue siendo solo mostrador', async () => {
    await enroll2fa(owner);
    await setFirstTime();
    const res = await login(COUNTER_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.requiresTOTP).toBeUndefined();
    expect(res.body.data.accessToken).toBeTruthy();
    expect(await myRole(bearer(res))).toBe('employee');
    // Y lo de la cuenta (2FA, contraseña...) sigue cerrado al mostrador.
    const disable = await request(app).post(`${API}/auth/2fa/disable`).set(bearer(res)).send({ token: '000000' });
    expect(disable.status).toBe(403);
    expect(code(disable)).toBe('COUNTER_SESSION_FORBIDDEN');
  });

  it('una clave equivocada cuenta como intento fallido y da 401', async () => {
    await setFirstTime();
    const res = await login('Otra.Clave.999');
    expect(res.status).toBe(401);
    expect(await events(owner._id, SecurityEventType.LOGIN_FAILED)).toBe(1);
  });

  it('`passwordExpiresAt` es de la personal: no apaga la clave del mostrador', async () => {
    await setFirstTime();
    await User.updateOne({ _id: owner._id }, { passwordExpiresAt: new Date(Date.now() - 1000) });
    expect((await login(COUNTER_KEY)).status).toBe(200);
  });

  it('la clave del mostrador no sube a responsable (elevate-password usa la personal)', async () => {
    await setFirstTime();
    const counter = await login(COUNTER_KEY).expect(200);
    const asClave = await request(app).post(`${API}/auth/counter/elevate-password`).set(bearer(counter))
      .send({ businessId: bid(), email: owner.email, password: COUNTER_KEY });
    expect(asClave.status).toBe(401);
    const asPersonal = await request(app).post(`${API}/auth/counter/elevate-password`).set(bearer(counter))
      .send({ businessId: bid(), email: owner.email, password: NEW_PASSWORD });
    expect(asPersonal.status).toBe(200);
  });

  it('avisa al dueño y deja auditoría y evento de seguridad', async () => {
    await setFirstTime();
    const notice = await Notification.findOne({ userId: owner._id, 'data.event': 'counter_password_changed' });
    expect(notice).not.toBeNull();
    expect(await AuditLog.countDocuments({ action: AuditAction.PASSWORD_CHANGE, entityId: owner._id.toString() })).toBe(1);
    expect(await events(owner._id, SecurityEventType.PASSWORD_CHANGED)).toBe(1);
  });
});

describe('Mientras no exista (fallback)', () => {
  it('/auth/login acepta la contraseña personal, topada a mostrador', async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    expect(await myRole(bearer(res))).toBe('employee');
    expect((await Session.findOne({ userId: owner._id.toString() }))!.authMethod).toBe('password');
  });

  it('con 2FA activo, la personal sigue pidiendo TOTP', async () => {
    await enroll2fa(owner);
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.requiresTOTP).toBe(true);
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('una contraseña personal temporal vencida sigue rechazándose', async () => {
    await User.updateOne({ _id: owner._id }, { passwordExpiresAt: new Date(Date.now() - 1000) });
    const res = await login(PASSWORD);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('TEMPORARY_PASSWORD_EXPIRED');
  });

  it('otra cuenta de comercio (un administrador) entra con su contraseña, a mostrador, aunque el dueño ya tenga clave', async () => {
    await setFirstTime();
    const ana = await makeUser({ role: UserRole.BUSINESS, name: 'Administradora Ana' });
    await BusinessStaff.create({ businessId: business._id, userId: ana._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
    const res = await login(PASSWORD, ana.email);
    expect(res.status).toBe(200);
    expect(await myRole(bearer(res))).toBe('employee');
  });
});

describe('Rotaciones siguientes', () => {
  /** Estado: clave fijada, y un mostrador abierto con ella + una entrada elevada con la personal. */
  async function withOpenCounterAndElevated() {
    await setFirstTime();
    const counter = await login(COUNTER_KEY).expect(200);
    const elevated = await request(app).post(`${API}/auth/counter/elevate-password`).set(bearer(counter))
      .send({ businessId: bid(), email: owner.email, password: NEW_PASSWORD }).expect(200);
    return { counter, elevated };
  }

  it('cambiar solo la clave revoca los mostradores y las entradas elevadas, no la sesión completa del dueño', async () => {
    const { counter, elevated } = await withOpenCounterAndElevated();
    expect(await permissionsStatus(bearer(counter))).toBe(200);
    expect(await permissionsStatus(bearer(elevated))).toBe(200);

    const full = await authHeader(owner);
    const res = await putCounterPassword({ currentPassword: NEW_PASSWORD, counterPassword: 'Mostrador.Otra789' }, full);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ personalPasswordChanged: false });

    expect(await permissionsStatus(bearer(counter))).toBe(401);
    expect(await permissionsStatus(bearer(elevated))).toBe(401);
    // La sesión completa del dueño sigue viva: rotar la clave no lo expulsa.
    expect((await request(app).get(`${API}/auth/me`).set(full)).status).toBe(200);
  });

  it('la clave vieja deja de servir y la nueva sirve', async () => {
    await setFirstTime();
    await putCounterPassword({ currentPassword: NEW_PASSWORD, counterPassword: 'Mostrador.Otra789' }).then((r) => expect(r.status).toBe(200));
    expect((await login(COUNTER_KEY)).status).toBe(401);
    expect((await login('Mostrador.Otra789')).status).toBe(200);
  });

  it('en una rotación `newPassword` es opcional, y si llega también rota la personal y corta todo', async () => {
    await setFirstTime();
    const full = await authHeader(owner);
    const res = await putCounterPassword(
      { currentPassword: NEW_PASSWORD, counterPassword: 'Mostrador.Otra789', newPassword: 'Personal.Otra321' },
      full
    );
    expect(res.status).toBe(200);
    expect(res.body.data.personalPasswordChanged).toBe(true);
    expect((await request(app).get(`${API}/auth/me`).set(full)).status).toBe(401);
  });

  it('también aquí rechaza una clave igual a la contraseña personal actual', async () => {
    await setFirstTime();
    const res = await putCounterPassword({ currentPassword: NEW_PASSWORD, counterPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('COUNTER_PASSWORD_SAME_AS_PERSONAL');
  });
});

describe('La contraseña personal tampoco puede igualar la clave del mostrador', () => {
  it('change-password la rechaza', async () => {
    await setFirstTime();
    const res = await request(app).post(`${API}/auth/change-password`).set(await authHeader(owner))
      .send({ currentPassword: NEW_PASSWORD, newPassword: COUNTER_KEY });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('PASSWORD_SAME_AS_COUNTER');
    const stored = await User.findById(owner._id).select('+password');
    expect(await stored!.comparePassword(NEW_PASSWORD)).toBe(true);
  });

  it('change-password con otra contraseña sigue funcionando', async () => {
    await setFirstTime();
    const res = await request(app).post(`${API}/auth/change-password`).set(await authHeader(owner))
      .send({ currentPassword: NEW_PASSWORD, newPassword: 'Otra.Personal321' });
    expect(res.status).toBe(200);
  });

  it('reset-password la rechaza, y solo tras validar el OTP (no es un oráculo)', async () => {
    await setFirstTime();
    await User.updateOne({ _id: owner._id }, { $set: otpSetFields(OTP_SLOTS.phone, '123456') });

    // Sin OTP válido, la respuesta no depende de si la contraseña es la clave.
    const noOtp = await request(app).post(`${API}/auth/reset-password`)
      .send({ phone: owner.phone, otpCode: '654321', password: COUNTER_KEY });
    expect(noOtp.status).toBe(400);
    expect(code(noOtp)).toBe('OTP_INVALID');

    const res = await request(app).post(`${API}/auth/reset-password`)
      .send({ phone: owner.phone, otpCode: '123456', password: COUNTER_KEY });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('PASSWORD_SAME_AS_COUNTER');
  });
});

describe('Soporte', () => {
  it('restablecer la contraseña desde soporte borra la clave del mostrador: la temporal vuelve a abrir /login', async () => {
    await setFirstTime();
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const reset = await request(app)
      .post(`${API}/admin/users/${owner._id}/reset-password`)
      .set(await authHeader(superAdmin))
      .expect(200);
    const temporaryPassword = reset.body.data.temporaryPassword;
    expect(temporaryPassword).toBeTruthy();

    const stored = await User.findById(owner._id).select('+counterPasswordHash');
    expect(stored!.counterPasswordHash).toBeUndefined();
    expect(stored!.counterPasswordSetAt).toBeNull();

    const res = await login(temporaryPassword);
    expect(res.status).toBe(200);
    expect(await myRole(bearer(res))).toBe('employee');
  });
});
