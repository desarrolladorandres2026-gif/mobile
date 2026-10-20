import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { startMongo } from '../testing/mongo.js';
import { AuthError, createAuthService } from './auth.js';
import { PasswordError, hashPassword, validatePasswordStrength, verifyPassword } from './password.js';
import { can } from './permissions.js';

// Parámetros livianos solo para pruebas; en producción rige DEFAULT_PASSWORD_PARAMS.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';

let mongo;
let db;
let auth;
let clock;

const company = (overrides = {}) => ({
  companyName: 'Comercial Andina SAS',
  country: 'CO',
  currency: 'COP',
  ownerName: 'Marta Ruiz',
  email: 'marta@andina.co',
  password: PASSWORD,
  ...overrides,
});

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);

beforeAll(async () => {
  mongo = await startMongo('lulubiz_auth_test');
  db = mongo.db;
  // Fecha lejana para que el índice TTL real de MongoDB no toque las sesiones de las pruebas.
  clock = new Date('2030-01-01T10:00:00Z');
  auth = createAuthService(mongo.client, db, { now: () => clock, passwordParams: FAST });
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  clock = new Date('2030-01-01T10:00:00Z');
});

describe('contraseñas', () => {
  it('verifica la correcta y rechaza la incorrecta; el formato lleva sus parámetros', async () => {
    const hash = await hashPassword(PASSWORD, FAST);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'basura')).toBe(false);
  });

  it('dos hashes de la misma contraseña son distintos (sal aleatoria)', async () => {
    expect(await hashPassword(PASSWORD, FAST)).not.toBe(await hashPassword(PASSWORD, FAST));
  });

  it('exige longitud y variedad mínimas', () => {
    expect(() => validatePasswordStrength('corta')).toThrow(PasswordError);
    expect(() => validatePasswordStrength('aaaaaaaaaaaaaaaa')).toThrow(/repetitiva/);
    expect(() => validatePasswordStrength('x'.repeat(129))).toThrow(/máximo/);
    expect(() => validatePasswordStrength(PASSWORD)).not.toThrow();
  });
});

describe('registro de empresa', () => {
  it('crea empresa, usuario y propietario en una sola operación', async () => {
    const { tenantId, userId } = await auth.registerTenant(company({ email: '  Marta@Andina.CO ' }));
    expect(await db.collection(COLLECTIONS.users).findOne({ _id: userId })).toMatchObject({ email: 'marta@andina.co' });
    const [membership] = await auth.listMemberships(userId);
    expect(membership).toMatchObject({ tenantId, role: 'owner', name: 'Comercial Andina SAS', country: 'CO', currency: 'COP' });
    expect(membership.permissions).toContain('journals:post');
    expect(membership.permissions).toContain('tenant:manage');
  });

  it('no guarda la contraseña en claro', async () => {
    const { userId } = await auth.registerTenant(company());
    const user = await db.collection(COLLECTIONS.users).findOne({ _id: userId });
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('rechaza correo repetido (sin importar mayúsculas) y no deja una empresa a medias', async () => {
    await auth.registerTenant(company());
    expect(await code(auth.registerTenant(company({ email: 'MARTA@andina.co', companyName: 'Otra SAS' })))).toBe('EMAIL_TAKEN');
    expect(await db.collection(COLLECTIONS.tenants).countDocuments()).toBe(1);
    expect(await db.collection(COLLECTIONS.memberships).countDocuments()).toBe(1);
  });

  it('valida datos de entrada', async () => {
    expect(await code(auth.registerTenant(company({ email: 'sin-arroba' })))).toBe('VALIDATION');
    expect(await code(auth.registerTenant(company({ country: 'colombia' })))).toBe('VALIDATION');
    expect(await code(auth.registerTenant(company({ companyName: '  ' })))).toBe('VALIDATION');
    expect(await code(auth.registerTenant(company({ currency: 'XXX' })))).toBe('MoneyError');
    expect(await code(auth.registerTenant(company({ password: 'corta' })))).toBe('PasswordError');
  });
});

describe('inicio de sesión', () => {
  beforeEach(async () => {
    await auth.registerTenant(company());
  });

  it('entrega un token, y en base de datos solo queda su hash', async () => {
    const { token } = await auth.login('marta@andina.co', PASSWORD);
    expect(token).toHaveLength(43);
    const stored = await db.collection(COLLECTIONS.sessions).findOne({});
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await auth.verifySession(token)).userId.equals(stored.userId)).toBe(true);
  });

  it('contraseña incorrecta y correo inexistente fallan con el mismo error', async () => {
    const wrong = await auth.login('marta@andina.co', 'incorrecta-incorrecta').catch((e) => e);
    const unknown = await auth.login('nadie@andina.co', PASSWORD).catch((e) => e);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.code).toBe(wrong.code);
    expect(unknown.message).toBe(wrong.message);
  });

  it('bloquea tras 5 intentos fallidos aunque luego llegue la contraseña correcta, y se libera con el tiempo', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await code(auth.login('marta@andina.co', 'incorrecta-incorrecta'))).toBe('INVALID_CREDENTIALS');
    }
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBe('INVALID_CREDENTIALS');

    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBeNull();
  });

  it('un acierto reinicia el contador de fallos', async () => {
    for (let i = 0; i < 4; i += 1) await code(auth.login('marta@andina.co', 'incorrecta-incorrecta'));
    await auth.login('marta@andina.co', PASSWORD);
    for (let i = 0; i < 4; i += 1) await code(auth.login('marta@andina.co', 'incorrecta-incorrecta'));
    expect(await code(auth.login('marta@andina.co', PASSWORD))).toBeNull();
  });
});

