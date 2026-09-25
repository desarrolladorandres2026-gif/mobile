import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import app from '../app';
import { Order, Refund, Payout } from '../models';
import { OrderStatus, UserRole, PaymentMethod, RefundKind, RefundStatus } from '../types';
import { refundService } from '../services/refund.service';
import { createOrderNotifyRateLimiter, orderNotifyRateLimiter } from '../middlewares/security';
import adminOrdersRouter from '../routes/adminOrders.routes';
import { AuditAction, AuditLog } from '../security/audit';
import { Permission, STAFF_ROLE_PERMISSIONS } from '../security/rbac';
import { featureFlagService } from '../services/featureFlag.service';
import { orderService } from '../services/order.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { cache } from '../cache';
import { makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, makeStaff, authHeader, GARZON } from './factories';

const A = '/api/v1/admin/orders';

describe('Ficha 360 del pedido y acciones (B4 + H1..H4)', () => {
  let client: any;
  let business: any;
  let product: any;
  let driverUser: any;
  let driver: any;

  const newOrder = () =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

  const pay = async (order: any) => {
    setPaymentProvider(new SandboxPaymentProvider());
    await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });
  };

  beforeEach(async () => {
    await featureFlagService.upsert('rbac_enforce', { audience: 'staff' });
    await cache.flush();
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 20000 });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id, { isApproved: true, isActive: true });
  });

  const walk = (v: any, keys: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, keys));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.push(k);
        walk(x, keys);
      }
    }
    return keys;
  };

  it('nunca contiene secret, hash, pickupCode ni deliveryCode, pero si el estado de los codigos', async () => {
    const order = await newOrder();
    await orderSecurityService.ensureIssued(order._id.toString());
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const res = await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(su));
    expect(res.status).toBe(200);
    const keys = walk(res.body.data);
    for (const bad of ['secret', 'hash', 'pickupCode', 'deliveryCode']) expect(keys).not.toContain(bad);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('pickupCode');
    expect(raw).not.toContain('deliveryCode');
    expect(res.body.data.handoff.pickup.status).toBeTruthy();
    expect(res.body.data.order.status).toBe(OrderStatus.PENDING);
    const audit = await AuditLog.findOne({ action: AuditAction.PROFILE_VIEWED, entity: 'order', entityId: order._id.toString() });
    expect(audit).toBeTruthy();
  });

  it('finance enmascarado sin commissions:view, money null sin finance:view y permisos por bloque', async () => {
    const order = await newOrder();
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const fin = await makeStaff({ roleSlug: 'finanzas' });

    const o = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(ops))).body.data;
    expect(o.order.finance.customerTotal).toBeGreaterThan(0);
    expect(o.order.finance.merchantCommission).toBeUndefined();
    expect(o.order.finance.appliedCommissionBps).toBeUndefined();
    expect(o.masked.commissions).toBe(true);
    expect(o.masked.finance).toBe(true);
    expect(o.money).toBeNull();
    expect(o.handoff).not.toBeNull();
    expect(o.after.sos).toBeDefined();

    const f = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(fin))).body.data;
    expect(f.order.finance.merchantCommission).toBeDefined();
    expect(f.money).not.toBeNull();
    expect(f.masked.commissions).toBe(false);
    expect(JSON.stringify(f.money)).not.toMatch(/transactionId|metadata|reference/);
    expect(f.handoff).toBeNull();
    expect(f.after.sos).toBeUndefined();
  });

  it('direccion exacta si el pedido esta activo; solo ciudad si termino y no hay users:view_sensitive', async () => {
    const order = await newOrder();
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    let d = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(ops))).body.data;
    expect(d.order.deliveryAddress.address).toBe('Cra 1 #2-3');
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.DELIVERED });
    d = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(ops))).body.data;
    expect(typeof d.order.deliveryAddress).toBe('string');
    expect(JSON.stringify(d)).not.toContain('Cra 1 #2-3');
  });

  it('H3: listado y detalle sin commissions:view no traen comisiones', async () => {
    const order = await newOrder();
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const list = await request(app).get('/api/v1/admin/orders').set(await authHeader(ops));
    expect(list.status).toBe(200);
    expect(list.body.data[0].finance.merchantCommission).toBeUndefined();
    expect(list.body.data[0].finance.customerTotal).toBeGreaterThan(0);
    const one = await request(app).get(`/api/v1/orders/${order._id}`).set(await authHeader(ops));
    expect(one.status).toBe(200);
    expect(one.body.data.finance.merchantCommission).toBeUndefined();
    const fin = await makeStaff({ roleSlug: 'finanzas' });
    const withComm = await request(app).get(`/api/v1/orders/${order._id}`).set(await authHeader(fin));
    expect(withComm.body.data.finance.merchantCommission).toBeDefined();
  });

  it('H4: pagos del pedido sin finance:view es 403 para un admin', async () => {
    const order = await newOrder();
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const fin = await makeStaff({ roleSlug: 'finanzas' });
    expect((await request(app).get(`/api/v1/payments/orders/${order._id}`).set(await authHeader(ops))).status).toBe(403);
    expect((await request(app).get(`/api/v1/payments/orders/${order._id}`).set(await authHeader(fin))).status).toBe(200);
  });

  it('unassign-driver: libera, audita con el actor real y respeta permisos y validacion', async () => {
    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const soporte = await makeStaff({ roleSlug: 'soporte' });
    const url = `${A}/${order._id}/unassign-driver`;

    expect((await request(app).post(url).set(await authHeader(soporte)).send({ reason: 'motivo valido' })).status).toBe(403);
    expect((await request(app).post(url).set(await authHeader(ops)).send({ reason: 'x' })).status).toBe(400);

    const res = await request(app)
      .post(url)
      .set(await authHeader(ops))
      .send({ reason: 'Domiciliario sin respuesta', redispatch: false });
    expect(res.status).toBe(200);
    expect((await Order.findById(order._id))!.driverId).toBeNull();
    const audit = await AuditLog.findOne({ action: AuditAction.ORDER_DRIVER_UNASSIGNED, entityId: order._id.toString() });
    expect(String(audit!.userId)).toBe(ops._id.toString());

    const again = await request(app).post(url).set(await authHeader(ops)).send({ reason: 'otra vez ok' });
    expect(again.status).toBe(409);
  });

  it('notify: plantillas fijas, audita (el limitador esta apagado en test)', async () => {
    const order = await newOrder();
    const ops = await makeStaff({ roleSlug: 'operaciones' });
    const h = await authHeader(ops);
    const send = (body: object) => request(app).post(`${A}/${order._id}/notify`).set(h).send(body);

    expect((await send({ audience: 'client', template: 'status' })).status).toBe(200);
    expect((await send({ audience: 'client', template: 'libre' })).status).toBe(400);
    expect((await send({ audience: 'driver', template: 'delayed' })).status).toBe(409);
    expect(await AuditLog.countDocuments({ action: AuditAction.ORDER_NOTIFICATION_RESENT })).toBe(1);
  });

  it('con finance:view sin commissions:view no se ve el payout del comercio', async () => {
    const order = await newOrder();
    await Payout.updateOne(
      { orderId: order._id, beneficiary: 'business' },
      { $setOnInsert: { businessId: business._id, amount: 17000, pricingConfigVersion: 1 } },
      { upsert: true }
    );
    await Payout.updateOne(
      { orderId: order._id, beneficiary: 'driver' },
      { $setOnInsert: { driverId: driver._id, amount: 4000, pricingConfigVersion: 1 } },
      { upsert: true }
    );
    const soloFin = await makeStaff({ roleSlug: 'operaciones', permissions: [Permission.ORDERS_VIEW_ALL, Permission.FINANCE_VIEW] });
    const fin = await makeStaff({ roleSlug: 'finanzas' });

    const a = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(soloFin))).body.data;
    expect(a.money.payouts.map((p: any) => p.beneficiary)).toEqual(['driver']);
    const b = (await request(app).get(`${A}/${order._id}/profile-360`).set(await authHeader(fin))).body.data;
    expect(b.money.payouts.map((p: any) => p.beneficiary).sort()).toEqual(['business', 'driver']);
  });

  it('un reembolso que falla al cancelar no revierte el estado: codigos anulados, una fila Refund y sin doble reembolso al reintentar', async () => {
    const order = await newOrder();
    await orderSecurityService.ensureIssued(order._id.toString());
    await pay(order);
    class FailingRefund extends SandboxPaymentProvider {
      async refund(): Promise<any> {
        throw new Error('pasarela caida');
      }
    }
    setPaymentProvider(new FailingRefund());
    const ops = await makeStaff({ roleSlug: 'operaciones' });

    const res = await request(app)
      .patch(`/api/v1/orders/${order._id}/status`)
      .set(await authHeader(ops))
      .send({ status: OrderStatus.CANCELLED, cancellationCode: 'business_closed' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reversi/i);

    const saved = await Order.findById(order._id);
    expect(saved!.status).toBe(OrderStatus.CANCELLED);
    const sec = await orderSecurityService.getState(order._id.toString());
    expect((sec as any).pickup.status).toBe('void');
    expect(await AuditLog.countDocuments({ entityId: order._id.toString(), action: AuditAction.SUSPICIOUS_ACTIVITY })).toBeGreaterThan(0);

    const rows = await Refund.find({ orderId: order._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(RefundStatus.FAILED);

    // Reintento con la misma clave: devuelve la fila existente, no crea otra.
    const again = await refundService.issue({ orderId: order._id.toString(), reason: 'x', idempotencyKey: `cancel:${order._id}` });
    expect(String(again._id)).toBe(String(rows[0]._id));
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('fundHoldReleasePending (dato interno de dinero) no sale en ninguna respuesta', async () => {
    const order = await newOrder();
    await Order.updateOne(
      { _id: order._id },
      { $set: { fundHoldReleasePending: { driverId: driver._id, amount: 5000, token: 'secreto-interno' } } }
    );
    const su = await makeStaff({ roleSlug: 'super_admin' });
    const urls: Array<[any, string]> = [
      [client, `/api/v1/orders/${order._id}`],
      [su, `/api/v1/orders/${order._id}`],
      [su, `${A}/${order._id}/profile-360`],
      [client, '/api/v1/orders/my'],
    ];
    for (const [u, url] of urls) {
      const res = await request(app).get(url).set(await authHeader(u));
      expect(res.status, url).toBe(200);
      expect(JSON.stringify(res.body), url).not.toMatch(/fundHoldReleasePending|secreto-interno/);
    }
  });

  it('el limitador de avisos cuenta por pedido, esta montado en la ruta y da 429', async () => {
    const layer = (adminOrdersRouter as any).stack.find((l: any) => l.route?.path === '/notify');
    expect(layer.route.stack.map((x: any) => x.handle)).toContain(orderNotifyRateLimiter);

    const r = Router({ mergeParams: true });
    r.post('/notify', createOrderNotifyRateLimiter(2), (_req, res) => res.json({ ok: true }));
    const mini = express();
    mini.use('/o/:id', r);
    const hit = (id: string) => request(mini).post(`/o/${id}/notify`);
    expect((await hit('a')).status).toBe(200);
    expect((await hit('a')).status).toBe(200);
    expect((await hit('a')).status).toBe(429);
    expect((await hit('b')).status).toBe(200);
  });

  describe('H2: cancelar un pedido pagado como admin', () => {
    const cancel = async (staff: any, orderId: string) =>
      request(app)
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(await authHeader(staff))
        .send({ status: OrderStatus.CANCELLED, cancellationCode: 'business_closed' });

    it('Operaciones no cancela un PAID en PREPARING: 403, sin Refund y estado intacto', async () => {
      const order = await newOrder();
      await pay(order);
      await Order.updateOne({ _id: order._id }, { status: OrderStatus.PREPARING });
      const ops = await makeStaff({ roleSlug: 'operaciones' });

      const res = await cancel(ops, order._id.toString());
      expect(res.status).toBe(403);
      expect(await Refund.countDocuments({ orderId: order._id })).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PREPARING);
    });

    it('en PENDING basta orders:cancel y sale el reembolso completo', async () => {
      const order = await newOrder();
      await pay(order);
      const ops = await makeStaff({ roleSlug: 'operaciones' });

      const res = await cancel(ops, order._id.toString());
      expect(res.status).toBe(200);
      const refunds = await Refund.find({ orderId: order._id });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].kind).toBe(RefundKind.FULL);
    });

    it('con orders:cancel + refunds:create en PREPARING si cancela', async () => {
      const order = await newOrder();
      await pay(order);
      await Order.updateOne({ _id: order._id }, { status: OrderStatus.PREPARING });
      const both = await makeStaff({
        roleSlug: 'operaciones',
        permissions: [...STAFF_ROLE_PERMISSIONS.operaciones.permissions, Permission.REFUNDS_CREATE],
      });
      const res = await cancel(both, order._id.toString());
      expect(res.status).toBe(200);
      expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);
    });

    it('un admin debe dar cancellationCode y "other" exige motivo de 10+ caracteres', async () => {
      const order = await newOrder();
      const ops = await makeStaff({ roleSlug: 'operaciones' });
      const h = await authHeader(ops);
      const url = `/api/v1/orders/${order._id}/status`;
      expect((await request(app).patch(url).set(h).send({ status: OrderStatus.CANCELLED })).status).toBe(400);
      expect(
        (await request(app).patch(url).set(h).send({ status: OrderStatus.CANCELLED, cancellationCode: 'other', cancellationReason: 'corto' })).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch(url)
            .set(h)
            .send({ status: OrderStatus.CANCELLED, cancellationCode: 'other', cancellationReason: 'motivo suficientemente largo' })
        ).status
      ).toBe(200);
    });
  });
});
