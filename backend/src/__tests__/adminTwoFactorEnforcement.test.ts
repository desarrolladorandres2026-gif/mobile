import { describe, it, expect, afterEach } from 'vitest';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { config } from '../config';
import { UserRole } from '../types';
import { makeUser, authHeader } from './factories';

/**
 * `TOTP_REQUIRED_ADMINS` existía en la configuración y nada lo aplicaba: un
 * administrador con acceso a dinero y usuarios entraba solo con contraseña.
 * Ver A14 de la auditoría.
 *
 * Esta prueba activa el flag a propósito (está apagado bajo `isTest` — ver
 * `config/env.ts` — porque el resto de la suite crea administradores sin
 * pasar por el alta de 2FA) para comprobar la aplicación real del guardia en
 * `middlewares/auth.ts`, sin forzar a todo el archivo de pruebas de admin a
 * enrolarse.
 */
describe('Administradores sin 2FA cuando TOTP_REQUIRED_ADMINS está activo', () => {
  afterEach(() => {
    config.security.twoFactor.requiredForAdmins = false;
  });

  it('bloquea el panel hasta configurar el 2FA, y deja pasar en cuanto se activa', async () => {
    config.security.twoFactor.requiredForAdmins = true;

    const admin = await makeUser({ role: UserRole.ADMIN });
    const header = await authHeader(admin);

    // Cualquier ruta protegida normal queda fuera.
    const blocked = await request(app).get('/api/v1/coupons').set(header);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TWO_FACTOR_SETUP_REQUIRED');

    // Pero las rutas para configurarlo, y para cerrar sesión, siguen abiertas.
    await request(app).get('/api/v1/auth/me').set(header).expect(200);

    const setup = await request(app).post('/api/v1/auth/2fa/setup').set(header).expect(200);
    const { secret } = setup.body.data;
    const token = speakeasy.totp({ secret, encoding: 'base32' });

    await request(app).post('/api/v1/auth/2fa/verify').set(header).send({ token }).expect(200);

    // 2FA activo: el mismo token de siempre ya entra a cualquier lado.
    await request(app).get('/api/v1/coupons').set(header).expect(200);
  });

  it('un administrador con 2FA activo nunca se ve afectado por el flag', async () => {
    config.security.twoFactor.requiredForAdmins = true;

    const admin = await makeUser({ role: UserRole.ADMIN });
    const header = await authHeader(admin);

    const setup = await request(app).post('/api/v1/auth/2fa/setup').set(header).expect(200);
    const token = speakeasy.totp({ secret: setup.body.data.secret, encoding: 'base32' });
    await request(app).post('/api/v1/auth/2fa/verify').set(header).send({ token }).expect(200);

    await request(app).get('/api/v1/coupons').set(header).expect(200);
  });

  it('con el flag apagado (el default de pruebas), un admin sin 2FA entra con normalidad', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    await request(app).get('/api/v1/coupons').set(await authHeader(admin)).expect(200);
  });
});
