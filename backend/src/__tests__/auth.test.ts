import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User } from '../models';
import { UserRole } from '../types';
import { makeUser, authHeader } from './factories';

// A distinct phone per test keeps cases independent of execution order.
let phoneSeq = 0;
const newClient = () => ({
  name: 'Nuevo Cliente',
  phone: `30099${String(90000 + phoneSeq++).slice(-5)}`,
  password: 'Clave.Segura123',
  role: 'client',
});

describe('Hash de contraseñas', () => {
  it('almacena un hash Argon2id, nunca el texto plano', async () => {
    const user = await makeUser({ password: 'Clave.Segura123' });
    const stored = await User.findById(user._id).select('+password');

    expect(stored!.password).not.toBe('Clave.Segura123');
    expect(stored!.password!.startsWith('$argon2')).toBe(true);
  });

  // Regression: the seed script used to pre-hash with bcrypt before handing
  // the value to the model, which then hashed it again with Argon2. The
  // result verified against nothing, so no demo account could log in.
  it('una contraseña en texto plano verifica correctamente', async () => {
    const user = await makeUser({ password: 'Zipp.2026' });
    const stored = await User.findById(user._id).select('+password');

    expect(await stored!.comparePassword('Zipp.2026')).toBe(true);
    expect(await stored!.comparePassword('otra-clave')).toBe(false);
  });
});

describe('POST /api/v1/auth/register', () => {
  it('registra un cliente y devuelve tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(newClient())
      .expect(201);

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.password).toBeUndefined();
  });

  // Regression: `iat` has one-second resolution and is rounded down, while
  // passwordChangedAt keeps milliseconds. Comparing them directly made the
  // token returned by register invalid on its very first use.
  it('el token devuelto al registrarse sirve de inmediato', async () => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send(newClient())
      .expect(201);

    await request(app)
      .get('/api/v1/addresses')
      .set('Authorization', `Bearer ${registered.body.data.accessToken}`)
      .expect(200);
  });

  it('rechaza un teléfono ya registrado', async () => {
    const client = newClient();
    await request(app).post('/api/v1/auth/register').send(client).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...client, name: 'Otro' })
      .expect(409);

    expect(res.body.message).toMatch(/ya está registrado/i);
  });

  it('exige contraseña compleja para cuentas de negocio', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...newClient(), password: 'abc123', role: 'business' })
      .expect(400);

    expect(res.body.message).toMatch(/contraseña/i);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('inicia sesión con credenciales válidas', async () => {
    const client = newClient();
    await request(app).post('/api/v1/auth/register').send(client).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: client.password })
      .expect(200);

    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('rechaza una contraseña incorrecta sin revelar si el usuario existe', async () => {
    const client = newClient();
    await request(app).post('/api/v1/auth/register').send(client).expect(201);

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Incorrecta.123' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: '3007776655', password: 'Incorrecta.123' })
      .expect(401);

    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('rechaza una cuenta desactivada', async () => {
    const user = await makeUser({ password: 'Clave.Segura123' });
    user.isActive = false;
    await user.save();

    await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: user.phone, password: 'Clave.Segura123' })
      .expect(403);
  });
});

describe('Autorización por rol', () => {
  it('un cliente no puede listar cupones del panel de administración', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });

    await request(app)
      .get('/api/v1/coupons')
      .set(authHeader(client))
      .expect(403);
  });

  it('un administrador sí puede', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    await request(app)
      .get('/api/v1/coupons')
      .set(authHeader(admin))
      .expect(200);
  });

  it('un token inválido se rechaza', async () => {
    await request(app)
      .get('/api/v1/addresses')
      .set('Authorization', 'Bearer no-es-un-token')
      .expect(401);
  });
});

describe('Endpoints públicos', () => {
  it('/health responde el estado del servicio', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('OK');
  });

  it('una ruta de API inexistente devuelve 404 en JSON', async () => {
    const res = await request(app).get('/api/v1/no-existe').expect(404);
    expect(res.body.success).toBe(false);
  });
});
