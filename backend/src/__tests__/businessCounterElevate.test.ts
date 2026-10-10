import { describe, it, expect, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole } from '../models';
import { Session } from '../security/sessions';
import { UserRole } from '../types';
import { makeUser, makeBusiness, makePricingConfig, authHeader, counterAuthHeader } from './factories';

/**
 * Del mostrador a Representante legal / Administrador (decisión 2026-10-09).
 *
 * La sesión de mostrador topa todo al papel Empleado; `POST
 * /auth/counter/elevate` abre una sesión aparte, corta, con la identidad
 * personal de quien la pide. Lo que importa probar es lo que NO debe pasar:
 * elevar sin 2FA siendo propietario, elevar siendo empleado, elevar a un
 * negocio ajeno, o que la elevación salga como una sesión larga normal.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123'; // la de `makeUser` por defecto

async function enroll(user: any): Promise<string> {
  const header = await authHeader(user);
  const setup = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: PASSWORD }).expect(200);
  const { secret } = setup.body.data;
  await request(app)
    .post(`${API}/auth/2fa/verify`)
    .set(header)
    .send({ token: speakeasy.totp({ secret, encoding: 'base32' }) })
    .expect(200);
  return secret;
}

/** Un código del paso siguiente: `verify` ya gastó el actual y no se repite. */
const nextCode = (secret: string) =>
  speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });

let owner: any;
let business: any;
const bid = () => business._id.toString();

const elevate = async (counterOf: any, body: Record<string, unknown>) =>
  request(app).post(`${API}/auth/counter/elevate`).set(await counterAuthHeader(counterOf)).send({ businessId: bid(), ...body });

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
});

describe('Elevar desde el mostrador', () => {
  it('el representante legal con 2FA eleva y recibe una sesión completa y corta', async () => {
    const secret = await enroll(owner);
    const res = await elevate(owner, { email: owner.email, password: PASSWORD, totpToken: nextCode(secret) });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();

    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('owner');

    const session = await Session.findOne({ userId: owner._id.toString(), elevatedFrom: { $ne: null } });
    expect(session).not.toBeNull();
    expect(session!.scope).toBe('full');
    // 2 h como máximo, no los días de una sesión normal.
    expect(session!.absoluteExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);
  });

  it('el representante legal sin 2FA no eleva: TWO_FACTOR_SETUP_REQUIRED', async () => {
    const res = await elevate(owner, { email: owner.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });

  it('con 2FA activo, sin código no hay reto: pide el código en la misma petición', async () => {
    await enroll(owner);
    const res = await elevate(owner, { email: owner.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error?.code).toBe('MFA_REQUIRED');
    expect(res.body.data?.challengeToken).toBeUndefined();
  });

  it('un administrador del negocio eleva con su propia cuenta', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER });

    const res = await elevate(owner, { email: manager.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('manager');
  });

  it('un empleado no eleva aunque su contraseña sea correcta', async () => {
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE });
    const res = await elevate(owner, { email: employee.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('el propietario de OTRO negocio no eleva en este', async () => {
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(stranger._id);
    await enroll(stranger);
    const res = await elevate(owner, { email: stranger.email, password: PASSWORD, totpToken: '000000' });
    expect(res.status).toBe(401);
  });

  it('contraseña equivocada: 401 sin decir si la cuenta existe', async () => {
    const res = await elevate(owner, { email: owner.email, password: 'otra-cosa' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales inválidas');
  });

  it('desde una sesión completa no se eleva: NOT_COUNTER_SESSION', async () => {
    const res = await request(app)
      .post(`${API}/auth/counter/elevate`)
      .set(await authHeader(owner))
      .send({ businessId: bid(), email: owner.email, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe('NOT_COUNTER_SESSION');
  });
});

describe('Volver al mostrador', () => {
  it('drop revoca la sesión elevada y su token deja de servir', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER });
    const elevated = await elevate(owner, { email: manager.email, password: PASSWORD });
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };

    expect((await request(app).post(`${API}/auth/counter/drop`).set(header)).status).toBe(200);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(401);
  });

  it('refrescar el token no alarga la inactividad de la sesión elevada más allá de 15 min', async () => {
    const manager = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER });
    const elevated = await elevate(owner, { email: manager.email, password: PASSWORD });

    const refreshed = await request(app)
      .post(`${API}/auth/refresh-token`)
      .send({ refreshToken: elevated.body.data.refreshToken });
    expect(refreshed.status).toBe(200);

    const session = await Session.findOne({ userId: manager._id.toString(), elevatedFrom: { $ne: null } });
    expect(session!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });

  it('drop sobre una sesión que no es elevada no la cierra', async () => {
    const header = await authHeader(owner);
    const res = await request(app).post(`${API}/auth/counter/drop`).set(header);
    expect(res.status).toBe(400);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(200);
  });
});

describe('Login con surface business-counter', () => {
  const login = (body: Record<string, unknown>) => request(app).post(`${API}/auth/login`).send(body);

  it('una cuenta de comercio abre sesión de mostrador: my-permissions dice employee', async () => {
    const res = await login({ email: owner.email, password: PASSWORD, surface: 'business-counter' });
    expect(res.status).toBe(200);
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('employee');
  });

  it('sin surface, el mismo login sigue siendo de propietario', async () => {
    const res = await login({ email: owner.email, password: PASSWORD });
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('owner');
  });

  it('con 2FA, el reto conserva el alcance de mostrador', async () => {
    const secret = await enroll(owner);
    const first = await login({ email: owner.email, password: PASSWORD, surface: 'business-counter' });
    expect(first.body.data.requiresTOTP).toBe(true);
    const second = await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken: first.body.data.challengeToken, code: nextCode(secret) });
    expect(second.status).toBe(200);
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${second.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('employee');
  });

  it('un reto abierto sin surface no hereda el alcance de uno anterior con surface', async () => {
    const secret = await enroll(owner);
    await login({ email: owner.email, password: PASSWORD, surface: 'business-counter' });
    const plain = await login({ email: owner.email, password: PASSWORD });
    const second = await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken: plain.body.data.challengeToken, code: nextCode(secret) });
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${second.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('owner');
  });
});
