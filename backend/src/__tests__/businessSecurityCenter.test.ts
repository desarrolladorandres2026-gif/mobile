import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import speakeasy from 'speakeasy';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, Notification, SecurityEvent, SecurityEventType, User } from '../models';
import {
  AuditAction,
  AuditLog,
  DeviceFingerprint,
  Permission,
  Session,
  normalizeClientDeviceId,
  parseUserAgent,
  sealTotpSecret,
} from '../security';
import { BusinessRole } from '../models/BusinessStaff';
import { UserRole } from '../types';
import { NEW_DEVICE_MESSAGE } from '../services/securityEvent.service';
import { featureFlagService } from '../services/featureFlag.service';
import { makeBusiness, makeStaff, makeUser, authHeader } from './factories';

/**
 * Centro de seguridad de comercios: identificación de dispositivos, historial
 * (`SecurityEvent`) y el panel admin `/admin/businesses/:id/security/*`.
 */
const API = '/api/v1';
const PASSWORD = 'Clave.Segura123';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/128.0.2739.42`;
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// `desktop/src/main/window.ts` añade este sufijo al UA por defecto de
// Electron (que de otro modo diría "Chrome · Windows").
const ZIPP_NEGOCIOS_WIN = `${CHROME_WIN} Electron/33.4.11 ZippNegocios/0.1.0`;

interface LoginOptions {
  deviceId?: string | null;
  ua?: string;
  ip?: string;
}

/** Login real por el endpoint, como lo hace el panel de comercios. */
async function login(email: string, opts: LoginOptions = {}) {
  let req = request(app).post(`${API}/auth/login`).set('User-Agent', opts.ua ?? CHROME_WIN);
  if (opts.deviceId) req = req.set('X-Device-ID', opts.deviceId);
  if (opts.ip) req = req.set('X-Forwarded-For', opts.ip);
  const res = await req.send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data as { accessToken: string; refreshToken: string; requiresTOTP?: boolean; challengeToken?: string };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ownerWithBusiness(name = 'Panadería Centro') {
  const owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueña Prueba' });
  const business = await makeBusiness(owner._id, { name });
  return { owner, business, businessId: String(business._id) };
}

/** Admin con `security:view` + `security:manage` (sin ser Super Administrador) y 2FA con secreto conocido. */
async function securityAdmin(permissions = [Permission.SECURITY_VIEW, Permission.SECURITY_MANAGE, Permission.BUSINESSES_VIEW, Permission.ADMIN_PANEL]) {
  const admin = await makeStaff({ roleSlug: 'seguridad_prueba' as never, permissions });
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  await User.updateOne({ _id: admin._id }, { $set: { twoFactorEnabled: true, twoFactorSecret: sealTotpSecret(secret) } });
  return { admin, header: await authHeader(admin), totp: (offset = 0) => speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + offset }) };
}

const events = (userId: unknown, type?: SecurityEventType) =>
  SecurityEvent.find({ userId, ...(type ? { type } : {}) }).sort({ createdAt: 1 }).lean();

describe('Identificación de dispositivos', () => {
  it('solo acepta como identificador un UUID v4; cualquier otra cosa es "no identificado"', () => {
    const id = randomUUID();
    expect(normalizeClientDeviceId(id.toUpperCase())).toBe(id);
    for (const bad of ['', 'abc', '12345678-1234-1234-1234-123456789012', `${id}x`, 42, null, undefined, { $ne: 1 }]) {
      expect(normalizeClientDeviceId(bad)).toBeNull();
    }
  });

  it('lee navegador, versión y sistema del User-Agent sin confundir Edge con Chrome', () => {
    expect(parseUserAgent(CHROME_WIN)).toMatchObject({ browser: 'Chrome', browserVersion: '128', os: 'Windows', platform: 'desktop' });
    expect(parseUserAgent(EDGE_WIN)).toMatchObject({ browser: 'Edge', browserVersion: '128', os: 'Windows' });
    expect(parseUserAgent(SAFARI_IPHONE)).toMatchObject({ browser: 'Safari', browserVersion: '17', os: 'iOS', osVersion: '17.5', platform: 'mobile' });
  });

  it('etiqueta Zipp Negocios (app de escritorio) en vez de Chrome, con su versión', () => {
    expect(parseUserAgent(ZIPP_NEGOCIOS_WIN)).toMatchObject({
      browser: 'Zipp Negocios', os: 'Windows', platform: 'desktop', appVersion: '0.1.0',
    });
  });

  it('crea la sesión con el dispositivo del cliente, el método y sin 2FA; y la registra en el historial', async () => {
    const { owner, business } = await ownerWithBusiness();
    const deviceId = randomUUID();
    const { accessToken } = await login(owner.email!, { deviceId });

    const session = await Session.findOne({ userId: String(owner._id) }).lean();
    expect(session).toMatchObject({ deviceId, identified: true, authMethod: 'password', mfa: false, isActive: true });
    expect(session!.deviceInfo).toMatchObject({ browser: 'Chrome', os: 'Windows' });
    expect((session as any).tokenHash).toBeTruthy(); // hash, nunca el token
    expect(JSON.stringify(session)).not.toContain(accessToken);

    const [ok] = await events(owner._id, SecurityEventType.LOGIN_SUCCESS);
    expect(ok.businessIds.map(String)).toEqual([String(business._id)]);
    expect(ok.deviceId).toBe(deviceId);
    expect(ok.result).toBe('success');
  });

  it('sin identificador válido la sesión queda "no identificada" y cada acceso cuenta como dispositivo nuevo', async () => {
    const { owner } = await ownerWithBusiness();
    await login(owner.email!, { deviceId: 'no-es-un-uuid' });
    await login(owner.email!);

    const sessions = await Session.find({ userId: String(owner._id) }).lean();
    expect(sessions.every((s) => s.identified === false)).toBe(true);
    // Omitir la cabecera no sirve para parecer un dispositivo conocido.
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(2);
  });

  it('las cuentas de cliente no dejan historial de comercio', async () => {
    const client = await makeUser({ role: UserRole.CLIENT, email: 'cliente@zipp.test' });
    await request(app).post(`${API}/auth/login`).send({ phone: client.phone, password: PASSWORD }).expect(200);
    expect(await SecurityEvent.countDocuments({ userId: client._id })).toBe(0);
  });
});

describe('Varios dispositivos y detección de nuevo dispositivo', () => {
  it('un mismo usuario abre sesiones independientes desde varios dispositivos', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const pc = randomUUID();
    const phone = randomUUID();
    const a = await login(owner.email!, { deviceId: pc });
    const b = await login(owner.email!, { deviceId: phone, ua: SAFARI_IPHONE });

    await request(app).get(`${API}/auth/me`).set(bearer(a.accessToken)).expect(200);
    await request(app).get(`${API}/auth/me`).set(bearer(b.accessToken)).expect(200);
    expect(await DeviceFingerprint.countDocuments({ userId: String(owner._id) })).toBe(2);

    const { header } = await securityAdmin();
    const res = await request(app).get(`${API}/admin/businesses/${businessId}/security/sessions`).set(header).expect(200);
    expect(res.body.data.sessions).toHaveLength(2);
    expect(res.body.data.sessions.map((s: any) => s.device.os).sort()).toEqual(['Windows', 'iOS']);
    // Ni hashes ni el identificador entero salen por la API.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain(pc);
    expect(res.body.data.sessions.find((s: any) => s.device.os === 'Windows').device.shortId).toBe(pc.slice(0, 8));
  });

  it('dos accesos simultáneos desde el mismo equipo no pierden la cuenta de inicios (upsert atómico)', async () => {
    const { owner } = await ownerWithBusiness();
    const deviceId = randomUUID();
    await Promise.all([login(owner.email!, { deviceId }), login(owner.email!, { deviceId })]);
    const fp = await DeviceFingerprint.findOne({ userId: String(owner._id), deviceId }).lean();
    expect(fp!.loginCount).toBe(2);
  });

  it('avisa del dispositivo nuevo solo cuando la cuenta ya tenía accesos, y no repite con un equipo conocido', async () => {
    const { owner } = await ownerWithBusiness();
    const known = randomUUID();

    await login(owner.email!, { deviceId: known });
    // Primer acceso de la cuenta: se registra, pero no se avisa (no hay con qué comparar).
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(1);
    expect(await Notification.countDocuments({ userId: owner._id })).toBe(0);

    await login(owner.email!, { deviceId: known });
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(1);

    await login(owner.email!, { deviceId: randomUUID(), ua: EDGE_WIN });
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(2);
    const notice = await Notification.findOne({ userId: owner._id }).lean();
    expect(notice!.body).toBe(NEW_DEVICE_MESSAGE);
    expect((notice!.data as any).kind).toBe('new_device');
  });
});

describe('2FA y sesiones', () => {
  it('el reto 2FA conserva el dispositivo, marca la sesión como verificada y registra éxito y fallo', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    await User.updateOne({ _id: owner._id }, { $set: { twoFactorEnabled: true, twoFactorSecret: sealTotpSecret(secret) } });
    const deviceId = randomUUID();

    const first = await login(owner.email!, { deviceId });
    expect(first.requiresTOTP).toBe(true);

    const bad = await request(app).post(`${API}/auth/2fa/challenge`).send({ challengeToken: first.challengeToken, code: '000000' });
    expect(bad.status).toBe(401);
    expect(await events(owner._id, SecurityEventType.TWO_FACTOR_FAILED)).toHaveLength(1);

    // Un reto falsificado con el id ajeno no ensucia el historial de nadie.
    await request(app).post(`${API}/auth/2fa/challenge`).send({ challengeToken: `${owner._id}.${'x'.repeat(40)}`, code: '000000' });
    expect(await events(owner._id, SecurityEventType.TWO_FACTOR_FAILED)).toHaveLength(1);

    const ok = await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .set('X-Device-ID', deviceId)
      .set('User-Agent', CHROME_WIN)
      .send({ challengeToken: first.challengeToken, code: speakeasy.totp({ secret, encoding: 'base32' }) })
      .expect(200);

    const session = await Session.findOne({ userId: String(owner._id), isActive: true }).lean();
    expect(session).toMatchObject({ deviceId, identified: true, mfa: true });
    expect(await events(owner._id, SecurityEventType.TWO_FACTOR_SUCCESS)).toHaveLength(1);
    const [success] = await events(owner._id, SecurityEventType.LOGIN_SUCCESS);
    expect(success.metadata).toMatchObject({ mfa: true, identified: true });

    // La revocación también corta una sesión que pasó por 2FA.
    const { header } = await securityAdmin();
    await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/sessions/${session!._id}/revoke`)
      .set(header)
      .send({ reason: 'Acceso reportado por la dueña' })
      .expect(200);
    const after = await request(app).get(`${API}/auth/me`).set(bearer(ok.body.data.accessToken));
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
  });
});

