import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { AuditAction, AuditLog } from '../security/audit';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { makeUser, authHeader, makeBusiness, makeDriver, makeStaff } from './factories';

/** B2c + B4: permisos en operacion (pedidos, SOS, PQRS, legal, seguridad, ficha 360, authz-shadow). */

const setEnforce = (on: boolean) => featureFlagService.upsert('rbac_enforce', { audience: on ? 'staff' : 'off' });
const fakeId = () => new Types.ObjectId().toString();
const A = '/api/v1';

describe('B2c: permisos de operacion', () => {
  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await cache.flush();
  });

  describe('enforce', () => {
    beforeEach(async () => {
      await setEnforce(true);
      await cache.flush();
    });

    it('admin sin rol: 403 en pedidos, SOS, PQRS, legal y flota', async () => {
      const u = await makeStaff({ roleSlug: null });
      for (const url of [`${A}/orders/${fakeId()}`, `${A}/sos/active`, `${A}/pqrs`, `${A}/legal/admin/data-requests`, `${A}/tracking/fleet`]) {
        const res = await request(app).get(url).set(await authHeader(u));
        expect(res.status, url).toBe(403);
      }
      // admin:panel basta para el centro de incidentes (filtrado por tipo)
      const inc = await request(app).get(`${A}/security/incidents`).set(await authHeader(u));
      expect(inc.status).toBe(200);
    });

    it('soporte ve PQRS y no SOS; operaciones ve SOS y pedidos y no PQRS', async () => {
      const soporte = await makeStaff({ roleSlug: 'soporte' });
      const ops = await makeStaff({ roleSlug: 'operaciones' });
      expect((await request(app).get(`${A}/pqrs`).set(await authHeader(soporte))).status).toBe(200);
      expect((await request(app).get(`${A}/sos/active`).set(await authHeader(soporte))).status).toBe(403);
      expect((await request(app).get(`${A}/sos/active`).set(await authHeader(ops))).status).toBe(200);
      expect((await request(app).get(`${A}/pqrs`).set(await authHeader(ops))).status).toBe(403);
      expect((await request(app).get(`${A}/tracking/fleet`).set(await authHeader(ops))).status).toBe(200);
      expect((await request(app).get(`${A}/tracking/fleet`).set(await authHeader(soporte))).status).toBe(403);
      expect((await request(app).get(`${A}/orders/${fakeId()}`).set(await authHeader(ops))).status).toBe(404);
      expect((await request(app).patch(`${A}/sos/${fakeId()}/acknowledge`).set(await authHeader(soporte))).status).toBe(403);
    });

    it('super_admin pasa en todo', async () => {
      const su = await makeStaff({ roleSlug: 'super_admin' });
      for (const url of [`${A}/sos/active`, `${A}/pqrs`, `${A}/legal/admin/data-requests`, `${A}/tracking/fleet`, `${A}/security/incidents`, `${A}/security/incidents/summary`]) {
        const res = await request(app).get(url).set(await authHeader(su));
        expect(res.status, url).toBe(200);
      }
    });

    it('regresion: cliente, comercio y domiciliario conservan sus rutas de pedidos', async () => {
      const client = await makeUser({ role: UserRole.CLIENT });
      const owner = await makeUser({ role: UserRole.BUSINESS });
      const biz = await makeBusiness(owner._id);
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      await makeDriver(driverUser._id);

      expect((await request(app).get(`${A}/orders/my`).set(await authHeader(client))).status).toBe(200);
      expect((await request(app).get(`${A}/orders/business/${biz._id}`).set(await authHeader(owner))).status).toBe(200);
      expect((await request(app).get(`${A}/orders/driver/available`).set(await authHeader(driverUser))).status).toBe(200);
      expect((await request(app).get(`${A}/orders/driver/my`).set(await authHeader(driverUser))).status).toBe(200);
      for (const [u, url] of [[client, `${A}/orders/${fakeId()}`], [owner, `${A}/orders/${fakeId()}/timeline`], [driverUser, `${A}/orders/${fakeId()}/chat`]] as const) {
        const res = await request(app).get(url).set(await authHeader(u));
        expect(res.status, url).toBe(404);
      }
      expect((await request(app).get(`${A}/sos/active`).set(await authHeader(client))).status).toBe(403);
      expect((await request(app).get(`${A}/pqrs`).set(await authHeader(owner))).status).toBe(403);
      expect((await request(app).get(`${A}/tracking/fleet`).set(await authHeader(driverUser))).status).toBe(403);
    });

    it('PATCH status: CANCELLED exige orders:cancel; PICKED_UP/DELIVERED exigen orders:modify', async () => {
      const limited = await makeStaff({
        roleSlug: 'operaciones',
        permissions: [Permission.ADMIN_PANEL, Permission.ORDERS_VIEW_ALL, Permission.ORDERS_UPDATE],
      });
      const h = await authHeader(limited);
      const id = fakeId();
      const cancel = await request(app).patch(`${A}/orders/${id}/status`).set(h).send({ status: 'cancelled', cancellationReason: 'x' });
      expect(cancel.status).toBe(403);
      const force = await request(app).patch(`${A}/orders/${id}/status`).set(h).send({ status: 'delivered' });
      expect(force.status).toBe(403);
      const other = await request(app).patch(`${A}/orders/${id}/status`).set(h).send({ status: 'ready' });
      expect(other.status).toBe(404);

      const ops = await makeStaff({ roleSlug: 'operaciones' });
      const ok = await request(app).patch(`${A}/orders/${id}/status`).set(await authHeader(ops)).send({ status: 'cancelled', cancellationReason: 'x' });
      expect(ok.status).not.toBe(403);
    });

    it('incidentes: el resumen y la lista se filtran por permiso', async () => {
      const soporte = await makeStaff({ roleSlug: 'soporte' });
      const { SosAlert, Pqrs } = await import('../models');
      const client = await makeUser({ role: UserRole.CLIENT });
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      await SosAlert.create({ userId: driverUser._id, driverId: driver._id, location: { type: 'Point', coordinates: [-75.6, 2.2] }, status: 'active' } as any);
      await Pqrs.create({ userId: client._id, type: 'claim', subject: 'Reclamo', detail: 'Detalle largo del reclamo', status: 'received' } as any);

      const list = await request(app).get(`${A}/security/incidents`).set(await authHeader(soporte));
      const kinds = list.body.data.map((i: any) => i.kind);
      expect(kinds).toContain('complaint');
      expect(kinds).not.toContain('sos');

      const sum = await request(app).get(`${A}/security/incidents/summary`).set(await authHeader(soporte));
      expect(sum.body.data.activeSos).toBe(0);
      expect(sum.body.data.openClaims).toBe(1);

      const su = await makeStaff({ roleSlug: 'super_admin' });
      const all = await request(app).get(`${A}/security/incidents/summary`).set(await authHeader(su));
      expect(all.body.data.activeSos).toBe(1);
    });

    it('ficha 360: enmascarada sin users:view_sensitive', async () => {
      const client = await makeUser({ role: UserRole.CLIENT });
      const { User } = await import('../models');
      await User.updateOne({ _id: client._id }, { documentNumber: '1075123456', birthDate: new Date('1990-01-01T00:00:00Z') });
      const { profile360 } = await import('../services/userProfile360.service');

      const masked: any = await profile360(client._id.toString());
      expect(masked.user.documentNumber).toBeUndefined();
      expect(masked.user.documentNumberLast4).toBe('3456');
      expect(masked.user.birthDate).toBeUndefined();
      expect(masked.user.isAdult).toBe(true);

      const full: any = await profile360(client._id.toString(), { sensitive: true });
      expect(full.user.documentNumber).toBe('1075123456');
    });

    it('bloquear/desbloquear/revocar sesiones: solo Super Administrador; legal anonymize tambien', async () => {
      const target = await makeUser({ role: UserRole.CLIENT });
      const ops = await makeStaff({ roleSlug: 'operaciones', permissions: Object.values(Permission) });
      const h = await authHeader(ops);
      for (const [m, url] of [['post', `block-user/${target._id}`], ['post', `unblock-user/${target._id}`], ['delete', `sessions/user/${target._id}`]] as const) {
        const res = await (request(app) as any)[m](`${A}/security/${url}`).set(h).send({ reason: 'x' });
        expect(res.status, url).toBe(403);
      }
      const su = await makeStaff({ roleSlug: 'super_admin' });
      const okRes = await request(app).post(`${A}/security/block-user/${target._id}`).set(await authHeader(su)).send({ reason: 'x' });
      expect(okRes.status).toBe(200);

      const legal = await request(app).patch(`${A}/legal/admin/data-requests/${fakeId()}`).set(h)
        .send({ status: 'resolved', response: 'listo', anonymize: true });
      expect(legal.status).toBe(403);
    });
  });

  describe('B4: authz-shadow', () => {
    it('solo super_admin; agrega los bloqueos que habria en observacion', async () => {
      const soporte = await makeStaff({ roleSlug: 'soporte' });
      const r1 = await request(app).get(`${A}/tracking/fleet`).set(await authHeader(soporte));
      expect(r1.status).toBe(200);
      for (let i = 0; i < 40; i++) {
        if (await AuditLog.countDocuments({ userId: soporte._id.toString(), action: AuditAction.PERMISSION_SHADOW_DENIED })) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect((await request(app).get(`${A}/security/authz-shadow`).set(await authHeader(soporte))).status).toBe(403);

      const su = await makeStaff({ roleSlug: 'super_admin' });
      const res = await request(app).get(`${A}/security/authz-shadow?days=7`).set(await authHeader(su));
      expect(res.status).toBe(200);
      expect(res.body.data.mode).toBe('observe');
      expect(res.body.data.enforceFlag).toBe('rbac_enforce');
      const row = res.body.data.items.find((i: any) => i.userId === soporte._id.toString() && i.permission === Permission.DRIVERS_TRACK);
      expect(row).toBeTruthy();
      expect(row.count).toBe(1);
      expect(row.roleSlugs).toContain('soporte');
      expect(row.email).toBe(soporte.email);
    });
  });
});
