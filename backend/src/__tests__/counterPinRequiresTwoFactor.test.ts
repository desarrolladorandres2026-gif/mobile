import { describe, it, expect, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, User } from '../models';
import { Session } from '../security/sessions';
import { UserRole } from '../types';
import { CounterPinAttempt } from '../services/counterPin.service';
import { migrateCounterPinRequiresTwoFactor } from '../migrations/030-counter-pin-requires-2fa';
import { makeUser, makeBusiness, makeStaff, makePricingConfig, authHeader, counterAuthHeader } from './factories';

/**
 * Invariante (2026-10-15): un PIN de mostrador implica 2FA, para toda persona.
 *
 * Sin ella, un administrador sin 2FA con PIN hacía que `counterPeople` dejara
 * de estar vacío y la puerta de la contraseña se cerrara
 * (`COUNTER_PASSWORD_DISABLED`): el dueño sin 2FA ni clave del mostrador se
 * quedaba sin ninguna entrada. Y quitar o restablecer el 2FA dejaba el PIN
 * vivo, con su bloqueo de 30 días sin salida.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123';
const PIN = '482915';
const REASON = 'Perdió el celular, identidad verificada devolviendo la llamada';

let owner: any;
let business: any;
const bid = () => business._id.toString();

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueño Daniel' });
  business = await makeBusiness(owner._id);
});

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

const setPin = async (user: any) =>
  request(app).put(`${API}/auth/counter/pin`).set(await authHeader(user)).send({ pin: PIN, currentPassword: PASSWORD });
const code = (res: request.Response) => res.body.code ?? res.body.error?.code;

async function manager(name = 'Administradora Ana') {
  const user = await makeUser({ role: UserRole.BUSINESS, name });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
  return user;
}

const pinOf = async (user: any) => {
  const stored = await User.findById(user._id).select('+counterPinHash counterPinSetAt');
  return { hash: stored!.counterPinHash, setAt: stored!.counterPinSetAt ?? null };
};

const elevatePin = async (person: any) =>
  request(app)
    .post(`${API}/auth/counter/elevate`)
    .set(await counterAuthHeader(owner))
    .send({ businessId: bid(), userId: person._id.toString(), pin: PIN });

describe('Crear el PIN exige 2FA a toda persona', () => {
  it('un administrador sin 2FA recibe 403 TWO_FACTOR_SETUP_REQUIRED y no se guarda nada', async () => {
    const ana = await manager();
    const res = await setPin(ana);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('TWO_FACTOR_SETUP_REQUIRED');
    expect(await pinOf(ana)).toEqual({ hash: undefined, setAt: null });
  });

  it('el mismo administrador, con 2FA activo, lo crea y entra con él', async () => {
    const ana = await manager();
    await enroll2fa(ana);
    expect((await setPin(ana)).status).toBe(200);
    expect((await pinOf(ana)).hash).toMatch(/^\$argon2/);
    expect((await elevatePin(ana)).status).toBe(200);
  });

  it('el dueño: sin 2FA no puede, con 2FA sí (igual que antes)', async () => {
    const denied = await setPin(owner);
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('TWO_FACTOR_SETUP_REQUIRED');

    await enroll2fa(owner);
    expect((await setPin(owner)).status).toBe(200);
  });

  it('un administrador sin 2FA no cierra la puerta de la contraseña al dueño', async () => {
    const ana = await manager();
    await setPin(ana);
    const res = await request(app)
      .post(`${API}/auth/counter/elevate-password`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: bid(), email: owner.email, password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('Quitar o restablecer el 2FA borra el PIN', () => {
  it('disable2FA borra el PIN, sus bloqueos y sus sesiones elevadas', async () => {
    const secret = await enroll2fa(owner);
    await setPin(owner);
    const elevated = await elevatePin(owner);
    expect(elevated.status).toBe(200);
    const bearer = { Authorization: `Bearer ${elevated.body.data.accessToken}` };
    await CounterPinAttempt.updateOne({ key: `day:${owner._id}|${bid()}` }, { $set: { count: 3 } }, { upsert: true });

    await request(app).post(`${API}/auth/2fa/disable`).set(await authHeader(owner)).send({ token: nextCode(secret) }).expect(200);

    expect(await pinOf(owner)).toEqual({ hash: undefined, setAt: null });
    expect(await CounterPinAttempt.countDocuments({ key: new RegExp(`^day:${owner._id}\\|`) })).toBe(0);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(bearer)).status).toBe(401);
  });

  it('disable2FA sin PIN previo funciona igual (idempotente)', async () => {
    const secret = await enroll2fa(owner);
    await request(app).post(`${API}/auth/2fa/disable`).set(await authHeader(owner)).send({ token: nextCode(secret) }).expect(200);
    expect(await pinOf(owner)).toEqual({ hash: undefined, setAt: null });
  });

  it('reset-2fa desde el panel borra el PIN y el dueño vuelve a entrar con su contraseña', async () => {
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    await enroll2fa(owner);
    await setPin(owner);
    // Antes del reset hay PIN en el local y el dueño tiene 2FA: la puerta pide el código.
    expect((await pinOf(owner)).hash).toBeTruthy();

    const res = await request(app)
      .post(`${API}/admin/users/${owner._id}/reset-2fa`)
      .set(await authHeader(superAdmin))
      .send({ reason: REASON })
      .expect(200);
    const { temporaryPassword } = res.body.data;

    expect(await pinOf(owner)).toEqual({ hash: undefined, setAt: null });
    const people = await request(app).get(`${API}/auth/counter/people`).query({ businessId: bid() }).set(await counterAuthHeader(owner));
    expect(people.body.data).toEqual([]);

    // Nadie más tiene PIN: la puerta de la contraseña está abierta.
    const door = await request(app)
      .post(`${API}/auth/counter/elevate-password`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: bid(), email: owner.email, password: temporaryPassword });
    expect(door.status).toBe(200);
  });

  it('el reset de un administrador no toca el PIN de otro', async () => {
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const ana = await manager('Administradora Ana');
    const beto = await manager('Administrador Beto');
    await enroll2fa(ana);
    await enroll2fa(beto);
    await setPin(ana);
    await setPin(beto);

    await request(app).post(`${API}/admin/users/${ana._id}/reset-2fa`).set(await authHeader(superAdmin)).send({ reason: REASON }).expect(200);

    expect((await pinOf(ana)).hash).toBeUndefined();
    expect((await pinOf(beto)).hash).toBeTruthy();
  });
});

describe('Migración 030: quita el PIN a quien no tiene 2FA', () => {
  /** Un PIN sin 2FA, como los que dejó el código anterior: se escribe directo. */
  async function legacyPin(user: any, { twoFactor }: { twoFactor: boolean }) {
    await User.updateOne(
      { _id: user._id },
      { $set: { counterPinHash: 'argon2-hash-de-prueba', counterPinSetAt: new Date(), twoFactorEnabled: twoFactor } }
    );
  }

  it('en seco lista las cuentas y no escribe nada', async () => {
    const ana = await manager();
    await legacyPin(ana, { twoFactor: false });
    await CounterPinAttempt.create({ key: `hour:${ana._id}|${bid()}`, count: 4 });

    const report = await migrateCounterPinRequiresTwoFactor({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.accounts).toBe(1);
    expect(report.affected[0].userId).toBe(String(ana._id));
    expect(report.affected[0].businesses[0]).toContain(String(business._id));
    // Enmascarados: ni el correo ni el celular completos.
    expect(report.affected[0].email).not.toContain(ana.email);
    expect(JSON.stringify(report.affected)).not.toContain(ana.phone);

    expect((await pinOf(ana)).hash).toBe('argon2-hash-de-prueba');
    expect(await CounterPinAttempt.countDocuments({})).toBe(1);
  });

  it('con apply borra solo el PIN sin 2FA, sus bloqueos y sus sesiones elevadas', async () => {
    const ana = await manager('Administradora Ana'); // PIN sin 2FA: se borra
    const beto = await manager('Administrador Beto'); // PIN con 2FA: se queda
    const carla = await manager('Administradora Carla'); // sin PIN: no es asunto de la migración
    await legacyPin(ana, { twoFactor: false });
    await legacyPin(beto, { twoFactor: true });
    await CounterPinAttempt.create({ key: `day:${ana._id}|${bid()}`, count: 4 });
    await CounterPinAttempt.create({ key: `day:${beto._id}|${bid()}`, count: 4 });

    const counter = await counterAuthHeader(owner); // crea la sesión de mostrador que sostiene las elevadas
    expect(counter.Authorization).toBeTruthy();
    const base = await Session.findOne({ userId: String(owner._id), scope: 'counter' });
    const makeElevated = async (user: any) => {
      const doc = await Session.create({
        ...base!.toObject(),
        _id: undefined,
        tokenHash: `test-${user._id}`,
        previousTokenHash: null,
        userId: String(user._id),
        isActive: true,
        elevatedFrom: String(base!._id),
      });
      return doc;
    };
    const anaSession = await makeElevated(ana);
    const betoSession = await makeElevated(beto);

    const report = await migrateCounterPinRequiresTwoFactor({ dryRun: false });
    expect(report.accounts).toBe(1);
    expect(report.sessionsRevoked).toBe(1);

    expect(await pinOf(ana)).toEqual({ hash: undefined, setAt: null });
    expect((await pinOf(beto)).hash).toBe('argon2-hash-de-prueba');
    expect(await pinOf(carla)).toEqual({ hash: undefined, setAt: null });
    expect(await CounterPinAttempt.countDocuments({ key: new RegExp(`^day:${ana._id}`) })).toBe(0);
    expect(await CounterPinAttempt.countDocuments({ key: new RegExp(`^day:${beto._id}`) })).toBe(1);
    expect((await Session.findById(anaSession._id))!.isActive).toBe(false);
    expect((await Session.findById(betoSession._id))!.isActive).toBe(true);
  });

  it('es idempotente: la segunda pasada no encuentra nada', async () => {
    const ana = await manager();
    await legacyPin(ana, { twoFactor: false });

    expect((await migrateCounterPinRequiresTwoFactor({ dryRun: false })).accounts).toBe(1);
    const second = await migrateCounterPinRequiresTwoFactor({ dryRun: false });
    expect(second.accounts).toBe(0);
    expect(second.affected).toEqual([]);
    expect(second.sessionsRevoked).toBe(0);
  });
});