describe('Revocaciones desde el panel admin', () => {
  it('cierra una sesión concreta, deja viva la otra y registra quién y por qué', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const a = await login(owner.email!, { deviceId: randomUUID() });
    const b = await login(owner.email!, { deviceId: randomUUID() });
    const target = await Session.findOne({ userId: String(owner._id) }).sort({ createdAt: 1 }).lean();

    const { admin, header } = await securityAdmin();
    const url = `${API}/admin/businesses/${businessId}/security/sessions/${target!._id}/revoke`;

    const noReason = await request(app).post(url).set(header).send({});
    expect(noReason.status).toBe(400);

    await request(app).post(url).set(header).send({ reason: 'Equipo prestado' }).expect(200);
    expect((await request(app).get(`${API}/auth/me`).set(bearer(a.accessToken))).status).toBe(401);
    await request(app).get(`${API}/auth/me`).set(bearer(b.accessToken)).expect(200);

    const revoked = await Session.findById(target!._id).lean();
    expect(revoked).toMatchObject({ isActive: false, revokedReason: 'admin', revokedBy: String(admin._id) });

    const [ev] = await events(owner._id, SecurityEventType.ADMIN_SESSION_REVOCATION);
    expect(ev).toMatchObject({ note: 'Equipo prestado', reason: 'admin', sessionId: String(target!._id) });
    expect(String(ev.actorId)).toBe(String(admin._id));
    expect(await AuditLog.countDocuments({ action: AuditAction.SESSION_REVOKED, entityId: String(target!._id) })).toBe(1);

    // Otra vez: ya estaba cerrada.
    expect((await request(app).post(url).set(header).send({ reason: 'Equipo prestado' })).status).toBe(409);
  });

  it('cerrar todas las del negocio exige TOTP y alcanza al dueño y al personal activo', async () => {
    const { owner, business, businessId } = await ownerWithBusiness();
    const cashier = await makeUser({ role: UserRole.BUSINESS, name: 'Cajero' });
    await BusinessStaff.create({ businessId: business._id, userId: cashier._id, role: BusinessRole.OPERATOR });
    await login(owner.email!, { deviceId: randomUUID() });
    await login(cashier.email!, { deviceId: randomUUID() });

    const { header, totp } = await securityAdmin();
    const url = `${API}/admin/businesses/${businessId}/security/revoke-all`;

    const noTotp = await request(app).post(url).set(header).send({ reason: 'Sospecha de acceso ajeno', totpToken: '000000' });
    expect(noTotp.status).toBe(401);
    expect(await Session.countDocuments({ userId: { $in: [String(owner._id), String(cashier._id)] }, isActive: true })).toBe(2);

    const res = await request(app).post(url).set(header).send({ reason: 'Sospecha de acceso ajeno', totpToken: totp() }).expect(200);
    expect(res.body.data).toMatchObject({ revoked: 2, users: 2, skipped: 0 });
    expect(await Session.countDocuments({ userId: { $in: [String(owner._id), String(cashier._id)] }, isActive: true })).toBe(0);
    expect(await events(cashier._id, SecurityEventType.ADMIN_SESSION_REVOCATION)).toHaveLength(1);
  });

  it('cerrar las de una persona exige TOTP y solo toca a esa persona', async () => {
    const { owner, business, businessId } = await ownerWithBusiness();
    const manager = await makeUser({ role: UserRole.BUSINESS, name: 'Encargado' });
    await BusinessStaff.create({ businessId: business._id, userId: manager._id, role: BusinessRole.MANAGER });
    await login(owner.email!, { deviceId: randomUUID() });
    await login(manager.email!, { deviceId: randomUUID() });

    const { header, totp } = await securityAdmin();
    const res = await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/users/${manager._id}/revoke-all`)
      .set(header)
      .send({ reason: 'Ya no trabaja aquí', totpToken: totp() })
      .expect(200);
    expect(res.body.data.revoked).toBe(1);
    expect(await Session.countDocuments({ userId: String(manager._id), isActive: true })).toBe(0);
    expect(await Session.countDocuments({ userId: String(owner._id), isActive: true })).toBe(1);
  });

  it('una cuenta administrativa que es empleada del comercio no se toca desde aquí', async () => {
    const { business, businessId } = await ownerWithBusiness();
    const adminStaff = await makeUser({ role: UserRole.ADMIN, name: 'Admin empleado' });
    await BusinessStaff.create({ businessId: business._id, userId: adminStaff._id, role: BusinessRole.OPERATOR });
    await authHeader(adminStaff);
    const session = await Session.findOne({ userId: String(adminStaff._id) }).lean();

    const { header } = await securityAdmin();
    const res = await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/sessions/${session!._id}/revoke`)
      .set(header)
      .send({ reason: 'Intento lateral' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ACCOUNT_PROTECTED');
    expect((await Session.findById(session!._id).lean())!.isActive).toBe(true);
  });
});

