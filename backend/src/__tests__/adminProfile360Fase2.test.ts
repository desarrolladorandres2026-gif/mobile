import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { User, Address, SavedCard, ProSubscription, DataRequest, DriverDocument, Driver } from '../models';
import { AuditLog, AuditAction, AuditSeverity } from '../security';
import { Permission } from '../security/rbac';
import { UserRole } from '../types';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, makeStaff, makeDriver, makeBusiness, authHeader } from './factories';

/** B6 (Fase 2 del panel admin): fichas 360 del cliente y del domiciliario. */

const A = '/api/v1/admin';
const LIMITED = [Permission.ADMIN_PANEL, Permission.USERS_VIEW, Permission.DRIVERS_VIEW];

async function waitForAudit(filter: Record<string, unknown>) {
  for (let i = 0; i < 40; i++) {
    const f = await AuditLog.findOne(filter).lean();
    if (f) return f;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('B6: ficha 360 del cliente', () => {
  let client: any;
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    client = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: client._id }, { documentNumber: '1075123456', marketingConsent: true });
    await Address.create({
      userId: client._id, label: 'Casa', address: 'Calle 9 # 8-77 Apto 302', neighborhood: 'Centro', city: 'Garzón',
      location: { type: 'Point', coordinates: [-75.6, 2.2] },
    });
    await SavedCard.create({
      userId: client._id, gatewaySourceId: 987654, provider: 'wompi', brand: 'VISA', lastFour: '4242', expMonth: '08', expYear: '29',
    });
    await ProSubscription.create({ userId: client._id, planId: 'monthly', price: 9900, status: 'active' });
    await DataRequest.create({ userId: client._id, type: 'access', detail: 'Quiero mis datos' });
  });

  it('por defecto sale enmascarada, incluso para el Super Administrador', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app).get(`${A}/users/${client._id}/profile-360`).set(await authHeader(su)).expect(200);
    const raw = JSON.stringify(res.body);
    expect(res.body.data.view).toBe('masked');
    expect(raw).not.toContain('1075123456');
    expect(raw).not.toContain('Apto 302');
    expect(raw).not.toContain('987654');
    expect(raw).not.toMatch(/gatewaySourceId|ipHash/);
    expect(res.body.data.addresses[0]).toMatchObject({ label: 'Casa', neighborhood: 'Centro', city: 'Garzón' });
    expect(res.body.data.addresses[0].address).toBeUndefined();
    expect(res.body.data.savedCards[0]).toMatchObject({ brand: 'VISA', last4: '4242', expMonth: '08', expYear: '29' });
    expect(res.body.data.pro).toMatchObject({ status: 'active', plan: 'monthly' });
    expect(res.body.data.consents.marketingConsent).toBe(true);
    expect(res.body.data.dataRequests).toHaveLength(1);
    expect(res.body.data.refunds).toEqual([]);
    expect(res.body.data.notes).toEqual([]);
  });

  it('secciones con permiso propio: null sin refunds:view ni legal:view', async () => {
    const limited = await makeStaff({ roleSlug: 'soporte', permissions: LIMITED });
    const res = await request(app).get(`${A}/users/${client._id}/profile-360`).set(await authHeader(limited)).expect(200);
    expect(res.body.data.refunds).toBeNull();
    expect(res.body.data.dataRequests).toBeNull();
    expect(res.body.data.savedCards).toHaveLength(1);
  });

  it('view=full: 403 sin users:view_sensitive; valor desconocido: 400', async () => {
    const limited = await makeStaff({ roleSlug: 'soporte', permissions: LIMITED });
    await request(app).get(`${A}/users/${client._id}/profile-360?view=full`).set(await authHeader(limited)).expect(403);
    await request(app).get(`${A}/users/${client._id}/profile-360?view=otra`).set(await authHeader(limited)).expect(400);
  });

  it('view=full: 200 con permiso, datos exactos, tarjeta sin token y auditoría MEDIUM', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app).get(`${A}/users/${client._id}/profile-360?view=full`).set(await authHeader(su)).expect(200);
    expect(res.body.data.view).toBe('full');
    expect(res.body.data.user.documentNumber).toBe('1075123456');
    expect(res.body.data.addresses[0].address).toBe('Calle 9 # 8-77 Apto 302');
    expect(JSON.stringify(res.body)).not.toContain('987654');
    const log: any = await waitForAudit({ action: AuditAction.PROFILE_VIEWED, severity: AuditSeverity.MEDIUM, entityId: client._id.toString() });
    expect(log?.metadata?.view).toBe('full');
  });

  it('actionsOnUser: quién bloqueó, con metadatos por lista blanca', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin', name: 'Jefa Seg' });
    await AuditLog.create({
      userId: su._id.toString(), role: 'admin', action: AuditAction.USER_BLOCKED, entity: 'user', entityId: client._id.toString(),
      description: 'Bloqueado', ip: '1.2.3.4', metadata: { reason: 'fraude', secretIp: '9.9.9.9' },
    });
    const res = await request(app).get(`${A}/users/${client._id}/profile-360`).set(await authHeader(su)).expect(200);
    const a = res.body.data.actionsOnUser.find((x: any) => x.action === AuditAction.USER_BLOCKED);
    expect(a.actorName).toBe('Jefa Seg');
    expect(a.metadata).toEqual({ reason: 'fraude' });
    expect(JSON.stringify(res.body.data.actionsOnUser)).not.toContain('1.2.3.4');
  });

  it('no es accesible para clientes, comercios ni domiciliarios', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id);
    const dUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(dUser._id);
    for (const u of [client, owner, dUser]) {
      await request(app).get(`${A}/users/${client._id}/profile-360`).set(await authHeader(u)).expect(403);
    }
  });
});

