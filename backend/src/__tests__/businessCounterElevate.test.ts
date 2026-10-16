import { describe, it, expect, beforeEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Notification, User } from '../models';
import { Session } from '../security/sessions';
import { UserRole } from '../types';
import { pinProblem } from '../services/counterPin.service';
import { makeUser, makeBusiness, makePricingConfig, authHeader, counterAuthHeader } from './factories';

/**
 * Del mostrador a Representante legal / Administrador con PIN de 6 dígitos
 * (decisiones 2026-10-09 y 2026-10-10).
 *
 * La sesión de mostrador topa todo al papel Empleado; `POST
 * /auth/counter/elevate` con persona + PIN abre una sesión aparte y corta.
 * Lo que importa probar es lo que NO debe pasar: crear el PIN sin la
 * contraseña o desde el mostrador, el representante legal sin 2FA, entrar
 * siendo empleado o ajeno al negocio, adivinar el PIN sin freno, o que la
 * elevación salga como una sesión larga normal.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123'; // la de `makeUser` por defecto
const PIN = '482915';

async function enroll2fa(user: any): Promise<string> {
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

const setPin = async (user: any, pin = PIN, currentPassword = PASSWORD) =>
  request(app).put(`${API}/auth/counter/pin`).set(await authHeader(user)).send({ pin, currentPassword });

let owner: any;
let business: any;
const bid = () => business._id.toString();

const elevate = async (person: any, pin = PIN, counterOf: any = owner) =>
  request(app)
    .post(`${API}/auth/counter/elevate`)
    .set(await counterAuthHeader(counterOf))
    .send({ businessId: bid(), userId: person._id.toString(), pin });

/**
 * Un administrador. Por defecto con 2FA activo, porque desde 2026-10-15 un PIN
 * lo exige a toda persona; `{ twoFactor: false }` es el que aún no lo activó.
 */
async function manager({ twoFactor = true }: { twoFactor?: boolean } = {}) {
  const user = await makeUser({ role: UserRole.BUSINESS, name: 'Administradora Ana' });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
  if (twoFactor) await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true } });
  return user;
}

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueño Daniel' });
  business = await makeBusiness(owner._id);
});

describe('Fuerza del PIN', () => {
  it.each(['12345', '1234567', 'abcdef', '000000', '777777', '123456', '987654', '345678', '121212'])(
    'rechaza %s', (pin) => expect(pinProblem(pin)).not.toBeNull()
  );
  it.each(['482915', '205813', '930471'])('acepta %s', (pin) => expect(pinProblem(pin)).toBeNull());
});

describe('Crear el PIN propio', () => {
  it('un administrador lo crea con su contraseña; el hash nunca sale en la respuesta', async () => {
    const ana = await manager();
    const res = await setPin(ana);
    expect(res.status).toBe(200);
    const stored = await User.findById(ana._id).select('+counterPinHash');
    expect(stored!.counterPinHash).toMatch(/^\$argon2/);
    expect(stored!.counterPinHash).not.toContain(PIN);

    const me = await request(app).get(`${API}/auth/me`).set(await authHeader(ana));
    expect(JSON.stringify(me.body)).not.toContain('counterPinHash');
  });

  it('un administrador sin 2FA no puede crear su PIN: TWO_FACTOR_SETUP_REQUIRED y no se guarda nada', async () => {
    const ana = await manager({ twoFactor: false });
    const res = await setPin(ana);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    const stored = await User.findById(ana._id).select('+counterPinHash counterPinSetAt');
    expect(stored!.counterPinHash).toBeUndefined();
    expect(stored!.counterPinSetAt ?? null).toBeNull();

    // Y como nadie del local tiene PIN, la puerta de la contraseña sigue abierta
    // para el dueño: el PIN fallido no la cerró.
    const people = await request(app).get(`${API}/auth/counter/people`).query({ businessId: bid() }).set(await counterAuthHeader(owner));
    expect(people.body.data).toEqual([]);
  });

  it('con la contraseña equivocada no se crea', async () => {
    const ana = await manager();
    expect((await setPin(ana, PIN, 'otra-cosa')).status).toBe(401);
  });

  it('un PIN débil se rechaza con PIN_WEAK', async () => {
    const ana = await manager();
    const res = await setPin(ana, '123456');
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe('PIN_WEAK');
  });

  it('el representante legal sin 2FA no puede crear su PIN', async () => {
    const res = await setPin(owner);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });

  it('desde el mostrador no se crea ni se borra un PIN', async () => {
    const header = await counterAuthHeader(owner);
    expect((await request(app).put(`${API}/auth/counter/pin`).set(header).send({ pin: PIN, currentPassword: PASSWORD })).status).toBe(403);
    expect((await request(app).delete(`${API}/auth/counter/pin`).set(header)).status).toBe(403);
  });
});