describe('Aislamiento entre negocios y permisos', () => {
  it('no deja ver ni cerrar sesiones de otro negocio a través de la ruta de este', async () => {
    const a = await ownerWithBusiness('Negocio A');
    const b = await ownerWithBusiness('Negocio B');
    await login(a.owner.email!, { deviceId: randomUUID() });
    await login(b.owner.email!, { deviceId: randomUUID() });
    const sessionOfB = await Session.findOne({ userId: String(b.owner._id) }).lean();
    const deviceOfB = await DeviceFingerprint.findOne({ userId: String(b.owner._id) }).lean();

    const { header } = await securityAdmin();
    const revoke = await request(app)
      .post(`${API}/admin/businesses/${a.businessId}/security/sessions/${sessionOfB!._id}/revoke`)
      .set(header)
      .send({ reason: 'Prueba cruzada' });
    expect(revoke.status).toBe(404);
    expect((await Session.findById(sessionOfB!._id).lean())!.isActive).toBe(true);

    expect((await request(app).get(`${API}/admin/businesses/${a.businessId}/security/devices/${deviceOfB!._id}`).set(header)).status).toBe(404);

    const list = await request(app).get(`${API}/admin/businesses/${a.businessId}/security/sessions`).set(header).expect(200);
    expect(list.body.data.sessions.map((s: any) => s.user.id)).toEqual([String(a.owner._id)]);
    const history = await request(app).get(`${API}/admin/businesses/${a.businessId}/security/events`).set(header).expect(200);
    expect(history.body.data.events.every((e: any) => e.user.id === String(a.owner._id))).toBe(true);
  });

  it('RBAC: ver exige security:view; cerrar, security:manage; un comercio no entra; el CSV es de Super Administrador', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const { accessToken } = await login(owner.email!, { deviceId: randomUUID() });
    const session = await Session.findOne({ userId: String(owner._id) }).lean();

    // Con el RBAC en modo observación, el tipo de cuenta `admin` legacy ya trae
    // `security:view`; lo que se prueba aquí es el permiso estricto.
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    const noView = await makeStaff({ roleSlug: 'sin_seguridad' as never, permissions: [Permission.BUSINESSES_VIEW, Permission.ADMIN_PANEL] });
    expect((await request(app).get(`${API}/admin/businesses/${businessId}/security/summary`).set(await authHeader(noView))).status).toBe(403);

    const viewer = await securityAdmin([Permission.SECURITY_VIEW, Permission.BUSINESSES_VIEW, Permission.ADMIN_PANEL]);
    await request(app).get(`${API}/admin/businesses/${businessId}/security/summary`).set(viewer.header).expect(200);
    const denied = await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/sessions/${session!._id}/revoke`)
      .set(viewer.header)
      .send({ reason: 'Sin permiso' });
    expect(denied.status).toBe(403);

    expect((await request(app).get(`${API}/admin/businesses/${businessId}/security/summary`).set(bearer(accessToken))).status).toBe(403);

    const exportRes = await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/export`)
      .set(viewer.header)
      .send({ reason: 'Revisión mensual', totpToken: viewer.totp() });
    expect(exportRes.status).toBe(403);
  });

  it('un Super Administrador exporta el historial en CSV con motivo y TOTP', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    await login(owner.email!, { deviceId: randomUUID() });
    const superAdmin = await makeStaff({ roleSlug: 'super_admin' });
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    await User.updateOne({ _id: superAdmin._id }, { $set: { twoFactorEnabled: true, twoFactorSecret: sealTotpSecret(secret) } });

    const res = await request(app)
      .post(`${API}/admin/businesses/${businessId}/security/export`)
      .set(await authHeader(superAdmin))
      .send({ reason: 'Reclamo del comercio', totpToken: speakeasy.totp({ secret, encoding: 'base32' }) })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Acceso exitoso');
    expect(await AuditLog.countDocuments({ action: AuditAction.DATA_EXPORTED, entityId: businessId })).toBe(1);
  });
});

