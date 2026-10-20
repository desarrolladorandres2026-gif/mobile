import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../data/db.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { startMongo } from '../testing/mongo.js';
import { createAuthService } from './auth.js';
import { parseKey } from './secretbox.js';
import { totpAt } from './totp.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correcto-caballo-grapa';
const EMAIL = 'marta@andina.co';
const KEY = parseKey(Buffer.alloc(32, 3).toString('base64'));

let mongo;
let db;
let auth;
let clock;
let userId;
let secret;

const code = (promise) => promise.then(() => null, (err) => err.code ?? err.name);
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};
const otp = (offsetSteps = 0) => totpAt(secret, clock.getTime() + offsetSteps * 30_000);
const WRONG = '000000';

/** Activa los dos pasos y devuelve los códigos de recuperación. */
async function enableMfa() {
  const started = await auth.startMfaEnrollment(userId);
  secret = started.secret;
  const { recoveryCodes } = await auth.confirmMfaEnrollment(userId, otp());
  advance(31_000); // el paso usado al activar ya no vale para iniciar sesión
  return recoveryCodes;
}

beforeAll(async () => {
  mongo = await startMongo('lulubiz_mfa_test');
  db = mongo.db;
});

afterAll(async () => {
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  await ensureIndexes(db);
  clock = new Date('2030-01-01T10:00:00Z');
  auth = createAuthService(mongo.client, db, { now: () => clock, passwordParams: FAST, mailer: createMemoryMailer(), mfaKey: KEY });
  ({ userId } = await auth.registerTenant({
    companyName: 'Comercial Andina SAS', country: 'CO', currency: 'COP', ownerName: 'Marta', email: EMAIL, password: PASSWORD,
  }));
});

describe('activación', () => {
  it('entrega el secreto y el URI, y no activa nada hasta probar un código', async () => {
    const started = await auth.startMfaEnrollment(userId);
    expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.otpauthUri).toContain('otpauth://totp/Lulubiz:marta%40andina.co');
    expect((await auth.getAccount(userId)).mfaEnabled).toBe(false);
    expect(await code(auth.login(EMAIL, PASSWORD))).toBeNull(); // todavía entra sin segundo paso
  });

  it('un código incorrecto no activa; el correcto activa y entrega 10 códigos de recuperación únicos', async () => {
    const { secret: s } = await auth.startMfaEnrollment(userId);
    secret = s;
    expect(await code(auth.confirmMfaEnrollment(userId, WRONG))).toBe('INVALID_MFA');
    expect((await auth.getAccount(userId)).mfaEnabled).toBe(false);

    const { recoveryCodes } = await auth.confirmMfaEnrollment(userId, otp());
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recoveryCodes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c))).toBe(true);
    expect(await auth.getAccount(userId)).toMatchObject({ mfaEnabled: true, recoveryCodesLeft: 10 });
  });

  it('el secreto y los códigos no quedan en claro en la base de datos', async () => {
    const recovery = await enableMfa();
    const stored = JSON.stringify(await db.collection(COLLECTIONS.users).findOne({ _id: userId }));
    expect(stored).not.toContain(secret);
    for (const c of recovery) expect(stored).not.toContain(c);
    expect(stored).toContain('"secretEnc":"v1.');
  });

  it('no se puede activar dos veces ni confirmar sin haber empezado', async () => {
    expect(await code(auth.confirmMfaEnrollment(userId, '123456'))).toBe('VALIDATION');
    await enableMfa();
    expect(await code(auth.startMfaEnrollment(userId))).toBe('MFA_ALREADY');
  });

  it('exige la clave de cifrado configurada', async () => {
    const sinClave = createAuthService(mongo.client, db, { now: () => clock, passwordParams: FAST });
    await expect(sinClave.startMfaEnrollment(userId)).rejects.toThrow(/MFA_ENCRYPTION_KEY/);
  });
});