describe('sesiones', () => {
  let token;
  beforeEach(async () => {
    await auth.registerTenant(company());
    ({ token } = await auth.login('marta@andina.co', PASSWORD));
  });

  it('vence por inactividad, pero la actividad la mantiene viva', async () => {
    clock = new Date(clock.getTime() + 20 * 60 * 1000);
    await auth.verifySession(token);
    clock = new Date(clock.getTime() + 20 * 60 * 1000);
    await auth.verifySession(token);
    clock = new Date(clock.getTime() + 31 * 60 * 1000);
    expect(await code(auth.verifySession(token))).toBe('INVALID_SESSION');
  });

  it('vence por tiempo absoluto aunque haya actividad constante', async () => {
    // Pasos de 25 min (menos que la inactividad de 30): 28 pasos = 11 h 40 min, aún dentro de las 12 h.
    for (let i = 0; i < 28; i += 1) {
      clock = new Date(clock.getTime() + 25 * 60 * 1000);
      expect(await code(auth.verifySession(token))).toBeNull();
    }
    clock = new Date(clock.getTime() + 25 * 60 * 1000);
    expect(await code(auth.verifySession(token))).toBe('INVALID_SESSION');
  });

  it('cerrar sesión la revoca al instante, y logoutAll revoca todas', async () => {
    await auth.logout(token);
    expect(await code(auth.verifySession(token))).toBe('INVALID_SESSION');

    const a = (await auth.login('marta@andina.co', PASSWORD)).token;
    const b = (await auth.login('marta@andina.co', PASSWORD)).token;
    const { userId } = await auth.verifySession(a);
    await auth.logoutAll(userId);
    expect(await code(auth.verifySession(a))).toBe('INVALID_SESSION');
    expect(await code(auth.verifySession(b))).toBe('INVALID_SESSION');
  });

  it('rechaza tokens mal formados o inventados', async () => {
    expect(await code(auth.verifySession(undefined))).toBe('INVALID_SESSION');
    expect(await code(auth.verifySession('x'))).toBe('INVALID_SESSION');
    expect(await code(auth.verifySession('a'.repeat(43)))).toBe('INVALID_SESSION');
  });
});

describe('permisos y pertenencia a empresas', () => {
  let ownerA;
  let tenantA;
  let tenantB;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    ({ tenantId: tenantA, userId: ownerA } = await auth.registerTenant(company()));
    ({ tenantId: tenantB } = await auth.registerTenant(
      company({ companyName: 'Otra SAS', email: 'jorge@otra.co', ownerName: 'Jorge' }),
    ));
    tokenA = (await auth.login('marta@andina.co', PASSWORD)).token;
    tokenB = (await auth.login('jorge@otra.co', PASSWORD)).token;
  });

  it('el propietario puede todo en su empresa y nada en la ajena', async () => {
    expect(await auth.authorize(tokenA, tenantA, 'journals:post')).toMatchObject({ role: 'owner' });
    expect(await code(auth.authorize(tokenA, tenantB, 'journals:read'))).toBe('FORBIDDEN');
    expect(await code(auth.authorize(tokenB, tenantA, 'journals:read'))).toBe('FORBIDDEN');
  });

  it('una empresa inexistente y una ajena dan el mismo error', async () => {
    const ghost = await auth.authorize(tokenA, new ObjectId(), 'journals:read').catch((e) => e);
    const foreign = await auth.authorize(tokenA, tenantB, 'journals:read').catch((e) => e);
    expect(ghost.code).toBe('FORBIDDEN');
    expect(ghost.message).toBe(foreign.message);
  });

  it('sin sesión válida no hay autorización', async () => {
    expect(await code(auth.authorize('a'.repeat(43), tenantA, 'journals:read'))).toBe('INVALID_SESSION');
  });

  it('un lector solo lee; un contador contabiliza pero no administra usuarios', async () => {
    await auth.registerTenant(company({ companyName: 'X', email: 'lector@andina.co', ownerName: 'L' }));
    await auth.registerTenant(company({ companyName: 'Y', email: 'conta@andina.co', ownerName: 'C' }));
    const actor = { userId: ownerA, tenantId: tenantA };
    await auth.addMember(actor, { email: 'lector@andina.co', role: 'viewer' });
    await auth.addMember(actor, { email: 'conta@andina.co', role: 'accountant' });

    const viewer = (await auth.login('lector@andina.co', PASSWORD)).token;
    const accountant = (await auth.login('conta@andina.co', PASSWORD)).token;
    expect(await code(auth.authorize(viewer, tenantA, 'journals:read'))).toBeNull();
    expect(await code(auth.authorize(viewer, tenantA, 'journals:post'))).toBe('FORBIDDEN');
    expect(await code(auth.authorize(accountant, tenantA, 'journals:post'))).toBeNull();
    expect(await code(auth.authorize(accountant, tenantA, 'users:manage'))).toBe('FORBIDDEN');
  });

  it('un contador puede pertenecer a varias empresas con roles distintos', async () => {
    const actorB = { userId: (await auth.verifySession(tokenB)).userId, tenantId: tenantB };
    await auth.addMember(actorB, { email: 'marta@andina.co', role: 'viewer' });
    expect((await auth.listMemberships(ownerA)).map((m) => m.role).sort()).toEqual(['owner', 'viewer']);
    expect(await code(auth.authorize(tokenA, tenantB, 'journals:read'))).toBeNull();
    expect(await code(auth.authorize(tokenA, tenantB, 'journals:post'))).toBe('FORBIDDEN');
  });

  it('la matriz de permisos niega lo no listado', () => {
    expect(can('viewer', 'journals:post')).toBe(false);
    expect(can('admin', 'tenant:manage')).toBe(false);
    expect(can('owner', 'tenant:manage')).toBe(true);
    expect(can('inventado', 'journals:read')).toBe(false);
  });
});