describe('Historial: eventos, inmutabilidad, IP y reuso de tokens', () => {
  it('registra acceso fallido, cierre de sesión, cierre remoto y cambio de contraseña', async () => {
    const { owner } = await ownerWithBusiness();
    const bad = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: 'Equivocada.123' });
    expect(bad.status).toBe(401);
    expect(await events(owner._id, SecurityEventType.LOGIN_FAILED)).toHaveLength(1);

    const a = await login(owner.email!, { deviceId: randomUUID() });
    const b = await login(owner.email!, { deviceId: randomUUID() });
    const sessionOfB = await Session.findOne({ userId: String(owner._id) }).sort({ createdAt: -1 }).lean();
    await request(app).delete(`${API}/auth/sessions/${sessionOfB!._id}`).set(bearer(a.accessToken)).expect(200);
    expect(await events(owner._id, SecurityEventType.REMOTE_LOGOUT)).toHaveLength(1);
    expect((await request(app).get(`${API}/auth/me`).set(bearer(b.accessToken))).status).toBe(401);

    await request(app)
      .post(`${API}/auth/change-password`)
      .set(bearer(a.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'Nueva.Clave456' })
      .expect(200);
    const [changed] = await events(owner._id, SecurityEventType.PASSWORD_CHANGED);
    expect(changed.metadata).toMatchObject({ how: 'change' });

    const c = await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: 'Nueva.Clave456' }).expect(200);
    await request(app).post(`${API}/auth/logout`).set(bearer(c.body.data.accessToken)).send({}).expect(200);
    expect(await events(owner._id, SecurityEventType.LOGOUT)).toHaveLength(1);
  });

  it('el historial no se edita ni se borra desde la aplicación', async () => {
    const { owner } = await ownerWithBusiness();
    await login(owner.email!, { deviceId: randomUUID() });
    await expect(SecurityEvent.updateOne({ userId: owner._id }, { $set: { ip: '1.1.1.1' } })).rejects.toThrow(/inmutable/);
    await expect(SecurityEvent.deleteMany({ userId: owner._id })).rejects.toThrow(/inmutable/);
    const doc = await SecurityEvent.findOne({ userId: owner._id });
    doc!.ip = '1.1.1.1';
    await expect(doc!.save()).rejects.toThrow(/inmutable/);
  });

  it('un cambio de IP no cierra la sesión: se registra una sola vez como IP nueva', async () => {
    const { owner } = await ownerWithBusiness();
    await login(owner.email!, { deviceId: randomUUID(), ip: '181.50.1.10' });
    const { refreshToken } = await login(owner.email!, { deviceId: randomUUID(), ip: '181.50.1.10' });

    const r1 = await request(app).post(`${API}/auth/refresh-token`).set('X-Forwarded-For', '190.24.7.7').send({ refreshToken }).expect(200);
    const session = await Session.findOne({ userId: String(owner._id), isActive: true }).sort({ createdAt: -1 }).lean();
    expect(session).toMatchObject({ ip: '181.50.1.10', lastIp: '190.24.7.7', isActive: true });
    expect(await events(owner._id, SecurityEventType.NEW_IP)).toHaveLength(1);

    await request(app).post(`${API}/auth/refresh-token`).set('X-Forwarded-For', '190.24.7.7').send({ refreshToken: r1.body.data.refreshToken }).expect(200);
    expect(await events(owner._id, SecurityEventType.NEW_IP)).toHaveLength(1);
  });

  it('reusar un refresh token ya rotado cierra todo y queda como sesión revocada por reuso', async () => {
    const { owner } = await ownerWithBusiness();
    const { refreshToken } = await login(owner.email!, { deviceId: randomUUID() });
    await request(app).post(`${API}/auth/refresh-token`).send({ refreshToken }).expect(200);
    // Fuera de la ventana de gracia de 15 s.
    await Session.updateOne({ userId: String(owner._id) }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });

    const reuse = await request(app).post(`${API}/auth/refresh-token`).send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    expect(await Session.countDocuments({ userId: String(owner._id), isActive: true })).toBe(0);
    const [ev] = await events(owner._id, SecurityEventType.SESSION_REVOKED);
    expect(ev).toMatchObject({ reason: 'reuse_detected', result: 'failure' });
  });

  it('una sesión que pasó su caducidad absoluta aparece como expirada, no como activa', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const { accessToken } = await login(owner.email!, { deviceId: randomUUID() });
    await Session.updateOne({ userId: String(owner._id) }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(`${API}/auth/me`).set(bearer(accessToken))).status).toBe(401);
    const { header } = await securityAdmin();
    const base = `${API}/admin/businesses/${businessId}/security/sessions`;
    expect((await request(app).get(base).set(header).expect(200)).body.data.sessions).toHaveLength(0);
    const expired = await request(app).get(`${base}?status=expired`).set(header).expect(200);
    expect(expired.body.data.sessions).toHaveLength(1);
    expect(expired.body.data.sessions[0].status).toBe('expired');
  });
});

