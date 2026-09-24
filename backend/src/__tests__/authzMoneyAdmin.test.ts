import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Role } from '../models';
import { UserRole } from '../types';
import { Permission, STAFF_ROLE_PERMISSIONS, SUPER_ADMIN_ROLE_SLUG } from '../security/rbac';
import { AuditAction, AuditLog } from '../security/audit';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, authHeader, makeBusiness } from './factories';

/** B2a: permisos por módulo en rutas de dinero y admin (modo enforce y observe). */

async function staff(slug: string | null) {
  const user = await makeUser({ role: UserRole.ADMIN });
  if (slug) {
    const perms = slug === SUPER_ADMIN_ROLE_SLUG ? Object.values(Permission) : STAFF_ROLE_PERMISSIONS[slug as keyof typeof STAFF_ROLE_PERMISSIONS].permissions;
    const role = await Role.create({ name: slug, slug, permissions: perms, isActive: true, isSystem: false });
    user.roleIds = [role._id] as any;
    await user.save();
  }
  return user;
}

const setEnforce = (on: boolean) => featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });

const MONEY_GETS = ['/api/v1/finance/config', '/api/v1/finance/cash', '/api/v1/admin/financials', '/api/v1/admin/commissions'];

describe('B2a: permisos en dinero y admin', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
  });

  describe('enforce', () => {
    beforeEach(async () => {
      await setEnforce(true);
      await cache.flush();
    });

    it('admin sin rol: 403 en dinero', async () => {
      const u = await staff(null);
      for (const url of MONEY_GETS) {
        const res = await request(app).get(url).set(await authHeader(u));
        expect(res.status, url).toBe(403);
      }
    });

    it('soporte: 403 en dinero', async () => {
      const u = await staff('soporte');
      for (const url of MONEY_GETS) {
        const res = await request(app).get(url).set(await authHeader(u));
        expect(res.status, url).toBe(403);
      }
      const put = await request(app).put('/api/v1/finance/config').set(await authHeader(u)).send({});
      expect(put.status).toBe(403);
    });

    it('finanzas y super_admin: pasan el permiso', async () => {
      for (const slug of ['finanzas', SUPER_ADMIN_ROLE_SLUG]) {
        const u = await staff(slug);
        for (const url of MONEY_GETS) {
          const res = await request(app).get(url).set(await authHeader(u));
          expect(res.status, `${slug} ${url}`).toBe(200);
        }
      }
    });

    it('finanzas no escribe la cuenta de pago de un comercio (solo super admin)', async () => {
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const biz = await makeBusiness(owner._id);
      const u = await staff('finanzas');
      const res = await request(app).put(`/api/v1/businesses/${biz._id}/payout-account`).set(await authHeader(u)).send({});
      expect(res.status).toBe(403);
    });

    it('reembolsos: soporte no crea, finanzas pasa la puerta', async () => {
      const oid = '64b000000000000000000001';
      const s = await staff('soporte');
      const r1 = await request(app).post(`/api/v1/payments/orders/${oid}/refund`).set(await authHeader(s)).send({});
      expect(r1.status).toBe(403);
      const g = await request(app).get(`/api/v1/payments/orders/${oid}/refunds`).set(await authHeader(s));
      expect(g.status).not.toBe(403);
      const f = await staff('finanzas');
      const r2 = await request(app).post(`/api/v1/payments/orders/${oid}/refund`).set(await authHeader(f)).send({});
      expect(r2.status).not.toBe(403);
    });

    it('comercio: 403 en /finance y /admin, conserva rutas compartidas', async () => {
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const biz = await makeBusiness(owner._id);
      const h = await authHeader(owner);
      expect((await request(app).get('/api/v1/finance/config').set(h)).status).toBe(403);
      expect((await request(app).get('/api/v1/admin/financials').set(h)).status).toBe(403);
      const st = await request(app).get(`/api/v1/businesses/${biz._id}/statement`).set(h);
      expect(st.status).toBe(200);
      const mine = await request(app).get('/api/v1/businesses/my/businesses').set(h);
      expect(mine.status).toBe(200);
    });

    it('domiciliario en /finance: 403', async () => {
      const d = await makeUser({ role: UserRole.DRIVER });
      expect((await request(app).get('/api/v1/finance/cash').set(await authHeader(d))).status).toBe(403);
    });
  });

  it('driver-debts ya no existe', async () => {
    const u = await staff(SUPER_ADMIN_ROLE_SLUG);
    const res = await request(app).get('/api/v1/admin/driver-debts').set(await authHeader(u));
    expect(res.status).toBe(404);
  });

  it('observe: admin sin rol pasa y deja un solo AuditLog por permiso/ruta', async () => {
    const u = await staff(null);
    // el admin sin rol solo tiene admin:panel en strict; legacyUnion conserva finance:view
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get('/api/v1/admin/financials').set(await authHeader(u));
      expect(res.status).toBe(200);
    }
    let logs: any[] = [];
    for (let i = 0; i < 40 && logs.length < 1; i++) {
      logs = await AuditLog.find({ userId: u._id, action: AuditAction.PERMISSION_SHADOW_DENIED }).lean();
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100));
    logs = await AuditLog.find({ userId: u._id, action: AuditAction.PERMISSION_SHADOW_DENIED }).lean();
    expect(logs.length).toBe(1);
  });
});
