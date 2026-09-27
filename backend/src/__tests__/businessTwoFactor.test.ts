import { describe, it, expect, afterEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { config } from '../config';
import { User } from '../models';
import { AuditLog, AuditAction } from '../security';
import { UserRole } from '../types';
import { twoFactorSetupPending } from '../services/mfa.service';
import { makeUser, makeStaff, authHeader } from './factories';

/**
 * 2FA del panel de comercios: el mismo guardia que el de admin, detrás de
 * `TOTP_REQUIRED_BUSINESS` (apagado salvo que se encienda) y con fecha de
 * corte opcional; la activación pide la contraseña en cuentas de panel; y la
 * salida para quien pierde el celular: `POST /admin/users/:id/reset-2fa`,
 * que también rota la contraseña.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123'; // la de `makeUser` por defecto

async function enroll(header: { Authorization: string }, currentPassword = PASSWORD): Promise<string> {
  const setup = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword }).expect(200);
  const { secret } = setup.body.data;
  await request(app)
    .post(`${API}/auth/2fa/verify`)
    .set(header)
    .send({ token: speakeasy.totp({ secret, encoding: 'base32' }) })
    .expect(200);
  return secret;
}

afterEach(() => {
  config.security.twoFactor.requiredForBusiness = false;
  config.security.twoFactor.requiredForBusinessFrom = null;
});

describe('Comercios sin 2FA cuando TOTP_REQUIRED_BUSINESS está activo', () => {
  it('bloquea el panel hasta configurar el 2FA, y deja pasar en cuanto se activa', async () => {
    config.security.twoFactor.requiredForBusiness = true;
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const header = await authHeader(owner);

    const blocked = await request(app).get(`${API}/businesses/my/businesses`).set(header);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    expect(blocked.body.message).toContain('panel de comercios');

    await request(app).get(`${API}/auth/me`).set(header).expect(200);
    await enroll(header);

    await request(app).get(`${API}/businesses/my/businesses`).set(header).expect(200);
  });

  it('no toca a clientes ni a admins', async () => {
    config.security.twoFactor.requiredForBusiness = true;
    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).get(`${API}/orders/my`).set(await authHeader(client)).expect(200);

    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app).get(`${API}/coupons`).set(await authHeader(admin)).expect(200);
  });

  it('con el flag apagado (el default), un comercio sin 2FA entra con normalidad', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await request(app).get(`${API}/businesses/my/businesses`).set(await authHeader(owner)).expect(200);
  });

  it('con fecha de corte, el bloqueo empieza en esa fecha y no al encender el flag', async () => {
    config.security.twoFactor.requiredForBusiness = true;
    const cutoff = new Date(Date.now() + 60 * 60 * 1000);
    config.security.twoFactor.requiredForBusinessFrom = cutoff;
    const owner = await makeUser({ role: UserRole.BUSINESS });

    await request(app).get(`${API}/businesses/my/businesses`).set(await authHeader(owner)).expect(200);

    const pendingUser = { role: UserRole.BUSINESS, twoFactorEnabled: false };
    expect(twoFactorSetupPending(pendingUser, new Date(cutoff.getTime() - 1))).toBe(false);
    expect(twoFactorSetupPending(pendingUser, cutoff)).toBe(true);
  });

  it('con el 2FA obligatorio, no se puede desactivar (409)', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const header = await authHeader(owner);
    const secret = await enroll(header);

    config.security.twoFactor.requiredForBusiness = true;
    const code = speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });
    const res = await request(app).post(`${API}/auth/2fa/disable`).set(header).send({ token: code });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
    expect((await User.findById(owner._id))!.twoFactorEnabled).toBe(true);
  });

  it('un comercio con 2FA activo recibe un reto al entrar con contraseña, y la sesión solo sale con el código', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS, password: PASSWORD });
    const secret = await enroll(await authHeader(owner));

    const login = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD }).expect(200);
    expect(login.body.data.requiresTOTP).toBe(true);
    expect(login.body.data.accessToken).toBeUndefined();

    // El alta ya gastó el paso actual (sin repetición): se usa el siguiente.
    const code = speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });
    const done = await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken: login.body.data.challengeToken, code })
      .expect(200);
    expect(done.body.data.accessToken).toBeTruthy();
    expect(done.body.data.user.role).toBe(UserRole.BUSINESS);
  });
});

describe('POST /auth/2fa/setup en cuentas de panel pide la contraseña', () => {
  it('sin contraseña o con una equivocada responde 400 REAUTH_INVALID y no guarda secreto', async () => {
    for (const role of [UserRole.BUSINESS, UserRole.ADMIN]) {
      const user = await makeUser({ role });
      const header = await authHeader(user);

      const missing = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('REAUTH_INVALID');

      const wrong = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: 'Otra.Clave999' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('REAUTH_INVALID');

      const after = await User.findById(user._id).select('+twoFactorSecret');
      expect(after!.twoFactorSecret).toBeUndefined();
    }
  });

  it('la app móvil (cliente) sigue activándolo sin contraseña', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    await request(app).post(`${API}/auth/2fa/setup`).set(await authHeader(client)).expect(200);
  });

  it('si ya está activo, responde con el código TWO_FACTOR_ALREADY_ENABLED', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const header = await authHeader(owner);
    await enroll(header);

    const again = await request(app).post(`${API}/auth/2fa/setup`).set(header).send({ currentPassword: PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });
});

describe('POST /admin/users/:id/reset-2fa', () => {
  const REASON = 'Perdió el celular, identidad verificada devolviendo la llamada';

  it('quita el 2FA, rota la contraseña, cierra las sesiones y deja rastro en auditoría', async () => {
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const owner = await makeUser({ role: UserRole.BUSINESS, password: PASSWORD });
    const ownerHeader = await authHeader(owner);
    await enroll(ownerHeader);

    const res = await request(app)
      .post(`${API}/admin/users/${owner._id}/reset-2fa`)
      .set(await authHeader(superAdmin))
      .send({ reason: REASON })
      .expect(200);
    const { temporaryPassword } = res.body.data;
    expect(temporaryPassword).toBeTruthy();

    const after = await User.findById(owner._id).select('+twoFactorSecret +recoveryCodes twoFactorEnabled');
    expect(after!.twoFactorEnabled).toBe(false);
    expect(after!.twoFactorSecret).toBeUndefined();
    expect(after!.recoveryCodes ?? []).toHaveLength(0);

    // La sesión que tenía abierta ya no sirve.
    await request(app).get(`${API}/auth/me`).set(ownerHeader).expect(401);

    // La contraseña vieja (la que tendría un atacante) ya no entra; la temporal sí.
    const old = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: temporaryPassword }).expect(200);
    expect(fresh.body.data.accessToken).toBeTruthy();

    const audit = await AuditLog.findOne({ action: AuditAction.TOTP_RESET_BY_ADMIN, entityId: owner._id.toString() }).lean();
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).toContain(REASON);
    expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
  });

  it('un admin sin el permiso users:reset_2fa recibe 403 y el 2FA sigue activo', async () => {
    const ordinaryAdmin = await makeUser({ role: UserRole.ADMIN });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await enroll(await authHeader(owner));

    await request(app)
      .post(`${API}/admin/users/${owner._id}/reset-2fa`)
      .set(await authHeader(ordinaryAdmin))
      .send({ reason: REASON })
      .expect(403);

    expect((await User.findById(owner._id))!.twoFactorEnabled).toBe(true);
  });

  it('exige motivo, rechaza cuentas sin 2FA y no deja restablecer el propio', async () => {
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const header = await authHeader(superAdmin);
    const owner = await makeUser({ role: UserRole.BUSINESS });

    await request(app).post(`${API}/admin/users/${owner._id}/reset-2fa`).set(header).send({ reason: 'corto' }).expect(400);
    await request(app).post(`${API}/admin/users/${owner._id}/reset-2fa`).set(header).send({ reason: REASON }).expect(409);
    await request(app).post(`${API}/admin/users/${superAdmin._id}/reset-2fa`).set(header).send({ reason: REASON }).expect(403);
  });
});