describe('B6: ficha 360 del domiciliario (H5)', () => {
  let driver: any;
  let driverPhone: string;
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    const u = await makeUser({ role: UserRole.DRIVER });
    await User.updateOne({ _id: u._id }, { documentNumber: '1075999888' });
    driverPhone = u.phone as string;
    driver = await makeDriver(u._id);
    await Driver.updateOne({ _id: driver._id }, { totalEarnings: 90000 });
    await DriverDocument.create({ driverId: driver._id, type: 'license', reference: 'LIC-123456789', status: 'approved' });
  });

  it('sin finance:view: finance null y sin fondo ni ganancias en driver', async () => {
    const s = await makeStaff({ roleSlug: 'soporte', permissions: LIMITED });
    const res = await request(app).get(`${A}/drivers/${driver._id}/profile-360`).set(await authHeader(s)).expect(200);
    expect(res.body.data.finance).toBeNull();
    expect(res.body.data.driver.baseFund).toBeUndefined();
    expect(res.body.data.driver.currentFund).toBeUndefined();
    expect(res.body.data.driver.totalEarnings).toBeUndefined();
    expect(res.body.data.masked).toEqual({ finance: true, sensitive: true });
  });

  it('sin users:view_sensitive: reference a 4 dígitos, sin cédula completa; el teléfono sigue visible', async () => {
    const s = await makeStaff({ roleSlug: 'soporte', permissions: LIMITED });
    const res = await request(app).get(`${A}/drivers/${driver._id}/profile-360`).set(await authHeader(s)).expect(200);
    const raw = JSON.stringify(res.body);
    expect(res.body.data.documents[0].reference).toBe('6789');
    expect(raw).not.toContain('LIC-123456789');
    expect(raw).not.toContain('1075999888');
    expect(res.body.data.driver.userId.documentNumberLast4).toBe('9888');
    expect(res.body.data.driver.userId.phone).toBe(driverPhone);
    expect(res.body.data.notes).toEqual([]);
  });

  it('view=full: 403 sin users:view_sensitive, 400 si es inválido', async () => {
    const s = await makeStaff({ roleSlug: 'soporte', permissions: LIMITED });
    await request(app).get(`${A}/drivers/${driver._id}/profile-360?view=full`).set(await authHeader(s)).expect(403);
    await request(app).get(`${A}/drivers/${driver._id}/profile-360?view=x`).set(await authHeader(s)).expect(400);
  });

  it('por defecto masked incluso con users:view_sensitive; view=full audita MEDIUM', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const def = await request(app).get(`${A}/drivers/${driver._id}/profile-360`).set(await authHeader(su)).expect(200);
    expect(def.body.data.view).toBe('masked');
    expect(def.body.data.documents[0].reference).toBe('6789');
    const full = await request(app).get(`${A}/drivers/${driver._id}/profile-360?view=full`).set(await authHeader(su)).expect(200);
    expect(full.body.data.view).toBe('full');
    const log: any = await waitForAudit({ action: AuditAction.PROFILE_VIEWED, severity: AuditSeverity.MEDIUM, entityId: driver._id.toString() });
    expect(log?.metadata?.view).toBe('full');
  });

  it('con finance:view y view=full: completo', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app).get(`${A}/drivers/${driver._id}/profile-360?view=full`).set(await authHeader(su)).expect(200);
    expect(res.body.data.finance).toMatchObject({ baseFund: 50000, totalEarnings: 90000 });
    expect(res.body.data.documents[0].reference).toBe('LIC-123456789');
    expect(res.body.data.driver.userId.documentNumber).toBe('1075999888');
  });

  it('no es accesible para clientes ni comercios', async () => {
    const c = await makeUser({ role: UserRole.CLIENT });
    const o = await makeUser({ role: UserRole.BUSINESS });
    for (const u of [c, o]) await request(app).get(`${A}/drivers/${driver._id}/profile-360`).set(await authHeader(u)).expect(403);
  });
});

