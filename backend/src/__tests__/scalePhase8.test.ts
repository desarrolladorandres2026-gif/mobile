import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { ClientError, Order } from '../models';
import { UserRole } from '../types';
import { dailySummaryService } from '../services/dailySummary.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { authHeader, makeStaff, makeUser, makeZone, GARZON, offsetKm } from './factories';

const API = '/api/v1/admin';
// Mediodía en Bogotá (UTC-5) del 2026-09-10.
const NOON = new Date('2026-09-10T12:00:00-05:00');

let seq = 0;
const rawOrder = (fields: Record<string, unknown>) =>
  Order.collection.insertOne({ orderNumber: `T-${Date.now()}-${seq++}`, paymentMethod: 'online', createdAt: NOON, ...fields });

describe('Fase 8 · Escala (lo que no depende del NIT)', () => {
  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
  });

  describe('Resumen diario por zona', () => {
    it('reparte creados, entregados y cancelados por zona y deja aparte los pedidos sin zona', async () => {
      const zoneA = await makeZone(GARZON, 1, { name: 'Centro' });
      const zoneB = await makeZone(offsetKm(GARZON, 10), 1, { name: 'Norte' });
      const delivered = new Date(NOON.getTime() + 30 * 60_000);
      const base = { status: 'delivered', deliveredAt: delivered };

      await rawOrder({ ...base, zoneId: zoneA._id, finance: { customerTotal: 30_000, driverPayout: 5_000 } });
      await rawOrder({ ...base, zoneId: zoneA._id, finance: { customerTotal: 20_000, driverPayout: 4_000 } });
      await rawOrder({ status: 'cancelled', cancelledAt: NOON, zoneId: zoneA._id });
      await rawOrder({ ...base, zoneId: zoneB._id, finance: { customerTotal: 10_000, driverPayout: 3_000 } });
      await rawOrder({ ...base, zoneId: null, finance: { customerTotal: 8_000, driverPayout: 2_000 } });

      const res = await dailySummaryService.byZone('2026-09-10');
      const byName = Object.fromEntries(res.zones.map((z) => [z.name, z]));

      expect(byName['Centro']).toMatchObject({
        ordersCreated: 3, ordersDelivered: 2, ordersCancelled: 1, gmv: 50_000, driverPayouts: 9_000, avgDeliveryMinutes: 30,
      });
      expect(byName['Centro'].cancelRate).toBeCloseTo(33.3, 1);
      expect(byName['Norte']).toMatchObject({ ordersCreated: 1, ordersDelivered: 1, gmv: 10_000 });
      expect(byName['Sin zona']).toMatchObject({ zoneId: null, ordersCreated: 1, gmv: 8_000 });
      // La suma por zona cuadra con el total del día.
      expect(res.zones.reduce((n, z) => n + z.ordersCreated, 0)).toBe(5);
      // Ordenadas por actividad.
      expect(res.zones[0].name).toBe('Centro');
    });

    it('un día sin pedidos devuelve la lista vacía, y una zona borrada no rompe nada', async () => {
      expect((await dailySummaryService.byZone('2026-01-01')).zones).toEqual([]);
      const zone = await makeZone(GARZON, 1, { name: 'Temporal' });
      await rawOrder({ status: 'delivered', deliveredAt: NOON, zoneId: zone._id, finance: { customerTotal: 1000 } });
      await zone.deleteOne();
      const res = await dailySummaryService.byZone('2026-09-10');
      expect(res.zones[0].name).toBe('Zona eliminada');
    });

    it('sin finance:view no salen los pesos, y sin reports:view no se entra', async () => {
      const zone = await makeZone(GARZON, 1, { name: 'Centro' });
      await rawOrder({ status: 'delivered', deliveredAt: NOON, zoneId: zone._id, finance: { customerTotal: 30_000, driverPayout: 5_000 } });

      const finanzas = await authHeader(await makeStaff({ roleSlug: 'finanzas' }));
      const soloOps = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));
      const sinPermiso = await authHeader(await makeStaff({ roleSlug: 'comercios_contenido' }));

      const money = await request(app).get(`${API}/daily-summary/zones?date=2026-09-10`).set(finanzas).expect(200);
      expect(money.body.data.zones[0].gmv).toBe(30_000);

      // Operaciones tiene reports:view pero no finance:view: entra, sin dinero.
      const ops = await request(app).get(`${API}/daily-summary/zones?date=2026-09-10`).set(soloOps).expect(200);
      expect(ops.body.data.zones[0]).not.toHaveProperty('gmv');
      expect(ops.body.data.zones[0]).not.toHaveProperty('driverPayouts');
      await request(app).get(`${API}/daily-summary/zones`).set(sinPermiso).expect(403);
    });
  });

  describe('Salud de la app', () => {
    const crash = (extra: Record<string, unknown>) =>
      ClientError.create({
        userId: extra.userId, message: 'Cannot read property x of undefined', platform: 'android', appVersion: '1.4.0', at: new Date(), ...extra,
      });

    it('agrupa por mensaje y versión, cuenta personas y no filtra identidades', async () => {
      const u1 = await makeUser({ role: UserRole.CLIENT });
      const u2 = await makeUser({ role: UserRole.CLIENT });
      await crash({ userId: u1._id, fatal: true, deviceId: 'dev-secreto' });
      await crash({ userId: u1._id, fatal: false, deviceId: 'dev-secreto' });
      await crash({ userId: u2._id, fatal: true });
      await crash({ userId: u2._id, message: 'Network request failed', appVersion: '1.3.0' });

      const header = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));
      const res = await request(app).get(`${API}/health/crashes`).set(header).expect(200);

      const body = res.body.data;
      expect(body.totals).toEqual({ total: 4, fatal: 2, usersAffected: 2 });
      expect(body.groups[0]).toMatchObject({ message: 'Cannot read property x of undefined', appVersion: '1.4.0', count: 3, fatal: 2, usersAffected: 2 });
      expect(body.byVersion.map((v: { appVersion: string }) => v.appVersion).sort()).toEqual(['1.3.0', '1.4.0']);
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('dev-secreto');
      expect(raw).not.toContain(String(u1._id));
    });

    it('exige reports:view y acota los días', async () => {
      const sinPermiso = await authHeader(await makeStaff({ roleSlug: 'comercios_contenido' }));
      await request(app).get(`${API}/health/crashes`).set(sinPermiso).expect(403);

      const header = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      const res = await request(app).get(`${API}/health/crashes?days=9999`).set(header).expect(200);
      expect(res.body.data.days).toBeLessThanOrEqual(30);
    });

    it('resuelto sigue resuelto en versiones vistas, y reaparece como regresión en una nueva', async () => {
      const u = await makeUser({ role: UserRole.CLIENT });
      await crash({ userId: u._id, appVersion: '1.4.0' });
      await crash({ userId: u._id, appVersion: '1.3.0' });
      const message = 'Cannot read property x of undefined';

      const ops = await authHeader(await makeStaff({ roleSlug: 'operaciones' }));
      const superAdmin = await authHeader(await makeStaff({ roleSlug: 'super_admin' }));
      // Ver reportes no basta para marcar.
      await request(app).post(`${API}/health/crashes/resolve`).set(ops).send({ message }).expect(403);
      await request(app).post(`${API}/health/crashes/resolve`).set(superAdmin).send({ message: 'no existe' }).expect(404);
      await request(app).post(`${API}/health/crashes/resolve`).set(superAdmin).send({ message, note: 'arreglado en 1.4.1' }).expect(200);

      const statusByVersion = async () => {
        const res = await request(app).get(`${API}/health/crashes`).set(ops).expect(200);
        return Object.fromEntries(res.body.data.groups.map((g: { appVersion: string; status: string }) => [g.appVersion, g.status]));
      };
      // Gente con la versión vieja sigue mandándolo: no reabre.
      await crash({ userId: u._id, appVersion: '1.3.0' });
      expect(await statusByVersion()).toEqual({ '1.4.0': 'resolved', '1.3.0': 'resolved' });

      await crash({ userId: u._id, appVersion: '1.5.0' });
      expect((await statusByVersion())['1.5.0']).toBe('regression');

      await request(app).post(`${API}/health/crashes/reopen`).set(superAdmin).send({ message }).expect(200);
      expect(Object.values(await statusByVersion())).toEqual(['open', 'open', 'open']);
    });
  });
});