describe('Filtros, paginación y resumen', () => {
  it('valida los filtros y pagina de verdad', async () => {
    const { owner, business, businessId } = await ownerWithBusiness();
    const staff = await makeUser({ role: UserRole.BUSINESS, name: 'Mesero', email: 'mesero@zipp.test' });
    await BusinessStaff.create({ businessId: business._id, userId: staff._id, role: BusinessRole.OPERATOR });
    for (let i = 0; i < 3; i += 1) await login(owner.email!, { deviceId: randomUUID() });
    await login(staff.email!, { deviceId: randomUUID() });
    const { header } = await securityAdmin();
    const base = `${API}/admin/businesses/${businessId}/security`;

    expect((await request(app).get(`${base}/sessions?limit=500`).set(header)).status).toBe(400);
    expect((await request(app).get(`${base}/sessions?deviceId=$ne`).set(header)).status).toBe(400);
    expect((await request(app).get(`${base}/sessions?status=raro`).set(header)).status).toBe(400);
    expect((await request(app).get(`${base}/events?type=NO_EXISTE`).set(header)).status).toBe(400);
    expect((await request(app).get(`${base}/sessions?from=ayer`).set(header)).status).toBe(400);

    const page1 = await request(app).get(`${base}/sessions?limit=3&page=1`).set(header).expect(200);
    expect(page1.body.data.pagination).toEqual({ page: 1, limit: 3, total: 4, pages: 2 });
    const page2 = await request(app).get(`${base}/sessions?limit=3&page=2`).set(header).expect(200);
    expect(page2.body.data.sessions).toHaveLength(1);

    const byEmail = await request(app).get(`${base}/sessions?search=mesero@`).set(header).expect(200);
    expect(byEmail.body.data.sessions.map((s: any) => s.user.id)).toEqual([String(staff._id)]);

    const staffSession = await Session.findOne({ userId: String(staff._id) }).lean();
    const byDevice = await request(app).get(`${base}/sessions?deviceId=${staffSession!.deviceId.slice(0, 8)}`).set(header).expect(200);
    expect(byDevice.body.data.sessions).toHaveLength(1);

    const byUser = await request(app).get(`${base}/events?type=LOGIN_SUCCESS&userId=${owner._id}`).set(header).expect(200);
    expect(byUser.body.data.pagination.total).toBe(3);
    expect(byUser.body.data.events.every((e: any) => e.type === 'LOGIN_SUCCESS')).toBe(true);
  });

  it('el resumen cuenta sesiones abiertas, desconocidas, fallos y el estado del 2FA', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    await login(owner.email!, { deviceId: randomUUID() });
    await login(owner.email!); // sin identificador
    await request(app).post(`${API}/auth/login`).send({ email: owner.email, password: 'Equivocada.123' });

    const { header } = await securityAdmin();
    const res = await request(app).get(`${API}/admin/businesses/${businessId}/security/summary`).set(header).expect(200);
    const s = res.body.data;
    expect(s.activeSessions).toBe(2);
    // Las dos: una sin identificar y otra recién aparecida.
    expect(s.unknownActiveSessions).toBe(2);
    expect(s.knownDevices).toBe(2);
    expect(s.failedAttempts7d).toBe(1);
    expect(s.lastSuccessfulLogin.type).toBe('LOGIN_SUCCESS');
    expect(s.members).toEqual([expect.objectContaining({ userId: String(owner._id), businessRole: 'owner', twoFactorEnabled: false })]);
  });
});

