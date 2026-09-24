import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import speakeasy from 'speakeasy';
import app from '../app';
import { User, Business, Role, Order } from '../models';
import { UserRole, OrderStatus, PaymentMethod } from '../types';
import { config } from '../config';
import { authService, identityVerifiers } from '../services/auth.service';
import { Session } from '../security/sessions';
import { hashOtp, otpExpiryDate } from '../security/otp';
import { OtpOutbox } from '../models/OtpOutbox';
import { SUPER_ADMIN_ROLE_SLUG, Permission } from '../security/rbac';
import { makeUser, makeBusiness, makeProduct, authHeader, GARZON } from './factories';

/**
 * Pruebas adversariales de la auditoría de seguridad del 2026-09-14/15.
 *
 * Cada bloque ataca directamente el hallazgo que corrige — intenta lo mismo
 * que un atacante intentaría — y espera un rechazo controlado. Complementan,
 * sin repetir, las pruebas ya existentes de `auth.test.ts` y `rbac.test.ts`.
 */

async function makeSuperAdminRole() {
  return Role.create({
    name: 'Super Administrador',
    slug: SUPER_ADMIN_ROLE_SLUG,
    permissions: Object.values(Permission),
    isSystem: true,
    isActive: true,
  });
}

async function makeSuperAdmin() {
  const role = await makeSuperAdminRole();
  const user = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });
  user.roleIds = [role._id] as any;
  await user.save();
  return user;
}

// ── C2 — Vinculación de Google/Apple por correo ───────────────────────