describe('B6: límites atómicos y logs sin query', () => {
  it('notas: ráfaga simultánea no supera el tope por minuto', async () => {
    const { internalNoteService, NOTE_RATE_LIMIT_PER_MINUTE } = await import('../services/internalNote.service');
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const target = await makeUser({ role: UserRole.CLIENT });
    const actor = await internalNoteService.noteActorFromRequest({ user: su, permissions: Object.values(Permission) } as any);
    const results = await Promise.allSettled(
      Array.from({ length: NOTE_RATE_LIMIT_PER_MINUTE + 10 }, (_, i) =>
        internalNoteService.create({ entityType: 'user', entityId: target._id.toString(), body: `nota ${i}`, actor })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(NOTE_RATE_LIMIT_PER_MINUTE);
  });

  it('request-documents: dos clics simultáneos mandan un solo aviso', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const biz = await makeBusiness(owner._id);
    const h = await authHeader(su);
    const send = () =>
      request(app).post(`${A}/businesses/${biz._id}/request-documents`).set(h).send({ types: ['rut'] });
    const rs = await Promise.all([send(), send(), send()]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 429, 429]);
  });

  it('alertas: markSeen rechaza claves mal formadas y no siembra alertas invisibles', async () => {
    const { alertsService } = await import('../services/alerts.service');
    const { AlertReceipt } = await import('../models/AlertReceipt');
    const su = await makeStaff({ roleSlug: 'super_admin' });
    await expect(alertsService.markSeen(String(su._id), ['basura'])).rejects.toThrow();
    const ghost = `sos:${'a'.repeat(24)}:open`;
    await alertsService.markSeen(String(su._id), [ghost], () => true);
    expect(await AlertReceipt.countDocuments({ key: ghost })).toBe(0);
  });

  it('el audit por defecto no guarda la query (?search= / ?q=)', async () => {
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const { logAudit } = await import('../security');
    await logAudit({ user: su, method: 'GET', originalUrl: '/api/v1/admin/search?q=3001234567', headers: {}, ip: '1.1.1.1' } as any, {
      action: AuditAction.ADMIN_SEARCH, entity: 'admin_search', description: 'x',
    });
    const log: any = await AuditLog.findOne({ action: AuditAction.ADMIN_SEARCH, entity: 'admin_search' }).sort({ timestamp: -1 }).lean();
    expect(JSON.stringify(log)).not.toContain('3001234567');
    expect(log.metadata.path).toBe('/api/v1/admin/search');
  });
});