describe('Quién aparece en el mostrador', () => {
  it('solo el propietario y los administradores que ya tienen PIN, con nombre y papel', async () => {
    await enroll2fa(owner);
    await setPin(owner);
    const ana = await manager();
    await setPin(ana);
    await manager(); // administrador sin PIN: no aparece
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, status: 'active', isActive: true });
    await User.updateOne({ _id: employee._id }, { $set: { twoFactorEnabled: true } });
    expect((await setPin(employee)).status).toBe(200); // un empleado con PIN tampoco aparece

    const res = await request(app).get(`${API}/auth/counter/people`).query({ businessId: bid() }).set(await counterAuthHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { userId: owner._id.toString(), name: 'Dueño Daniel', role: 'owner' },
      { userId: ana._id.toString(), name: 'Administradora Ana', role: 'manager' },
    ]);
  });

  it('la lista de otro negocio no se puede pedir desde este mostrador', async () => {
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(stranger._id);
    const res = await request(app).get(`${API}/auth/counter/people`).query({ businessId: other._id.toString() }).set(await counterAuthHeader(owner));
    expect(res.status).toBe(403);
  });
});

describe('Entrar con PIN', () => {
  it('el representante legal entra con su PIN y recibe una sesión completa y corta', async () => {
    await enroll2fa(owner);
    await setPin(owner);
    const res = await elevate(owner);
    expect(res.status).toBe(200);

    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('owner');

    const session = await Session.findOne({ userId: owner._id.toString(), elevatedFrom: { $ne: null } });
    expect(session!.scope).toBe('full');
    expect(session!.absoluteExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);
  });

  it('un administrador entra con su PIN como administrador', async () => {
    const ana = await manager();
    await setPin(ana);
    const res = await elevate(ana);
    expect(res.status).toBe(200);
    const perms = await request(app)
      .get(`${API}/businesses/${bid()}/my-permissions`)
      .set({ Authorization: `Bearer ${res.body.data.accessToken}` });
    expect(perms.body.data.role).toBe('manager');
  });

  it('PIN equivocado: 401 PIN_INVALID', async () => {
    const ana = await manager();
    await setPin(ana);
    const res = await elevate(ana, '205813');
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error?.code).toBe('PIN_INVALID');
  });

  it('un empleado con PIN no entra: misma respuesta que un PIN malo', async () => {
    const employee = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: business._id, userId: employee._id, role: BusinessRole.EMPLOYEE, status: 'active', isActive: true });
    await setPin(employee);
    const res = await elevate(employee);
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error?.code).toBe('PIN_INVALID');
  });

  it('el administrador de OTRO negocio no entra en este', async () => {
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(stranger._id);
    const outsider = await makeUser({ role: UserRole.BUSINESS });
    await setPin(outsider);
    const res = await elevate(outsider);
    expect(res.status).toBe(401);
  });

  it('desde una sesión completa no se entra con PIN: NOT_COUNTER_SESSION', async () => {
    const ana = await manager();
    await setPin(ana);
    const res = await request(app)
      .post(`${API}/auth/counter/elevate`)
      .set(await authHeader(owner))
      .send({ businessId: bid(), userId: ana._id.toString(), pin: PIN });
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe('NOT_COUNTER_SESSION');
  });

  it('el mostrador de otro negocio no puede probar PINs de la gente de este', async () => {
    const ana = await manager();
    await setPin(ana);
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(stranger._id);
    const res = await elevate(ana, PIN, stranger);
    expect(res.status).toBe(403);
  });
});

describe('Freno de intentos', () => {
  it('5 PIN malos bloquean 15 min, el PIN correcto deja de servir y el dueño recibe alerta', async () => {
    const ana = await manager();
    await setPin(ana);
    for (let i = 0; i < 4; i++) expect((await elevate(ana, '205813')).status).toBe(401);

    const fifth = await elevate(ana, '205813');
    expect(fifth.status).toBe(429);
    expect(fifth.body.code ?? fifth.body.error?.code).toBe('PIN_LOCKED');

    // Bloqueado, ni el PIN correcto entra.
    const correct = await elevate(ana);
    expect(correct.status).toBe(429);

    const alerts = await Notification.find({ userId: owner._id, 'data.event': 'counter_pin_locked' });
    expect(alerts).toHaveLength(1);
  });

  it('un PIN correcto antes del bloqueo borra los fallos de ese equipo', async () => {
    const ana = await manager();
    await setPin(ana);
    for (let i = 0; i < 4; i++) await elevate(ana, '205813');
    expect((await elevate(ana)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await elevate(ana, '205813')).status).toBe(401);
  });
});