describe('C2 — Google/Apple no vinculan por un correo que ZIPP no verificó', () => {
  afterEach(() => vi.restoreAllMocks());

  it('correo existente SIN verificar + Google: no se vincula, se crea (o se libera el correo) una cuenta nueva, no la del atacante', async () => {
    // El "atacante" registró primero una cuenta con el correo de la víctima.
    const attacker = await makeUser({});
    await User.findByIdAndUpdate(attacker._id, {
      email: 'victima@ejemplo.com',
      emailVerified: false,
    });

    vi.spyOn(identityVerifiers, 'google').mockResolvedValue({
      sub: 'google-sub-victima',
      email: 'victima@ejemplo.com',
      email_verified: true,
      name: 'Víctima Real',
    } as any);

    const outcome = await authService.loginWithGoogle('token-de-prueba');

    expect(outcome.requiresTOTP).toBe(false);
    if (outcome.requiresTOTP) throw new Error('unreachable');

    // La cuenta de Google NO es la del atacante.
    expect(outcome.user._id.toString()).not.toBe(attacker._id.toString());
    expect(outcome.user.googleId).toBe('google-sub-victima');

    // Y el atacante se quedó sin ese correo: ya no puede usarlo para
    // hacerse pasar por la víctima ni recibir sus notificaciones.
    const attackerAfter = await User.findById(attacker._id).select('+email');
    expect(attackerAfter!.email).toBeUndefined();
  });

  it('correo existente VERIFICADO + Google: sí se vincula a esa cuenta (es realmente su dueño)', async () => {
    const user = await makeUser({});
    await User.findByIdAndUpdate(user._id, {
      email: 'dueno.real@ejemplo.com',
      emailVerified: true,
    });

    vi.spyOn(identityVerifiers, 'google').mockResolvedValue({
      sub: 'google-sub-dueno',
      email: 'dueno.real@ejemplo.com',
      email_verified: true,
      name: 'Dueño Real',
    } as any);

    const outcome = await authService.loginWithGoogle('token-de-prueba');
    if (outcome.requiresTOTP) throw new Error('unreachable');

    expect(outcome.user._id.toString()).toBe(user._id.toString());
    const stored = await User.findById(user._id).select('+googleId');
    expect(stored!.googleId).toBe('google-sub-dueno');
  });

  it('correo existente SIN verificar + Apple: tampoco se vincula', async () => {
    const attacker = await makeUser({});
    await User.findByIdAndUpdate(attacker._id, {
      email: 'victima2@ejemplo.com',
      emailVerified: false,
    });

    config.apple.servicesId = 'com.zipp.test.services';
    vi.spyOn(identityVerifiers, 'apple').mockResolvedValue({
      sub: 'apple-sub-victima',
      email: 'victima2@ejemplo.com',
      email_verified: true,
      nonce: crypto.createHash('sha256').update('nonce-de-prueba').digest('hex'),
    } as any);

    const code = await authService.createAppleAuthCode('id-token-simulado', 'Víctima Apple');
    const outcome = await authService.loginWithApple({ code, nonce: 'nonce-de-prueba' });
    if (outcome.requiresTOTP) throw new Error('unreachable');

    expect(outcome.user._id.toString()).not.toBe(attacker._id.toString());
    expect(outcome.user.appleId).toBe('apple-sub-victima');
  });

  it('correo existente VERIFICADO + Apple: sí se vincula', async () => {
    const user = await makeUser({});
    await User.findByIdAndUpdate(user._id, { email: 'dueno.apple@ejemplo.com', emailVerified: true });

    config.apple.servicesId = 'com.zipp.test.services';
    vi.spyOn(identityVerifiers, 'apple').mockResolvedValue({
      sub: 'apple-sub-dueno',
      email: 'dueno.apple@ejemplo.com',
      email_verified: true,
      nonce: crypto.createHash('sha256').update('otro-nonce').digest('hex'),
    } as any);

    const code = await authService.createAppleAuthCode('id-token-simulado');
    const outcome = await authService.loginWithApple({ code, nonce: 'otro-nonce' });
    if (outcome.requiresTOTP) throw new Error('unreachable');

    expect(outcome.user._id.toString()).toBe(user._id.toString());
  });

  it('un correo ya vinculado a OTRA identidad de Google no se puede "robar" con un segundo login', async () => {
    const owner = await makeUser({});
    await User.findByIdAndUpdate(owner._id, {
      email: 'compartido@ejemplo.com',
      emailVerified: true,
      googleId: 'google-sub-original',
    });

    vi.spyOn(identityVerifiers, 'google').mockResolvedValue({
      sub: 'google-sub-otro-atacante',
      email: 'compartido@ejemplo.com',
      email_verified: true,
    } as any);

    await expect(authService.loginWithGoogle('token-de-prueba')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

// ── C3 — 2FA en todos los caminos que emiten sesión ───────────────────

describe('C3 — ningún camino de login se salta el 2FA de una cuenta que lo tiene activo', () => {
  afterEach(() => vi.restoreAllMocks());

  async function enableTwoFactor(userId: string) {
    // Se activa a través del servicio real (igual que un usuario de verdad),
    // no escribiendo el secreto a mano.
    const setup = await authService.setup2FA(userId);
    const token = speakeasy.totp({ secret: setup.secret, encoding: 'base32' });
    await authService.verify2FASetup(userId, token);
  }

  it('Google: con 2FA activo, responde un reto en vez de una sesión', async () => {
    const user = await makeUser({});
    await User.findByIdAndUpdate(user._id, { email: 'dosfa.google@ejemplo.com', emailVerified: true });
    await enableTwoFactor(user._id.toString());

    vi.spyOn(identityVerifiers, 'google').mockResolvedValue({
      sub: 'google-2fa-sub',
      email: 'dosfa.google@ejemplo.com',
      email_verified: true,
    } as any);

    const outcome = await authService.loginWithGoogle('token-de-prueba');
    expect(outcome.requiresTOTP).toBe(true);
    expect((outcome as any).tokens).toBeUndefined();
  });

  it('OTP de WhatsApp: con 2FA activo, el código correcto no basta para entrar', async () => {
    const user = await makeUser({});
    await enableTwoFactor(user._id.toString());

    // El código real nunca se lee en claro (se guarda hasheado); se fuerza
    // uno conocido directamente en el documento, como si el usuario lo
    // hubiera recibido de verdad por WhatsApp.
    const rawCode = '123456';
    await User.findByIdAndUpdate(user._id, {
      otpCode: hashOtp(rawCode),
      otpExpires: otpExpiryDate(),
      otpAttempts: 0,
    });

    const outcome = await authService.verifyOTP(user.phone!, rawCode);
    expect(outcome.requiresTOTP).toBe(true);
  });

  it('recuperación de contraseña: con 2FA activo, el OTP correcto no cambia la contraseña sin el segundo factor', async () => {
    const user = await makeUser({ password: 'Clave.Segura123' });
    await enableTwoFactor(user._id.toString());

    const rawCode = '654321';
    await User.findByIdAndUpdate(user._id, {
      otpCode: hashOtp(rawCode),
      otpExpires: otpExpiryDate(),
      otpAttempts: 0,
    });

    const outcome = await authService.resetPassword(user.phone!, rawCode, 'Nueva.Clave456');
    expect(outcome.requiresTOTP).toBe(true);

    // La contraseña NO cambió.
    const stillOld = await User.findById(user._id).select('+password');
    expect(await stillOld!.comparePassword('Clave.Segura123')).toBe(true);
  });
});

// ── C4 — IDOR en documentos de negocio ─────────────────────────────────

describe('C4 — documentos de un negocio: solo su dueño (o su staff, o admin) los toca', () => {
  it('un dueño de OTRO negocio no puede leer ni escribir los documentos', async () => {
    const ownerA = await makeUser({ role: UserRole.BUSINESS });
    const ownerB = await makeUser({ role: UserRole.BUSINESS });
    const businessA = await makeBusiness(ownerA._id);

    const read = await request(app)
      .get(`/api/v1/businesses/${businessA._id}/documents`)
      .set(await authHeader(ownerB));
    expect(read.status).toBe(403);

    const write = await request(app)
      .post(`/api/v1/businesses/${businessA._id}/documents`)
      .set(await authHeader(ownerB))
      .send({ type: 'rut', reference: 'RUT-FALSO-0000000001' });
    expect(write.status).toBe(403);

    // Y de verdad no se pisó nada: sigue sin haber documento.
    const asOwner = await request(app)
      .get(`/api/v1/businesses/${businessA._id}/documents`)
      .set(await authHeader(ownerA))
      .expect(200);
    expect(asOwner.body.data).toEqual([]);
  });

  it('el dueño real sí puede, y un admin también', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const admin = await makeUser({ role: UserRole.ADMIN });
    const business = await makeBusiness(owner._id);

    // La subida va a Cloudinary privado: se sustituye por un destino en memoria.
    const { cloudinary } = await import('../config');
    const { Writable } = await import('stream');
    vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((_o: unknown, cb: (e: null, r: { public_id: string }) => void) =>
      new Writable({ write(_c, _e, n) { n(); }, final(done) { cb(null, { public_id: 'zipp/business-documents/test' }); done(); } })) as never);

    await request(app)
      .post(`/api/v1/businesses/${business._id}/documents`)
      .set(await authHeader(owner))
      .field('type', 'rut')
      .field('reference', 'RUT-0000000001')
      .attach('file', Buffer.from('%PDF-1.4 %%EOF'), { filename: 'rut.pdf', contentType: 'application/pdf' })
      .expect(201);

    await request(app).get(`/api/v1/businesses/${business._id}/documents`).set(await authHeader(admin)).expect(200);
  });

  it('un usuario sin ninguna relación con el negocio (cliente) no puede', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const client = await makeUser({ role: UserRole.CLIENT });
    const business = await makeBusiness(owner._id);

    await request(app)
      .get(`/api/v1/businesses/${business._id}/documents`)
      .set(await authHeader(client))
      .expect(403);
  });
});

// ── C5 — Escalamiento de privilegios vía contacto/contraseña ──────────

describe('C5 — un admin operativo no puede tomar el control de una cuenta administrativa', () => {
  it('no puede sobrescribir el teléfono del Super Admin', async () => {
    const operativeAdmin = await makeUser({ role: UserRole.ADMIN });
    const superAdmin = await makeSuperAdmin();

    const res = await request(app)
      .patch(`/api/v1/admin/users/${superAdmin._id}/contact`)
      .set(await authHeader(operativeAdmin))
      .send({ phone: operativeAdmin.phone });

    expect(res.status).toBe(403);

    const untouched = await User.findById(superAdmin._id);
    expect(untouched!.phone).toBe(superAdmin.phone);
  });

  it('no puede resetear la contraseña de una cuenta con isFinanceAdmin', async () => {
    const operativeAdmin = await makeUser({ role: UserRole.ADMIN });
    const financeAdmin = await makeUser({ role: UserRole.ADMIN, isFinanceAdmin: true });

    const res = await request(app)
      .post(`/api/v1/admin/users/${financeAdmin._id}/reset-password`)
      .set(await authHeader(operativeAdmin));

    expect(res.status).toBe(403);
  });

  it('un Super Administrador sí puede cambiar el contacto de otro admin, y revoca sus sesiones', async () => {
    const superAdmin = await makeSuperAdmin();
    const target = await makeUser({ role: UserRole.ADMIN });
    const targetHeader = await authHeader(target);

    // La sesión del objetivo está activa antes del cambio.
    await request(app).get('/api/v1/auth/me').set(targetHeader).expect(200);

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target._id}/contact`)
      .set(await authHeader(superAdmin))
      .send({ phone: '3009998888' });
    expect(res.status).toBe(200);

    // La sesión anterior del objetivo ya no sirve.
    const after = await request(app).get('/api/v1/auth/me').set(targetHeader);
    expect(after.status).toBe(401);
  });

  it('nadie puede tomar el control de su propia cuenta por este endpoint privilegiado', async () => {
    const superAdmin = await makeSuperAdmin();

    const res = await request(app)
      .patch(`/api/v1/admin/users/${superAdmin._id}/contact`)
      .set(await authHeader(superAdmin))
      .send({ phone: '3001112222' });

    expect(res.status).toBe(403);
  });
});

// ── A1 — Robo y reuso de refresh token ─────────────────────────────────

describe('A1 — refresh tokens: reuso, robo y varios dispositivos', () => {
  it('usar un refresh token DESPUÉS de que ya fue rotado revoca todas las sesiones (reuso = robo)', async () => {
    const client = await makeUser({ password: 'Clave.Segura123' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Clave.Segura123' })
      .expect(200);

    const stolen = login.body.data.refreshToken;

    // El dueño legítimo refresca primero (rota el token).
    await request(app).post('/api/v1/auth/refresh-token').send({ refreshToken: stolen }).expect(200);

    // Sacamos la rotación fuera de la ventana de gracia (15 s) contra
    // refrescos dobles del mismo cliente: pasado ese margen, presentar el
    // token anterior ya no puede ser una carrera benigna, así que cualquier
    // presentación posterior es reuso de verdad.
    await Session.updateMany(
      { userId: client._id.toString() },
      { $set: { rotatedAt: new Date(Date.now() - 60_000) } }
    );

    // El atacante intenta usar la copia vieja que interceptó.
    const reuse = await request(app).post('/api/v1/auth/refresh-token').send({ refreshToken: stolen });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');

    // Y de verdad se cerró TODO: hasta la sesión legítima que sí rotó a tiempo.
    const activeSessions = await Session.countDocuments({ userId: client._id.toString(), isActive: true });
    expect(activeSessions).toBe(0);
  });

  it('un token robado y usado una sola vez (sin que el dueño lo haya rotado todavía) SÍ funciona: por eso hace falta revocar sesiones, no solo rotar', async () => {
    // Esto documenta la propiedad real de "rotación con detección de reuso":
    // protege contra el uso repetido de un token robado, no contra su primer
    // uso. Un dispositivo nuevo se ve como "otra sesión más" hasta que algo
    // (login por contraseña, 2FA, cambio de clave) lo distinga.
    const client = await makeUser({ password: 'Clave.Segura123' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Clave.Segura123' })
      .expect(200);

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh-token')
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(200);

    expect(refreshed.body.data.accessToken).toBeTruthy();
  });

  it('dos dispositivos con la misma cuenta mantienen sesiones independientes', async () => {
    const client = await makeUser({ password: 'Clave.Segura123' });

    const deviceA = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Clave.Segura123', deviceId: 'device-a' })
      .expect(200);
    const deviceB = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Clave.Segura123', deviceId: 'device-b' })
      .expect(200);

    // Refrescar A no debe invalidar el access token de B.
    await request(app)
      .post('/api/v1/auth/refresh-token')
      .send({ refreshToken: deviceA.body.data.refreshToken })
      .expect(200);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${deviceB.body.data.accessToken}`)
      .expect(200);
  });

  it('cerrar sesión revoca el access token de inmediato, no solo el refresh token', async () => {
    const client = await makeUser({ password: 'Clave.Segura123' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: client.phone, password: 'Clave.Segura123' })
      .expect(200);

    const header = { Authorization: `Bearer ${login.body.data.accessToken}` };
    await request(app).get('/api/v1/auth/me').set(header).expect(200);
    await request(app).post('/api/v1/auth/logout').set(header).send({ refreshToken: login.body.data.refreshToken }).expect(200);

    // El access token, aunque no haya caducado, ya no sirve.
    await request(app).get('/api/v1/auth/me').set(header).expect(401);
  });
});

