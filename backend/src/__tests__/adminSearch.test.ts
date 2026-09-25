import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import app from '../app';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { AuditAction, AuditLog } from '../security/audit';
import { Order, User, Business } from '../models';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import adminSearchRouter from '../routes/adminSearch.routes';
import { adminSearchRateLimiter, createAdminSearchRateLimiter } from '../middlewares/security';
import { makeUser, makeBusiness, makeDriver, makeCoupon, makeStaff, authHeader, GARZON } from './factories';

const S = '/api/v1/admin/search';
const setEnforce = (on: boolean) => featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });

const staffWith = (perms: Permission[]) => makeStaff({ roleSlug: 'soporte', permissions: [Permission.ADMIN_PANEL, ...perms] });
const get = async (user: any, q: string, extra = '') =>
  request(app).get(`${S}?q=${encodeURIComponent(q)}${extra}`).set(await authHeader(user));

async function waitAudit(filter: object, n = 1) {
  for (let i = 0; i < 40; i++) {
    const rows = await AuditLog.find(filter).lean();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return AuditLog.find(filter).lean();
}

describe('B3: búsqueda global del panel admin', () => {
  let su: any;
  let phone: string;
  let email: string;
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await setEnforce(true);
    await cache.flush();
    su = await makeStaff({ roleSlug: 'super_admin' });
  });

  it('rutas: 403 para cliente, y el limitador real está montado', async () => {
    const client = await makeUser({ role: UserRole.CLIENT });
    expect((await get(client, 'pizza')).status).toBe(403);
    const handlers = (adminSearchRouter as any).stack.find((l: any) => l.route?.path === '/').route.stack.map((s: any) => s.handle);
    expect(handlers).toContain(adminSearchRateLimiter);
  });

  it('400 con q corta o larga o tipo inválido', async () => {
    expect((await get(su, 'a')).status).toBe(400);
    expect((await get(su, ' a ')).status).toBe(400);
    expect((await get(su, 'x'.repeat(65))).status).toBe(400);
    expect((await get(su, 'pizza', '&types=nada')).status).toBe(400);
    expect((await request(app).get(S).set(await authHeader(su))).status).toBe(400);
  });

  it('número de pedido con relleno a 6 ceros, con nombre del comercio', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const biz = await makeBusiness(owner._id, { name: 'Panadería Sol' } as any);
    const client = await makeUser({ role: UserRole.CLIENT });
    await Order.create({
      orderNumber: '000123', clientId: client._id, businessId: biz._id, items: [], status: 'pending',
      paymentMethod: 'cash_on_delivery', deliveryAddress: 'x', deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      subtotal: 1, deliveryFee: 1, total: 2, platformCommission: 0, businessPayout: 1, driverPayout: 1,
    } as any);
    const res = await get(su, '123');
    expect(res.status).toBe(200);
    expect(res.body.data.results.orders).toHaveLength(1);
    expect(res.body.data.results.orders[0]).toMatchObject({ orderNumber: '000123', businessName: 'Panadería Sol' });
    expect(res.body.data.results.users).toBeUndefined();
  });

  describe('teléfono y correo', () => {
    beforeEach(async () => {
      phone = '3112421673';
      email = 'juan.perez@example.com';
      await makeUser({ role: UserRole.CLIENT, name: 'Juan Pérez', phone, email });
    });

    it('teléfono exacto (con +57 y espacios) sale enmascarado y se audita con hash, nunca en claro', async () => {
      const res = await get(su, '+57 311 242 1673');
      expect(res.status).toBe(200);
      const [u] = res.body.data.results.users;
      expect(u.phoneMasked).not.toContain('311242');
      expect(u.phoneMasked.endsWith('1673')).toBe(true);
      expect(u.emailMasked).toBe('j***@example.com');
      expect(JSON.stringify(res.body)).not.toContain(phone);

      const logs = await waitAudit({ action: AuditAction.ADMIN_SEARCH });
      expect(logs).toHaveLength(1);
      const m: any = logs[0].metadata;
      expect(m.kind).toBe('phone');
      expect(m.last4).toBe('1673');
      expect(m.qHash).toMatch(/^[a-f0-9]{64}$/);
      const dump = JSON.stringify(logs);
      expect(dump).not.toContain('3112421673');
      expect(dump).not.toContain('311');
      expect(dump).not.toContain('q=');
    });

    it('correo exacto en minúsculas; auditado sin el término', async () => {
      const res = await get(su, 'Juan.Perez@Example.com');
      expect(res.body.data.results.users).toHaveLength(1);
      const logs = await waitAudit({ action: AuditAction.ADMIN_SEARCH });
      expect(JSON.stringify(logs).toLowerCase()).not.toContain('juan.perez');
      expect((logs[0].metadata as any).kind).toBe('email');
    });

    it('no hay coincidencia parcial de teléfono ni de correo', async () => {
      expect((await get(su, '3112421')).body.data.results.orders).toBeDefined();
      expect((await get(su, 'juan.perez@exam')).body.data.results.users).toEqual([]);
    });

    it('GET /admin/users?search= con teléfono o correo también audita con hash', async () => {
      const res = await request(app).get('/api/v1/admin/users?search=3112421').set(await authHeader(su));
      expect(res.status).toBe(200);
      const logs = await waitAudit({ action: AuditAction.ADMIN_SEARCH });
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain('3112421');
      expect((logs[0].metadata as any).last4).toBe('2421');
      // un nombre no audita
      await request(app).get('/api/v1/admin/users?search=Juan').set(await authHeader(su));
      expect(await AuditLog.countDocuments({ action: AuditAction.ADMIN_SEARCH })).toBe(1);
    });
  });

  it('filtrado por permiso: un tipo sin permiso ni se menciona', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS, name: 'Casa Dueña' });
    await makeBusiness(owner._id, { name: 'Casa Verde' } as any);
    await makeUser({ role: UserRole.CLIENT, name: 'Casandra' });
    await makeCoupon({ code: 'CASA10' });

    const all = await get(su, 'casa');
    expect(Object.keys(all.body.data.results).sort()).toEqual(['businesses', 'coupons', 'users']);

    const cases: Array<[Permission, string]> = [
      [Permission.BUSINESSES_VIEW, 'businesses'],
      [Permission.USERS_VIEW, 'users'],
      [Permission.COUPONS_VIEW, 'coupons'],
    ];
    for (const [perm, key] of cases) {
      const staff = await staffWith([perm]);
      const res = await get(staff, 'casa');
      expect(Object.keys(res.body.data.results), key).toEqual([key]);
    }
    const none = await staffWith([Permission.ORDERS_VIEW_ALL]);
    expect((await get(none, 'casa')).body.data.results).toEqual({});
    // types limita
    const onlyCoupons = await get(su, 'casa', '&types=coupon');
    expect(Object.keys(onlyCoupons.body.data.results)).toEqual(['coupons']);
  });

  it('placa y pedido por permiso; los domiciliarios solo con drivers:view', async () => {
    const du = await makeUser({ role: UserRole.DRIVER, name: 'Pedro Moto' });
    const d = await makeDriver(du._id);
    await (d.constructor as any).updateOne({ _id: d._id }, { licensePlate: 'ABC123' });
    const res = await get(su, 'abc-123');
    expect(res.body.data.results.drivers).toHaveLength(1);
    expect(res.body.data.results.drivers[0]).toMatchObject({ name: 'Pedro Moto', licensePlate: 'ABC123' });
    const noDrivers = await staffWith([Permission.USERS_VIEW]);
    expect((await get(noDrivers, 'ABC123')).body.data.results).toEqual({});
  });

  it('regex escapada: .* y paréntesis no rompen ni devuelven todo', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { name: 'Pizza Uno' } as any);
    await makeUser({ role: UserRole.CLIENT, name: 'Ana Gómez' });
    await makeCoupon({ code: 'PROMO1' });
    for (const q of ['.*.*', '(a+)+$', '((((', '[a-z]+', 'Ana|Pizza']) {
      const res = await get(su, q);
      expect(res.status, q).toBe(200);
      const r = res.body.data.results;
      expect([...(r.businesses ?? []), ...(r.users ?? []), ...(r.coupons ?? [])], q).toHaveLength(0);
    }
  });

  it('tope de 5 por tipo y ningún total', async () => {
    const owner = await makeUser({ role: UserRole.BUSINESS });
    for (let i = 0; i < 8; i++) await makeCoupon({ code: `VERANO${i}` });
    for (let i = 0; i < 8; i++) await makeUser({ role: UserRole.CLIENT, name: `Verónica ${i}` });
    void owner;
    const res = await get(su, 'Ver');
    expect(res.body.data.results.coupons).toHaveLength(5);
    expect(res.body.data.results.users).toHaveLength(5);
    expect(JSON.stringify(res.body)).not.toMatch(/total|count/i);
  });

  it('no busca por cédula', async () => {
    const u = await makeUser({ role: UserRole.CLIENT, name: 'Doc Persona' });
    await User.updateOne({ _id: u._id }, { documentNumber: '1075123456' });
    const r1 = await get(su, '1075123456');
    expect(r1.body.data.results.users).toEqual([]);
    expect(JSON.stringify(r1.body)).not.toContain('Doc Persona');
    const r2 = await get(su, 'CC 1075123456');
    expect(JSON.stringify(r2.body)).not.toContain('Doc Persona');
  });

  it('observe: un admin sin rol conserva la búsqueda; el cliente no', async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
    const bare = await makeStaff({ roleSlug: null });
    expect((await get(bare, 'pizza')).status).toBe(200);
  });

  it('429 con mensaje explícito y alerta HIGH sin el término', async () => {
    const probe = express();
    const user = await makeUser({ role: UserRole.ADMIN });
    probe.use((req, _res, next) => { (req as any).user = user; next(); });
    probe.get('/api/v1/admin/search', createAdminSearchRateLimiter(2), (_req, res) => res.json({ ok: true }));
    const url = '/api/v1/admin/search?q=3112421673';
    expect((await request(probe).get(url)).status).toBe(200);
    expect((await request(probe).get(url)).status).toBe(200);
    const third = await request(probe).get(url);
    expect(third.status).toBe(429);
    expect(third.body.message).toMatch(/Demasiadas búsquedas/);
    const logs = await waitAudit({ entity: 'admin_search', severity: 'high' });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('3112421673');
    void Business;
  });
});
