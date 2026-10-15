import { describe, it, expect, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, User } from '../models';
import { Session } from '../security/sessions';
import { UserRole } from '../types';
import { hashPassword } from '../security/password';
import { makeUser, makeBusiness, makePricingConfig, authHeader, counterAuthHeader } from './factories';

/**
 * Entrada como responsable con contraseña desde el mostrador (2026-10-13).
 *
 * El panel siempre arranca en el mostrador; quien no tiene PIN entra con
 * correo + contraseña (+ 2FA). Hallazgo ALTO de zipp-security: antes eso
 * pasaba por `/auth/login` y dejaba en el PC del local una sesión completa
 * de 7 días. Lo que se prueba: que la sesión sale corta y atada al
 * mostrador, que sí sirve para lo de la cuenta (crear PIN, 2FA) — si no,
 * el dueño quedaría encerrado —, y que dar acceso a otro en el Equipo pide
 * la contraseña otra vez.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123';

let owner: any;
let business: any;
const bid = () => business._id.toString();

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueño Daniel' });
  business = await makeBusiness(owner._id);
});

const elevatePassword = async (person: any, password = PASSWORD, counterHeader?: Record<string, string>) =>
  request(app)
    .post(`${API}/auth/counter/elevate-password`)
    .set(counterHeader ?? (await counterAuthHeader(owner)))
    .send({ businessId: bid(), email: person.email, password });

const bearer = (res: request.Response) => ({ Authorization: `Bearer ${res.body.data.accessToken}` });
const code = (res: request.Response) => res.body.code ?? res.body.error?.code;

describe('Entrar con contraseña desde el mostrador', () => {
  it('el dueño sin PIN entra: sesión corta, atada al mostrador y con alcance completo', async () => {
    const res = await elevatePassword(owner);
    expect(res.status).toBe(200);

    const perms = await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(bearer(res));
    expect(perms.body.data.role).toBe('owner');

    const session = await Session.findOne({ userId: owner._id.toString(), elevatedFrom: { $ne: null } });
    expect(session!.elevatedBusinessId).toBeNull();
    expect(session!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
    expect(session!.absoluteExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);
  });

  it('desde ella se activa el 2FA: el dueño no queda encerrado en el mostrador', async () => {
    const res = await elevatePassword(owner);
    const setup = await request(app).post(`${API}/auth/2fa/setup`).set(bearer(res)).send({ currentPassword: PASSWORD });
    expect(setup.status).toBe(200);
  });

  it('volver al mostrador (drop) la cierra', async () => {
    const res = await elevatePassword(owner);
    expect((await request(app).post(`${API}/auth/counter/drop`).set(bearer(res))).status).toBe(200);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(bearer(res))).status).toBe(401);
  });

  it('muere con la sesión del mostrador', async () => {
    const res = await elevatePassword(owner);
    await Session.updateMany({ userId: owner._id.toString(), scope: 'counter' }, { $set: { isActive: false } });
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(bearer(res))).status).toBe(401);
  });

  it('contraseña equivocada: 401 y no hay sesión', async () => {
    const res = await elevatePassword(owner, 'No.Es.Esta999');
    expect(res.status).toBe(401);
    expect(await Session.countDocuments({ userId: owner._id.toString(), elevatedFrom: { $ne: null } })).toBe(0);
  });

  it('un empleado con su contraseña correcta no entra: misma respuesta que una mala', async () => {
    const pepe = await makeUser({ role: UserRole.BUSINESS, name: 'Empleado Pepe' });
    await BusinessStaff.create({ businessId: business._id, userId: pepe._id, role: BusinessRole.EMPLOYEE, status: 'active', isActive: true });
    const res = await elevatePassword(pepe);
    expect(res.status).toBe(401);
  });

  it('desde una sesión completa no se usa: NOT_COUNTER_SESSION', async () => {
    const res = await elevatePassword(owner, PASSWORD, await authHeader(owner));
    expect(res.status).toBe(400);
    expect(code(res)).toBe('NOT_COUNTER_SESSION');
  });
});

describe('Con 2FA', () => {
  async function enroll2fa(user: any): Promise<string> {
    const header = await authHeader(user);
    const setup = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: PASSWORD }).expect(200);
    const { secret } = setup.body.data;
    await request(app).post(`${API}/auth/2fa/verify`).set(header)
      .send({ token: speakeasy.totp({ secret, encoding: 'base32' }) }).expect(200);
    return secret;
  }
  const nextCode = (secret: string) =>
    speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });

  it('pide el código y el segundo paso abre la entrada corta', async () => {
    const secret = await enroll2fa(owner);
    const counterHeader = await counterAuthHeader(owner);
    const first = await elevatePassword(owner, PASSWORD, counterHeader);
    expect(first.status).toBe(200);
    expect(first.body.data.requiresTOTP).toBe(true);

    const second = await request(app).post(`${API}/auth/counter/elevate-password/totp`).set(counterHeader)
      .send({ businessId: bid(), challengeToken: first.body.data.challengeToken, code: nextCode(secret) });
    expect(second.status).toBe(200);
    const session = await Session.findOne({ userId: owner._id.toString(), elevatedFrom: { $ne: null } });
    expect(session).not.toBeNull();
  });

  it('ese reto no se canjea en /auth/2fa/challenge por una sesión de 7 días', async () => {
    const secret = await enroll2fa(owner);
    const first = await elevatePassword(owner);
    const res = await request(app).post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken: first.body.data.challengeToken, code: nextCode(secret) });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('MFA_CHALLENGE_INVALID');
  });

  it('el reto de un login normal no se convierte en entrada de mostrador', async () => {
    const secret = await enroll2fa(owner);
    const normal = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD });
    expect(normal.body.data.requiresTOTP).toBe(true);
    const res = await request(app).post(`${API}/auth/counter/elevate-password/totp`).set(await counterAuthHeader(owner))
      .send({ businessId: bid(), challengeToken: normal.body.data.challengeToken, code: nextCode(secret) });
    expect(res.status).toBe(400);
    expect(code(res)).toBe('MFA_CHALLENGE_INVALID');
  });

});

describe('Equipo desde una entrada de mostrador', () => {
  const invite = (header: Record<string, string>, extra: Record<string, unknown> = {}) =>
    request(app).post(`${API}/businesses/${bid()}/staff`).set(header).send({ phone: '3001112233', role: 'manager', ...extra });

  it('invitar sin la contraseña se rechaza y cierra la entrada', async () => {
    const res = await elevatePassword(owner);
    const inv = await invite(bearer(res));
    expect(inv.status).toBe(401);
    expect(code(inv)).toBe('REAUTH_FAILED');
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(bearer(res))).status).toBe(401);
  });

  it('con la contraseña correcta, invita', async () => {
    const res = await elevatePassword(owner);
    expect((await invite(bearer(res), { currentPassword: PASSWORD })).status).toBe(201);
  });

  it('cambiar el papel también la pide; suspender no', async () => {
    const ana = await makeUser({ role: UserRole.BUSINESS, name: 'Administradora Ana' });
    const row = await BusinessStaff.create({ businessId: business._id, userId: ana._id, role: BusinessRole.EMPLOYEE, status: 'active', isActive: true });
    const res = await elevatePassword(owner);
    const url = `${API}/businesses/${bid()}/staff/${row._id}`;

    expect((await request(app).patch(url).set(bearer(res)).send({ suspended: true })).status).toBe(200);
    expect((await request(app).patch(url).set(bearer(res)).send({ role: 'manager', currentPassword: PASSWORD })).status).toBe(200);
  });

  it('una sesión completa normal sigue invitando sin pedirla', async () => {
    expect((await invite(await authHeader(owner))).status).toBe(201);
  });
});

describe('Puerta de la contraseña desde el mostrador (A1, 2026-10-14)', () => {
  const COUNTER_KEY = 'Mostrador.Local456';

  it('con un PIN en el negocio y sin 2FA ni clave de mostrador, se rechaza con la contraseña buena', async () => {
    await User.updateOne({ _id: owner._id }, { counterPinSetAt: new Date() });
    const res = await elevatePassword(owner);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('COUNTER_PASSWORD_DISABLED');
    expect(await Session.countDocuments({ userId: owner._id.toString(), elevatedFrom: { $ne: null } })).toBe(0);
  });

  it('la puerta cerrada no sirve de oráculo: contraseña equivocada sigue siendo 401', async () => {
    await User.updateOne({ _id: owner._id }, { counterPinSetAt: new Date() });
    const res = await elevatePassword(owner, 'No.Es.Esta999');
    expect(res.status).toBe(401);
  });

  it('con PIN y 2FA activo, la contraseña abre la puerta (pide el código)', async () => {
    const header = await authHeader(owner);
    const setup = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: PASSWORD }).expect(200);
    await request(app).post(`${API}/auth/2fa/verify`).set(header)
      .send({ token: speakeasy.totp({ secret: setup.body.data.secret, encoding: 'base32' }) }).expect(200);
    await User.updateOne({ _id: owner._id }, { counterPinSetAt: new Date() });

    const first = await elevatePassword(owner);
    expect(first.status).toBe(200);
    expect(first.body.data.requiresTOTP).toBe(true);

    const second = await request(app).post(`${API}/auth/counter/elevate-password/totp`).set(await counterAuthHeader(owner))
      .send({
        businessId: bid(),
        challengeToken: first.body.data.challengeToken,
        code: speakeasy.totp({ secret: setup.body.data.secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 }),
      });
    expect(second.status).toBe(200);
  });

  it('con clave de mostrador fijada, la contraseña personal abre la puerta aunque haya PIN y no haya 2FA', async () => {
    await User.updateOne({ _id: owner._id }, { counterPinSetAt: new Date(), counterPasswordHash: await hashPassword(COUNTER_KEY), counterPasswordSetAt: new Date() });
    const res = await elevatePassword(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('con clave de mostrador fijada, la clave del mostrador NO sube a responsable', async () => {
    await User.updateOne({ _id: owner._id }, { counterPasswordHash: await hashPassword(COUNTER_KEY), counterPasswordSetAt: new Date() });
    const res = await elevatePassword(owner, COUNTER_KEY);
    expect(res.status).toBe(401);
    expect(await Session.countDocuments({ userId: owner._id.toString(), elevatedFrom: { $ne: null } })).toBe(0);
  });

  it('sin PIN en el negocio sigue siendo el arranque: entra', async () => {
    expect((await elevatePassword(owner)).status).toBe(200);
  });
});