describe('gestión de miembros', () => {
  let tenant;
  let owner;
  let other;
  let adminUser;

  beforeEach(async () => {
    ({ tenantId: tenant, userId: owner } = await auth.registerTenant(company()));
    ({ userId: other } = await auth.registerTenant(
      company({ companyName: 'Z', email: 'segundo@andina.co', ownerName: 'S' }),
    ));
    ({ userId: adminUser } = await auth.registerTenant(
      company({ companyName: 'W', email: 'admin@andina.co', ownerName: 'A' }),
    ));
  });

  it('solo un propietario nombra a otro propietario; un administrador no', async () => {
    const actor = { userId: owner, tenantId: tenant };
    await auth.addMember(actor, { email: 'admin@andina.co', role: 'admin' });
    expect(await code(auth.addMember({ userId: adminUser, tenantId: tenant }, { email: 'segundo@andina.co', role: 'owner' }))).toBe('FORBIDDEN');
    expect(await code(auth.addMember(actor, { email: 'segundo@andina.co', role: 'owner' }))).toBeNull();
  });

  it('rechaza rol inválido, usuario inexistente y miembro repetido', async () => {
    const actor = { userId: owner, tenantId: tenant };
    expect(await code(auth.addMember(actor, { email: 'segundo@andina.co', role: 'jefe' }))).toBe('VALIDATION');
    expect(await code(auth.addMember(actor, { email: 'nadie@andina.co', role: 'viewer' }))).toBe('NOT_FOUND');
    await auth.addMember(actor, { email: 'segundo@andina.co', role: 'viewer' });
    expect(await code(auth.addMember(actor, { email: 'segundo@andina.co', role: 'viewer' }))).toBe('ALREADY_MEMBER');
  });

  it('un administrador no puede degradar ni quitar a un propietario', async () => {
    const actor = { userId: owner, tenantId: tenant };
    await auth.addMember(actor, { email: 'admin@andina.co', role: 'admin' });
    const asAdmin = { userId: adminUser, tenantId: tenant };
    expect(await code(auth.changeRole(asAdmin, owner, 'viewer'))).toBe('FORBIDDEN');
    expect(await code(auth.removeMember(asAdmin, owner))).toBe('FORBIDDEN');
  });

  it('no deja la empresa sin propietario', async () => {
    const actor = { userId: owner, tenantId: tenant };
    expect(await code(auth.changeRole(actor, owner, 'admin'))).toBe('LAST_OWNER');
    expect(await code(auth.removeMember(actor, owner))).toBe('LAST_OWNER');
  });

  it('dos propietarios que se degradan a la vez: solo uno lo logra', async () => {
    const actor = { userId: owner, tenantId: tenant };
    await auth.addMember(actor, { email: 'segundo@andina.co', role: 'owner' });
    const results = await Promise.all([
      code(auth.changeRole({ userId: owner, tenantId: tenant }, other, 'viewer')),
      code(auth.changeRole({ userId: other, tenantId: tenant }, owner, 'viewer')),
    ]);
    const owners = await db.collection(COLLECTIONS.memberships).countDocuments({ tenantId: tenant, role: 'owner' });
    expect(owners).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r === null).length).toBeLessThanOrEqual(1);
  });

  it('cambia el rol y quita miembros', async () => {
    const actor = { userId: owner, tenantId: tenant };
    await auth.addMember(actor, { email: 'segundo@andina.co', role: 'viewer' });
    await auth.changeRole(actor, other, 'accountant');
    expect((await auth.listMemberships(other)).find((m) => m.tenantId.equals(tenant)).role).toBe('accountant');
    await auth.removeMember(actor, other);
    expect((await auth.listMemberships(other)).some((m) => m.tenantId.equals(tenant))).toBe(false);
    expect(await code(auth.removeMember(actor, other))).toBe('NOT_FOUND');
  });
});
