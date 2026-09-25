import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import app from '../app';
import {
  Order, CashReconciliation, BusinessDocument, DriverDocument, Advertisement, AdInvoice, Refund, AlertReceipt,
} from '../models';
import { OrderStatus, PaymentMethod, UserRole, CashReconciliationStatus, RefundStatus } from '../types';
import { Permission } from '../security/rbac';
import { incidentCenterService, INCIDENT_PERMISSION } from '../services/incidentCenter.service';
import { alertsService, notifyAlertsChanged } from '../services/alerts.service';
import { orderService } from '../services/order.service';
import { featureFlagService } from '../services/featureFlag.service';
import { cache } from '../cache';
import { setIO } from '../sockets/emitter';
import { adminRoomsFor } from '../sockets';
import {
  makeUser, makeStaff, makeBusiness, makeProduct, makeDriver, makePricingConfig, authHeader, GARZON,
} from './factories';

const A = '/api/v1';
const ALLOW_ALL = () => true;
const only = (...perms: Permission[]) => (p: Permission) => perms.includes(p);
const DAY = 24 * 60 * 60 * 1000;

describe('B2: bandeja de alertas del equipo', () => {
  let client: any;
  let business: any;
  let product: any;
  let admin: any;

  beforeEach(async () => {
    await featureFlagService.remove('rbac_enforce');
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
    admin = await makeStaff({ roleSlug: 'super_admin' });
  });

  afterEach(() => {
    setIO(null as any);
  });

  const makeReadyOrder = async (cycle: number, minutesQuiet = 30) => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { status: OrderStatus.READY, driverId: null, 'dispatch.cycle': cycle, updatedAt: new Date(Date.now() - minutesQuiet * 60_000) } }
    );
    return order;
  };

  const kinds = async (allows: (p: Permission) => boolean) =>
    (await incidentCenterService.open(allows)).map((i) => i.kind);

  describe('tipos nuevos, con y sin permiso', () => {
    it('unassigned_order: READY sin domiciliario y quieto; exige orders:view_all', async () => {
      const order = await makeReadyOrder(0, 30);
      const inc = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'unassigned_order')!;
      expect(inc.orderId).toBe(String(order._id));
      expect(inc.businessId).toBe(String(business._id));
      expect(inc.key).toBe(`unassigned_order:${order._id}:waiting`);
      expect(await kinds(only(Permission.ORDERS_VIEW_ALL))).toContain('unassigned_order');
      expect(await kinds(only(Permission.FINANCE_VIEW))).not.toContain('unassigned_order');
      expect(await kinds(() => false)).toEqual([]);
    });

    it('unassigned_order: un READY reciente y con pocas vueltas no es alerta', async () => {
      await makeReadyOrder(1, 1);
      expect(await kinds(ALLOW_ALL)).not.toContain('unassigned_order');
    });

    it('cash_overdue: exige finance:view', async () => {
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      await CashReconciliation.collection.insertOne({
        driverId: driver._id, orderId: new Types.ObjectId(), amount: 7000,
        status: CashReconciliationStatus.OVERDUE, dueAt: new Date(Date.now() - DAY),
      });
      const inc = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'cash_overdue')!;
      expect(inc.driverId).toBe(String(driver._id));
      expect(await kinds(only(Permission.FINANCE_VIEW))).toContain('cash_overdue');
      expect(await kinds(only(Permission.ORDERS_VIEW_ALL))).not.toContain('cash_overdue');
    });

    it('business_document_expiring: aprobado y por vencer, con stage due_soon/overdue; exige businesses:approve', async () => {
      const soon = await BusinessDocument.collection.insertOne({
        businessId: business._id, type: 'rut', reference: 'x', status: 'approved', expiresAt: new Date(Date.now() + 5 * DAY),
      });
      // Fuera de la ventana de 15 días o no aprobado: no cuenta.
      await BusinessDocument.collection.insertOne({
        businessId: business._id, type: 'camara_comercio', reference: 'y', status: 'approved', expiresAt: new Date(Date.now() + 60 * DAY),
      });
      let inc = (await incidentCenterService.open(ALLOW_ALL)).filter((i) => i.kind === 'business_document_expiring');
      expect(inc).toHaveLength(1);
      expect(inc[0].key).toBe(`business_document_expiring:${soon.insertedId}:due_soon`);
      expect(inc[0].businessId).toBe(String(business._id));

      await BusinessDocument.collection.updateOne({ _id: soon.insertedId }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
      inc = (await incidentCenterService.open(ALLOW_ALL)).filter((i) => i.kind === 'business_document_expiring');
      expect(inc[0].key).toBe(`business_document_expiring:${soon.insertedId}:overdue`);

      expect(await kinds(only(Permission.BUSINESSES_APPROVE))).toContain('business_document_expiring');
      expect(await kinds(only(Permission.DRIVERS_APPROVE))).not.toContain('business_document_expiring');
    });

    it('driver_document_expiring: exige drivers:approve', async () => {
      const driverUser = await makeUser({ role: UserRole.DRIVER });
      const driver = await makeDriver(driverUser._id);
      await DriverDocument.collection.insertOne({
        driverId: driver._id, type: 'soat', reference: 'z', status: 'approved', expiresAt: new Date(Date.now() + 3 * DAY),
      });
      const inc = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'driver_document_expiring')!;
      expect(inc.driverId).toBe(String(driver._id));
      expect(inc.key.endsWith(':due_soon')).toBe(true);
      expect(await kinds(only(Permission.DRIVERS_APPROVE))).toContain('driver_document_expiring');
      expect(await kinds(only(Permission.BUSINESSES_APPROVE))).not.toContain('driver_document_expiring');
    });

    it('ad_uninvoiced: campaña terminada sin AdInvoice; desaparece al facturarla; exige ads:view', async () => {
      const ad = await Advertisement.collection.insertOne({
        campaignName: 'Promo', advertiserName: 'Pizzería', endDate: new Date(Date.now() - DAY),
        approvalStatus: 'approved', cancelledAt: null, billedToBusinessId: business._id,
      });
      expect(await kinds(only(Permission.ADS_VIEW))).toContain('ad_uninvoiced');
      expect(await kinds(only(Permission.FINANCE_VIEW))).not.toContain('ad_uninvoiced');
      const inc = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'ad_uninvoiced')!;
      expect(inc.businessId).toBe(String(business._id));

      await AdInvoice.collection.insertOne({ campaignId: ad.insertedId, businessId: business._id, amount: 1000 });
      expect(await kinds(ALLOW_ALL)).not.toContain('ad_uninvoiced');
    });

    it('refund_failed: exige refunds:view', async () => {
      await Refund.collection.insertOne({
        orderId: new Types.ObjectId(), status: RefundStatus.FAILED, amount: 12000, reason: 'rechazado', createdAt: new Date(),
      });
      const inc = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'refund_failed')!;
      expect(inc.key).toMatch(/^refund_failed:[a-f0-9]{24}:failed$/);
      expect(await kinds(only(Permission.REFUNDS_VIEW))).toContain('refund_failed');
      expect(await kinds(only(Permission.SUPPORT_VIEW))).not.toContain('refund_failed');
    });

    it('todos los tipos tienen permiso declarado (falla cerrado)', () => {
      for (const k of ['unassigned_order', 'cash_overdue', 'business_document_expiring', 'driver_document_expiring', 'ad_uninvoiced', 'refund_failed']) {
        expect(INCIDENT_PERMISSION[k]).toBeTruthy();
      }
    });
  });

  describe('key y stage', () => {
    it('la key es estable entre lecturas y el stage escala con las vueltas', async () => {
      const order = await makeReadyOrder(3);
      const first = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'unassigned_order')!;
      const again = (await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'unassigned_order')!;
      expect(first.key).toBe(`unassigned_order:${order._id}:cycle3`);
      expect(again.key).toBe(first.key);

      // Una vuelta más no escala; tres sí.
      await Order.collection.updateOne({ _id: order._id }, { $set: { 'dispatch.cycle': 4 } });
      expect((await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'unassigned_order')!.key).toBe(first.key);
      await Order.collection.updateOne({ _id: order._id }, { $set: { 'dispatch.cycle': 6 } });
      expect((await incidentCenterService.open(ALLOW_ALL)).find((i) => i.kind === 'unassigned_order')!.key).toBe(`unassigned_order:${order._id}:cycle6`);
    });
  });

  describe('list / markSeen', () => {
    it('devuelve el contrato y filtra por permiso; unseen baja al marcar y una escalada vuelve a sonar', async () => {
      const order = await makeReadyOrder(3);
      await Refund.collection.insertOne({ orderId: new Types.ObjectId(), status: RefundStatus.FAILED, amount: 500, reason: 'r', createdAt: new Date() });

      const all = await alertsService.list({ userId: String(admin._id), allows: ALLOW_ALL });
      expect(all.items.map((i) => i.kind).sort()).toEqual(['refund_failed', 'unassigned_order']);
      expect(all.unseen).toBe(2);
      expect(all.truncated).toBe(false);
      expect(typeof all.generatedAt).toBe('string');
      const item = all.items.find((i) => i.kind === 'unassigned_order')!;
      expect(item.links.orderId).toBe(String(order._id));
      expect(item.seen).toBe(false);

      const onlyOrders = await alertsService.list({ userId: String(admin._id), allows: only(Permission.ORDERS_VIEW_ALL) });
      expect(onlyOrders.items.map((i) => i.kind)).toEqual(['unassigned_order']);
      expect(onlyOrders.unseen).toBe(1);

      await alertsService.markSeen(String(admin._id), [item.key]);
      const after = await alertsService.list({ userId: String(admin._id), allows: ALLOW_ALL });
      expect(after.unseen).toBe(1);
      expect(after.items.find((i) => i.key === item.key)!.seen).toBe(true);

      // Otra persona no hereda mi "visto".
      const other = await makeStaff({ roleSlug: 'super_admin' });
      expect((await alertsService.list({ userId: String(other._id), allows: ALLOW_ALL })).unseen).toBe(2);

      // Escalada: nuevo stage, nueva key, vuelve a estar sin ver.
      await Order.collection.updateOne({ _id: order._id }, { $set: { 'dispatch.cycle': 6 } });
      await cache.flush();
      const escalated = await alertsService.list({ userId: String(admin._id), allows: ALLOW_ALL });
      const esc = escalated.items.find((i) => i.kind === 'unassigned_order')!;
      expect(esc.key).not.toBe(item.key);
      expect(esc.seen).toBe(false);
    });

    it('limit trunca y lo indica', async () => {
      await makeReadyOrder(3);
      await makeReadyOrder(3);
      const v = await alertsService.list({ userId: String(admin._id), allows: ALLOW_ALL, limit: 1 });
      expect(v.items).toHaveLength(1);
      expect(v.truncated).toBe(true);
      expect(v.unseen).toBe(2);
    });

    it('markSeen es idempotente (sin ConflictingUpdateOperators, sin duplicados)', async () => {
      const key = `refund_failed:${new Types.ObjectId()}:failed`;
      await alertsService.markSeen(String(admin._id), [key, key]);
      await alertsService.markSeen(String(admin._id), [key]);
      expect(await AlertReceipt.countDocuments({ userId: admin._id, key })).toBe(1);
    });

    it('markSeen rechaza más de 100 claves', async () => {
      const keys = Array.from({ length: 101 }, (_, i) => `k:${i}:s`);
      await expect(alertsService.markSeen(String(admin._id), keys)).rejects.toThrow();
    });
  });

  describe('HTTP /admin/alerts', () => {
    beforeEach(async () => {
      await Refund.collection.insertOne({ orderId: new Types.ObjectId(), status: RefundStatus.FAILED, amount: 500, reason: 'r', createdAt: new Date() });
      await Advertisement.collection.insertOne({
        campaignName: 'Promo', advertiserName: 'X', endDate: new Date(Date.now() - DAY), approvalStatus: 'approved', cancelledAt: null,
      });
      const d = await makeUser({ role: UserRole.DRIVER });
      const drv = await makeDriver(d._id);
      await CashReconciliation.collection.insertOne({
        driverId: drv._id, orderId: new Types.ObjectId(), amount: 1, status: CashReconciliationStatus.OVERDUE, dueAt: new Date(Date.now() - DAY),
      });
      await cache.flush();
    });

    const get = async (u: any) => request(app).get(`${A}/admin/alerts`).set(await authHeader(u));

    it('cada rol ve solo los tipos de sus permisos', async () => {
      const soporte = await makeStaff({ roleSlug: 'soporte' });
      const finanzas = await makeStaff({ roleSlug: 'finanzas' });

      const s = await get(soporte);
      expect(s.status).toBe(200);
      const sk = s.body.data.items.map((i: any) => i.kind);
      expect(sk).toContain('refund_failed');
      expect(sk).not.toContain('cash_overdue');
      expect(sk).not.toContain('ad_uninvoiced');

      const f = await get(finanzas);
      const fk = f.body.data.items.map((i: any) => i.kind);
      expect(fk).toEqual(expect.arrayContaining(['refund_failed', 'cash_overdue', 'ad_uninvoiced']));

      const su = await get(admin);
      expect(su.body.data.items).toHaveLength(3);
    });

    it('un admin sin rol (solo admin:panel) recibe la bandeja vacía', async () => {
      const bare = await makeStaff({ roleSlug: null });
      const r = await get(bare);
      expect(r.status).toBe(200);
      expect(r.body.data.items).toEqual([]);
      expect(r.body.data.unseen).toBe(0);
    });

    it('cliente, comercio y domiciliario: 403; sin token: 401', async () => {
      expect((await request(app).get(`${A}/admin/alerts`)).status).toBe(401);
      for (const role of [UserRole.CLIENT, UserRole.BUSINESS, UserRole.DRIVER]) {
        const u = await makeUser({ role });
        expect((await get(u)).status, role).toBe(403);
        const p = await request(app).post(`${A}/admin/alerts/seen`).set(await authHeader(u)).send({ keys: ['a:b:c'] });
        expect(p.status, role).toBe(403);
      }
    });

    it('POST /seen marca vistas, es idempotente y valida el cuerpo', async () => {
      const list = await get(admin);
      const key = list.body.data.items[0].key;
      for (let i = 0; i < 2; i++) {
        const r = await request(app).post(`${A}/admin/alerts/seen`).set(await authHeader(admin)).send({ keys: [key] });
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({ ok: true });
      }
      const after = await get(admin);
      expect(after.body.data.unseen).toBe(2);
      expect((await request(app).post(`${A}/admin/alerts/seen`).set(await authHeader(admin)).send({ keys: [] })).status).toBe(400);
      const many = Array.from({ length: 101 }, (_, i) => `k:${i}:s`);
      expect((await request(app).post(`${A}/admin/alerts/seen`).set(await authHeader(admin)).send({ keys: many })).status).toBe(400);
    });

    it('limit fuera de rango: 400', async () => {
      expect((await request(app).get(`${A}/admin/alerts?limit=500`).set(await authHeader(admin))).status).toBe(400);
    });

    it('GET /security/incidents sigue funcionando, con key y tipos nuevos', async () => {
      const r = await request(app).get(`${A}/security/incidents`).set(await authHeader(admin));
      expect(r.status).toBe(200);
      const items = r.body.data;
      expect(items.some((i: any) => i.kind === 'refund_failed' && typeof i.key === 'string')).toBe(true);
    });
  });

  describe('tiempo real', () => {
    const fakeIo = () => {
      const emitted: { room: string; event: string; payload: unknown }[] = [];
      setIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }) } as any);
      return emitted;
    };

    it('notifyAlertsChanged emite alerts:changed SOLO con {kind} a admin:alerts', async () => {
      const emitted = fakeIo();
      await notifyAlertsChanged('sos');
      expect(emitted).toEqual([{ room: 'admin:alerts', event: 'alerts:changed', payload: { kind: 'sos' } }]);
    });

    it('nunca lanza, ni sin io ni con io roto', async () => {
      await expect(notifyAlertsChanged('x')).resolves.toBeUndefined();
      setIO({ to: () => { throw new Error('boom'); } } as any);
      await expect(notifyAlertsChanged('x')).resolves.toBeUndefined();
    });

    it('invalida la caché de la bandeja', async () => {
      const first = await alertsService.computeAll();
      expect(first.incidents).toHaveLength(0);
      await Refund.collection.insertOne({ orderId: new Types.ObjectId(), status: RefundStatus.FAILED, amount: 1, reason: 'r', createdAt: new Date() });
      expect((await alertsService.computeAll()).incidents).toHaveLength(0); // sigue en caché
      await notifyAlertsChanged('refund_failed');
      expect((await alertsService.computeAll()).incidents).toHaveLength(1);
    });

    it('la sala admin:alerts es solo para admin con admin:panel (observe usa legacyUnion, enforce strict)', () => {
      const mk = (mode: string, strict: Permission[], legacyUnion: Permission[]) => ({ mode, strict, legacyUnion } as any);
      expect(adminRoomsFor(undefined)).toEqual([]);
      expect(adminRoomsFor(mk('enforce', [Permission.ADMIN_PANEL], []))).toContain('admin:alerts');
      expect(adminRoomsFor(mk('enforce', [Permission.SOS_VIEW], [Permission.ADMIN_PANEL]))).not.toContain('admin:alerts');
      expect(adminRoomsFor(mk('observe', [], [Permission.ADMIN_PANEL]))).toContain('admin:alerts');
      expect(adminRoomsFor(mk('observe', [Permission.ADMIN_PANEL], []))).not.toContain('admin:alerts');
    });
  });
});
