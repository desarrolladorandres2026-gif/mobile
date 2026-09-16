import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User, PendingRegistration } from '../models';
import { OtpOutbox } from '../models/OtpOutbox';
import { UserRole } from '../types';
import { makeUser, authHeader } from './factories';

// A distinct phone per test keeps cases independent of execution order.
let phoneSeq = 0;
const newClient = () => ({
  name: 'Nuevo Cliente',
  phone: `30099${String(90000 + phoneSeq++).slice(-5)}`,
  password: 'Clave.Segura123',
});

/**
 * El código real nunca se puede leer de `PendingRegistration` (se guarda
 * hasheado — ver `security/otp.ts`). En pruebas, sin proveedor de WhatsApp
 * configurado, el envío cae al buzón de desarrollo (`models/OtpOutbox.ts`),
 * así que el código se recupera de ahí, igual que un usuario lo leería de
 * su WhatsApp.
 */
async function readOtp(phone: string): Promise<string> {
  const entry = await OtpOutbox.findOne({ channel: 'whatsapp', destination: phone }).sort({ createdAt: -1 });
  if (!entry) throw new Error(`No se envió ningún OTP a ${phone}`);
  return entry.code;
}

/** Registro real: los tres pasos, de punta a punta. */
async function registerClient(client = newClient()) {
  await request(app).post('/api/v1/auth/register/send-otp').send({ phone: client.phone }).expect(200);
  const otpCode = await readOtp(client.phone);
  await request(app).post('/api/v1/auth/register/verify-otp').send({ phone: client.phone, otpCode }).expect(200);
  const res = await request(app)
    .post('/api/v1/auth/register/complete')
    .send({ phone: client.phone, name: client.name, password: client.password })
    .expect(201);
  return { client, res };
}

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

/**
 * `POST /auth/register` se eliminó (M14 de la auditoría de seguridad):
 * creaba cuentas sin verificar el celular por OTP y dejaba elegir el rol
 * `driver`/`business` sin ninguna comprobación adicional. Ningún cliente lo
 * usaba — el registro real siempre fue el de tres pasos de más abajo.
 */
describe('POST /api/v1/auth/register (eliminado)', () => {
  it('ya no existe: cualquier intento de crear una cuenta sin OTP da 404', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(newClient());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/auth/phone-status', () => {
  it('dice si un celular ya tiene cuenta, sin gastar el límite de OTP', async () => {
    const { client } = await registerClient();

    const known = await request(app)
      .post('/api/v1/auth/phone-status')
      .send({ phone: client.phone })
      .expect(200);
    expect(known.body.data.exists).toBe(true);

    const unknown = await request(app)
      .post('/api/v1/auth/phone-status')
      .send({ phone: newClient().phone })
      .expect(200);
    expect(unknown.body.data.exists).toBe(false);
  });
});

describe('Registro en 3 pasos (celular → nombre → contraseña)', () => {
  it('registra un cliente y devuelve tokens', async () => {
    const { res } = await registerClient();

    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.user.password).toBeUndefined();
    // El celular se confirmó por OTP en el paso 2: la cuenta nace verificada.
    expect(res.body.data.user.phoneVerified).toBe(true);
  });

  // Regression: `iat` has one-second resolution and is rounded down, while
  // passwordChangedAt keeps milliseconds. Comparing them directly made the
  // token returned right after creating the account invalid on its very
  // first use.
  it('el token devuelto al completar el registro sirve de inmediato', async () => {
    const { res } = await registerClient();

    await request(app)
      .get('/api/v1/addresses')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
  });

  it('rechaza un teléfono ya registrado', async () => {
    const { client } = await registerClient();

    const res = await request(app)
      .post('/api/v1/auth/register/send-otp')
      .send({ phone: client.phone })
      .expect(409);

    expect(res.body.message).toMatch(/ya está registrado/i);
  });

  it('manda el OTP y no deja completar el registro sin verificarlo', async () => {
    const client = newClient();

    await request(app)
      .post('/api/v1/auth/register/send-otp')
      .send({ phone: client.phone })
      .expect(200);

    const unverified = await request(app)
      .post('/api/v1/auth/register/complete')
      .send({ phone: client.phone, name: client.name, password: client.password })
      .expect(400);

    expect(unverified.body.message).toMatch(/verifica tu celular/i);
  });

  it('rechaza un código incorrecto y acepta el correcto', async () => {
    const client = newClient();
    await request(app).post('/api/v1/auth/register/send-otp').send({ phone: client.phone }).expect(200);

    await request(app)
      .post('/api/v1/auth/register/verify-otp')
      .send({ phone: client.phone, otpCode: '000000' })
      .expect(400);

    const otpCode = await readOtp(client.phone);
    await request(app)
      .post('/api/v1/auth/register/verify-otp')
      .send({ phone: client.phone, otpCode })
      .expect(200);
  });

  it('completa la cuenta después de verificar y devuelve tokens de una', async () => {
    const { client } = await registerClient();

    // El estado intermedio no debe sobrevivir a una cuenta ya creada.
    expect(await PendingRegistration.findOne({ phone: client.phone })).toBeNull();
  });

  it('no manda OTP de registro a un celular que ya tiene cuenta', async () => {
    const { client } = await registerClient();

    const res = await request(app)
      .post('/api/v1/auth/register/send-otp')
      .send({ phone: client.phone })
      .expect(409);

    expect(res.body.message).toMatch(/ya está registrado/i);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('inicia sesión con credenciales válidas', async () => {
    const { client } = await registerClient();

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: client.password })
      .expect(200);

    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('rechaza una contraseña incorrecta sin revelar si el usuario existe', async () => {
    const { client } = await registerClient();

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
      .set(await authHeader(client))
      .expect(403);
  });

  it('un administrador sí puede', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    await request(app)
      .get('/api/v1/coupons')
      .set(await authHeader(admin))
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