// ── Fase 10: intentos adicionales que deben fallar de forma controlada ──

describe('Otros intentos de ataque que deben fallar de forma controlada', () => {
  it('no se puede recuperar el acceso a una cuenta ya anonimizada', async () => {
    const user = await makeUser({ password: 'Clave.Segura123' });
    await authService.deleteOwnAccount(user._id.toString(), { password: 'Clave.Segura123' });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: user.phone, password: 'Clave.Segura123' });
    // El teléfono ya no es el mismo (se anonimizó), así que ni siquiera
    // encuentra la cuenta con las credenciales originales.
    expect(res.status).toBe(401);

    const stored = await User.findById(user._id);
    expect(stored!.anonymizedAt).toBeTruthy();
    expect(stored!.isActive).toBe(false);
  });

  it('un domiciliario no asignado no ve el teléfono del cliente en "pedidos disponibles"', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const client = await makeUser({ role: UserRole.CLIENT });
    const product = await makeProduct(business._id);

    const order = await Order.create({
      orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      clientId: client._id,
      businessId: business._id,
      driverId: null,
      items: [{ productId: product._id, productName: product.name, quantity: 1, unitPrice: product.price, totalPrice: product.price }],
      status: OrderStatus.READY,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      deliveryAddress: 'Calle falsa 123',
      deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      subtotal: product.price,
      deliveryFee: 4000,
      total: product.price + 4000,
      platformCommission: 0,
      businessPayout: product.price,
      driverPayout: 4000,
    });

    const res = await request(app)
      .get('/api/v1/orders/driver/available')
      .set(await authHeader(driverUser))
      .expect(200);

    const found = res.body.data.find((o: any) => o._id === order._id.toString());
    expect(found).toBeTruthy();
    expect(found.clientId?.phone).toBeUndefined();
  });

  it('la contraseña de una cuenta con 2FA activo, sin el TOTP, nunca abre sesión aunque se reintente', async () => {
    const user = await makeUser({ password: 'Clave.Segura123' });
    const setup = await authService.setup2FA(user._id.toString());
    await authService.verify2FASetup(user._id.toString(), speakeasy.totp({ secret: setup.secret, encoding: 'base32' }));

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: user.phone, password: 'Clave.Segura123' });
      expect(res.body.data.requiresTOTP).toBe(true);
      expect(res.body.data.accessToken).toBeUndefined();
    }
  });
});

// ── A11 — Límite máximo de paginación ──────────────────────────────────

describe('A11 — ningún listado acepta un `limit` sin techo', () => {
  it('el listado público de negocios ignora un limit absurdo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id);

    const res = await request(app).get('/api/v1/businesses').query({ limit: 999999999 }).expect(200);
    expect(res.body.meta.limit).toBeLessThanOrEqual(50);
  });

  it('el panel de administración de usuarios también lo ignora', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .get('/api/v1/admin/users')
      .query({ limit: 999999999 })
      .set(await authHeader(admin))
      .expect(200);
    expect(res.body.meta.limit).toBeLessThanOrEqual(50);
  });
});