describe('inicio de sesión con dos pasos', () => {
  beforeEach(async () => {
    await enableMfa();
  });

  it('la contraseña sola no da sesión: devuelve un desafío', async () => {
    const result = await auth.login(EMAIL, PASSWORD);
    expect(result.mfaRequired).toBe(true);
    expect(result.challenge).toHaveLength(43);
    expect(result.token).toBeUndefined();
    expect(await db.collection(COLLECTIONS.sessions).countDocuments({ userId })).toBe(0);
  });

  it('el código correcto completa el inicio de sesión', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    const session = await auth.verifyMfaLogin(challenge, otp());
    expect(session.usedRecoveryCode).toBe(false);
    expect((await auth.verifySession(session.token)).userId.equals(userId)).toBe(true);
  });

  it('un código incorrecto falla igual que uno vencido', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifyMfaLogin(challenge, WRONG))).toBe('INVALID_MFA');
    expect(await code(auth.verifyMfaLogin(challenge, otp(5)))).toBe('INVALID_MFA');
    expect(await code(auth.verifyMfaLogin(challenge, ''))).toBe('INVALID_MFA');
    expect(await code(auth.verifyMfaLogin('x', otp()))).toBe('INVALID_MFA');
  });

  it('un código ya usado no sirve otra vez, aunque se pida un desafío nuevo', async () => {
    const first = await auth.login(EMAIL, PASSWORD);
    const code1 = otp();
    await auth.verifyMfaLogin(first.challenge, code1);

    const second = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifyMfaLogin(second.challenge, code1))).toBe('INVALID_MFA');
    advance(30_000);
    expect(await code(auth.verifyMfaLogin(second.challenge, otp()))).toBeNull();
  });

  it('el desafío sirve una sola vez', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    await auth.verifyMfaLogin(challenge, otp());
    advance(30_000);
    expect(await code(auth.verifyMfaLogin(challenge, otp()))).toBe('INVALID_MFA');
  });

  it('el desafío vence a los 5 minutos y no sirve como token de sesión', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifySession(challenge))).toBe('INVALID_SESSION');
    advance(6 * 60_000);
    expect(await code(auth.verifyMfaLogin(challenge, otp()))).toBe('INVALID_MFA');
  });

  it('5 fallos invalidan el desafío aunque después llegue el código correcto', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    for (let i = 0; i < 5; i += 1) await code(auth.verifyMfaLogin(challenge, WRONG));
    expect(await code(auth.verifyMfaLogin(challenge, otp()))).toBe('INVALID_MFA');
  });

  it('los fallos se acumulan entre desafíos y bloquean la cuenta (no se puede forzar pidiendo desafíos nuevos)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { challenge } = await auth.login(EMAIL, PASSWORD);
      await code(auth.verifyMfaLogin(challenge, WRONG));
      await code(auth.verifyMfaLogin(challenge, WRONG));
    }
    // 6 fallos > máximo de 5: la cuenta está bloqueada, ni la contraseña correcta pasa.
    expect(await code(auth.login(EMAIL, PASSWORD))).toBe('INVALID_CREDENTIALS');
    advance(16 * 60_000);
    expect((await auth.login(EMAIL, PASSWORD)).mfaRequired).toBe(true);
  });

  it('un acierto reinicia el contador de fallos', async () => {
    const a = await auth.login(EMAIL, PASSWORD);
    for (let i = 0; i < 4; i += 1) await code(auth.verifyMfaLogin(a.challenge, WRONG));
    const b = await auth.login(EMAIL, PASSWORD);
    await auth.verifyMfaLogin(b.challenge, otp());
    const c = await auth.login(EMAIL, PASSWORD);
    advance(30_000);
    for (let i = 0; i < 4; i += 1) await code(auth.verifyMfaLogin(c.challenge, WRONG));
    expect(await code(auth.login(EMAIL, PASSWORD))).toBeNull();
  });

  it('dos verificaciones simultáneas con el mismo código: solo una abre sesión', async () => {
    const a = await auth.login(EMAIL, PASSWORD);
    const b = await auth.login(EMAIL, PASSWORD);
    const valid = otp();
    const results = await Promise.all([auth.verifyMfaLogin(a.challenge, valid), auth.verifyMfaLogin(b.challenge, valid)].map(code));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'INVALID_MFA')).toHaveLength(1);
  });
});

describe('códigos de recuperación', () => {
  let recovery;
  beforeEach(async () => {
    recovery = await enableMfa();
  });

  it('un código de recuperación sustituye al TOTP, una sola vez', async () => {
    const first = await auth.login(EMAIL, PASSWORD);
    const session = await auth.verifyMfaLogin(first.challenge, recovery[0].toUpperCase());
    expect(session.usedRecoveryCode).toBe(true);
    expect((await auth.getAccount(userId)).recoveryCodesLeft).toBe(9);

    const second = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifyMfaLogin(second.challenge, recovery[0]))).toBe('INVALID_MFA');
    expect(await code(auth.verifyMfaLogin(second.challenge, recovery[1]))).toBeNull();
  });

  it('un código con formato de recuperación pero inventado falla', async () => {
    const { challenge } = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifyMfaLogin(challenge, 'aaaaa-bbbbb'))).toBe('INVALID_MFA');
  });

  it('regenerarlos invalida los anteriores y exige contraseña y código vigente', async () => {
    expect(await code(auth.regenerateRecoveryCodes(userId, { password: 'incorrecta-incorrecta', code: otp() }))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.regenerateRecoveryCodes(userId, { password: PASSWORD, code: WRONG }))).toBe('INVALID_MFA');
    const { recoveryCodes } = await auth.regenerateRecoveryCodes(userId, { password: PASSWORD, code: otp() });
    expect(recoveryCodes).toHaveLength(10);

    const { challenge } = await auth.login(EMAIL, PASSWORD);
    expect(await code(auth.verifyMfaLogin(challenge, recovery[0]))).toBe('INVALID_MFA');
    expect(await code(auth.verifyMfaLogin(challenge, recoveryCodes[0]))).toBeNull();
  });
});

describe('desactivación', () => {
  beforeEach(async () => {
    await enableMfa();
  });

  it('exige contraseña y un segundo factor válido', async () => {
    expect(await code(auth.disableMfa(userId, { password: 'incorrecta-incorrecta', code: otp() }))).toBe('INVALID_CREDENTIALS');
    expect(await code(auth.disableMfa(userId, { password: PASSWORD, code: WRONG }))).toBe('INVALID_MFA');
    expect((await auth.getAccount(userId)).mfaEnabled).toBe(true);
  });

  it('con ambos, desactiva y el inicio de sesión vuelve a ser directo', async () => {
    await auth.disableMfa(userId, { password: PASSWORD, code: otp() });
    expect((await auth.getAccount(userId)).mfaEnabled).toBe(false);
    const result = await auth.login(EMAIL, PASSWORD);
    expect(result.token).toBeDefined();
    expect(result.mfaRequired).toBeUndefined();
  });

  it('desactivar con un código de recuperación también vale', async () => {
    const recovery = (await auth.regenerateRecoveryCodes(userId, { password: PASSWORD, code: otp() })).recoveryCodes;
    await auth.disableMfa(userId, { password: PASSWORD, code: recovery[0] });
    expect((await auth.getAccount(userId)).mfaEnabled).toBe(false);
  });

  it('no se puede desactivar lo que no está activo', async () => {
    await auth.disableMfa(userId, { password: PASSWORD, code: otp() });
    expect(await code(auth.disableMfa(userId, { password: PASSWORD, code: otp() }))).toBe('VALIDATION');
  });
});