describe('Hallazgos de la revisión de seguridad', () => {
  it('el identificador completo no sale por /auth/sessions ni se puede reconstruir con prefijos largos', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const deviceId = randomUUID();
    const { accessToken } = await login(owner.email!, { deviceId });

    const mine = await request(app).get(`${API}/auth/sessions`).set(bearer(accessToken)).expect(200);
    expect(JSON.stringify(mine.body)).not.toContain(deviceId);

    const { header } = await securityAdmin();
    const long = await request(app).get(`${API}/admin/businesses/${businessId}/security/sessions?deviceId=${deviceId.slice(0, 9)}`).set(header);
    expect(long.status).toBe(400);
  });

  it('un identificador conocido que llega desde otro navegador cuenta como dispositivo nuevo', async () => {
    const { owner } = await ownerWithBusiness();
    const deviceId = randomUUID();
    await login(owner.email!, { deviceId, ua: CHROME_WIN });
    await login(owner.email!, { deviceId, ua: CHROME_WIN });
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(1);

    // Mismo id copiado, pero desde un iPhone: no es el mismo equipo.
    await login(owner.email!, { deviceId, ua: SAFARI_IPHONE });
    expect(await events(owner._id, SecurityEventType.NEW_DEVICE)).toHaveLength(2);
  });

  it('un reto 2FA con secreto inventado no gasta los intentos del reto real', async () => {
    const { owner } = await ownerWithBusiness();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    await User.updateOne({ _id: owner._id }, { $set: { twoFactorEnabled: true, twoFactorSecret: sealTotpSecret(secret) } });
    const { challengeToken } = await login(owner.email!, { deviceId: randomUUID() });

    for (let i = 0; i < 6; i += 1) {
      await request(app).post(`${API}/auth/2fa/challenge`).send({ challengeToken: `${owner._id}.${'x'.repeat(40)}`, code: '000000' });
    }
    await request(app)
      .post(`${API}/auth/2fa/challenge`)
      .send({ challengeToken, code: speakeasy.totp({ secret, encoding: 'base32' }) })
      .expect(200);
  });
});