describe('Revisión de seguridad 2026-10-10', () => {
  it('una ráfaga de 20 PIN en paralelo no verifica más de 5: el resto se rechaza sin probar', async () => {
    const ana = await manager();
    await setPin(ana);
    const header = await counterAuthHeader(owner);
    const wrong = ['205813', '930471', '583920', '402918', '719305'];
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app).post(`${API}/auth/counter/elevate`).set(header)
          .send({ businessId: bid(), userId: ana._id.toString(), pin: wrong[i % wrong.length] })
      )
    );
    const tried = burst.filter((r) => r.status === 401).length;
    expect(tried).toBeLessThanOrEqual(4);
    expect(burst.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    // Y ya bloqueado, el PIN correcto tampoco entra.
    expect((await elevate(ana)).status).toBe(429);
  });

  it('el PIN no puede salir del celular de la persona', async () => {
    const ana = await makeUser({ role: UserRole.BUSINESS, phone: '3104829157' });
    await BusinessStaff.create({ businessId: business._id, userId: ana._id, role: BusinessRole.MANAGER, status: 'active', isActive: true });
    const res = await setPin(ana, '829157');
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe('PIN_WEAK');
  });

  it('al 3.er PIN malo del día el dueño recibe aviso aunque no haya bloqueo', async () => {
    const ana = await manager();
    await setPin(ana);
    for (let i = 0; i < 3; i++) await elevate(ana, '205813');
    const alerts = await Notification.find({ userId: owner._id, 'data.event': 'counter_pin_failures' });
    expect(alerts).toHaveLength(1);
  });

  it('el dueño desbloquea el PIN de un administrador desde su cuenta; desde el mostrador no', async () => {
    const ana = await manager();
    await setPin(ana);
    for (let i = 0; i < 5; i++) await elevate(ana, '205813');
    expect((await elevate(ana)).status).toBe(429);

    const fromCounter = await request(app).post(`${API}/auth/counter/pin/unlock`)
      .set(await counterAuthHeader(owner)).send({ businessId: bid(), userId: ana._id.toString() });
    expect(fromCounter.status).toBe(403);

    const unlock = await request(app).post(`${API}/auth/counter/pin/unlock`)
      .set(await authHeader(owner)).send({ businessId: bid(), userId: ana._id.toString() });
    expect(unlock.status).toBe(200);
    expect((await elevate(ana)).status).toBe(200);
  });

  it('un administrador no puede desbloquear PINs', async () => {
    const ana = await manager();
    const res = await request(app).post(`${API}/auth/counter/pin/unlock`)
      .set(await authHeader(ana)).send({ businessId: bid(), userId: owner._id.toString() });
    expect(res.status).toBe(403);
  });

  it('el bloqueo es por negocio: bloquear al dueño en un local no lo bloquea en otro', async () => {
    await enroll2fa(owner);
    await setPin(owner);
    const second = await makeBusiness(owner._id);
    for (let i = 0; i < 5; i++) await elevate(owner, '205813');
    expect((await elevate(owner)).status).toBe(429);

    const elsewhere = await request(app).post(`${API}/auth/counter/elevate`)
      .set(await counterAuthHeader(owner))
      .send({ businessId: second._id.toString(), userId: owner._id.toString(), pin: PIN });
    expect(elsewhere.status).toBe(200);
  });

  it('la sesión elevada solo vale en el negocio de su mostrador', async () => {
    await enroll2fa(owner);
    await setPin(owner);
    const second = await makeBusiness(owner._id);
    const elevated = await elevate(owner);
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };

    const here = await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header);
    expect(here.body.data.role).toBe('owner');
    const there = await request(app).get(`${API}/businesses/${second._id}/my-permissions`).set(header);
    expect(there.body.data.role).toBeNull();
    expect((await request(app).get(`${API}/businesses/${second._id}/statement`).set(header)).status).toBe(403);

    const mine = await request(app).get(`${API}/businesses/my/businesses`).set(header);
    expect(mine.body.data.map((b: any) => b._id.toString())).toEqual([bid()]);
  });

  it('la sesión elevada no gestiona equipo, datos fiscales, cuenta de pago ni credenciales', async () => {
    await enroll2fa(owner);
    await setPin(owner);
    const elevated = await elevate(owner);
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };

    const checks = await Promise.all([
      request(app).post(`${API}/businesses/${bid()}/staff`).set(header).send({ phone: '3001112233', role: 'manager' }),
      request(app).put(`${API}/businesses/${bid()}/legal`).set(header).send({}),
      request(app).put(`${API}/businesses/${bid()}/payout-account`).set(header).send({}),
      request(app).put(`${API}/auth/counter/pin`).set(header).send({ pin: '930471', currentPassword: PASSWORD }),
      request(app).delete(`${API}/auth/counter/pin`).set(header),
      request(app).post(`${API}/auth/change-password`).set(header).send({ currentPassword: PASSWORD, newPassword: 'Otra.Clave456' }),
      request(app).post(`${API}/auth/sessions/revoke-all`).set(header).send({}),
    ]);
    for (const res of checks) {
      expect(res.status).toBe(403);
      expect(res.body.code ?? res.body.error?.code).toBe('COUNTER_SESSION_FORBIDDEN');
    }
  });

  it('cerrar la sesión del mostrador corta también las entradas con PIN hechas sobre ella', async () => {
    const ana = await manager();
    await setPin(ana);
    const counterHeader = await counterAuthHeader(owner);
    const elevated = await request(app).post(`${API}/auth/counter/elevate`).set(counterHeader)
      .send({ businessId: bid(), userId: ana._id.toString(), pin: PIN });
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(200);

    await Session.updateMany({ userId: owner._id.toString(), scope: 'counter' }, { $set: { isActive: false } });
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(401);
  });

  it('cambiar el PIN cierra las sesiones elevadas abiertas con el anterior', async () => {
    const ana = await manager();
    await setPin(ana);
    const elevated = await elevate(ana);
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };

    expect((await setPin(ana, '930471')).status).toBe(200);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(401);
  });

  it('una cuenta bloqueada con el PIN correcto responde igual que un PIN malo', async () => {
    const ana = await manager();
    await setPin(ana);
    await User.updateOne({ _id: ana._id }, { $set: { isBlocked: true } });
    const res = await elevate(ana);
    expect(res.status).toBe(401);
    expect(res.body.code ?? res.body.error?.code).toBe('PIN_INVALID');
  });
});
describe('Volver al mostrador', () => {
  it('drop revoca la sesión elevada y su token deja de servir', async () => {
    const ana = await manager();
    await setPin(ana);
    const elevated = await elevate(ana);
    const header = { Authorization: `Bearer ${elevated.body.data.accessToken}` };

    expect((await request(app).post(`${API}/auth/counter/drop`).set(header)).status).toBe(200);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(401);
  });

  it('refrescar el token no alarga la inactividad de la sesión elevada más allá de 15 min', async () => {
    const ana = await manager();
    await setPin(ana);
    const elevated = await elevate(ana);
    const refreshed = await request(app)
      .post(`${API}/auth/refresh-token`)
      .send({ refreshToken: elevated.body.data.refreshToken });
    expect(refreshed.status).toBe(200);

    const session = await Session.findOne({ userId: ana._id.toString(), elevatedFrom: { $ne: null } });
    expect(session!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });

  it('drop sobre una sesión que no es elevada no la cierra', async () => {
    const header = await authHeader(owner);
    const res = await request(app).post(`${API}/auth/counter/drop`).set(header);
    expect(res.status).toBe(400);
    expect((await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set(header)).status).toBe(200);
  });
});

describe('Login de comercio: el servidor decide el alcance (C1)', () => {
  const login = (body: Record<string, unknown>) => request(app).post(`${API}/auth/login`).send(body);
  const roleOf = async (accessToken: string) =>
    (await request(app).get(`${API}/businesses/${bid()}/my-permissions`).set({ Authorization: `Bearer ${accessToken}` })).body.data.role;

  it('sin surface, una cuenta de comercio abre sesión de mostrador', async () => {
    const res = await login({ email: owner.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await roleOf(res.body.data.accessToken)).toBe('employee');
  });

  it('mandar surface no cambia nada: el campo se descarta', async () => {
    const res = await login({ email: owner.email, password: PASSWORD, surface: 'business-counter' });
    expect(res.status).toBe(200);
    expect(await roleOf(res.body.data.accessToken)).toBe('employee');
    const other = await login({ email: owner.email, password: PASSWORD, surface: 'full' });
    expect(other.status).toBe(200);
    expect(await roleOf(other.body.data.accessToken)).toBe('employee');
  });

  it('con 2FA, el reto conserva el alcance de mostrador', async () => {
    const secret = await enroll2fa(owner);
    const first = await login({ email: owner.email, password: PASSWORD });
    expect(first.body.data.requiresTOTP).toBe(true);
    const second = await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken: first.body.data.challengeToken, code: nextCode(secret) });
    expect(second.status).toBe(200);
    expect(await roleOf(second.body.data.accessToken)).toBe('employee');
  });
});
