import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Notification, Product } from '../models';
import { AuditLog, AuditAction } from '../security';
import { OrderStatus, UserRole } from '../types';
import { orderService } from '../services/order.service';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, counterAuthHeader,
} from './factories';

/**
 * Quién hizo qué en el panel del comercio (auditoría 2026-10-09, MEDIO 5).
 *
 * Con varias personas en el mostrador, una cancelación o un cambio de precio
 * sin autor no se puede investigar, y el dueño no se enteraba de lo que sus
 * empleados cancelaban.
 */

const DESTINATION = offsetKm(GARZON, 2);
let owner: any;
let business: any;
let product: any;
let client: any;

async function staffUser(role: BusinessRole) {
  const user = await makeUser({ role: UserRole.BUSINESS, name: `Empleado ${role}` });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role, status: 'active', isActive: true });
  return user;
}

async function placeOrder() {
  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
  return order._id.toString();
}

const cancelViaApi = async (id: string, user: any, reason = 'Se acabó el producto') =>
  request(app)
    .patch(`/api/v1/orders/${id}/status`)
    .set(await authHeader(user))
    .send({ status: OrderStatus.CANCELLED, cancellationReason: reason, cancellationCode: 'other' });

/** Las notificaciones y la auditoría se escriben sin esperar: se da un respiro antes de leerlas. */
async function eventually<T>(read: () => Promise<T[]>, wantAtLeast = 1): Promise<T[]> {
  let rows: T[] = [];
  for (let i = 0; i < 30; i++) {
    rows = await read();
    if (rows.length >= wantAtLeast) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}

const ownerAlerts = (event: string) =>
  Notification.find({ userId: owner._id, 'data.event': event }).lean();

beforeEach(async () => {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
  client = await makeUser({ role: UserRole.CLIENT });
});

describe('Cancelaciones del personal', () => {
  it('cuando cancela un empleado, el dueño recibe un aviso con quién y por qué, una sola vez', async () => {
    const id = await placeOrder();
    const cashier = await staffUser(BusinessRole.EMPLOYEE);

    expect((await cancelViaApi(id, cashier, 'El cliente no contesta')).status).toBe(200);

    const alerts = await eventually(() => ownerAlerts('order_cancelled_by_staff'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('Empleado employee');
    expect(alerts[0].body).toContain('El cliente no contesta');
    expect(alerts[0].data).toMatchObject({ orderId: id, staffUserId: cashier._id.toString() });
    // No promete ningún reembolso: ese es otro proceso con su propio estado.
    expect(alerts[0].body.toLowerCase()).not.toContain('reembols');
    // Y no se duplica con el aviso genérico de cancelación.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await ownerAlerts('order_cancelled')).toHaveLength(0);
    expect(await ownerAlerts('order_cancelled_by_staff')).toHaveLength(1);
  });

  it('cuando cancela el propio dueño no se le avisa de lo que hizo él', async () => {
    const id = await placeOrder();
    expect((await cancelViaApi(id, owner)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await ownerAlerts('order_cancelled_by_staff')).toHaveLength(0);
    expect(await ownerAlerts('order_cancelled')).toHaveLength(0);
  });

  it('una cancelación del cliente sigue avisando al dueño como antes', async () => {
    const id = await placeOrder();
    await orderService.updateStatus(id, OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Me arrepentí', {}, 'client_changed_mind' as any);
    const alerts = await eventually(() => ownerAlerts('order_cancelled'));
    expect(alerts).toHaveLength(1);
  });

  it('queda en la auditoría quién canceló, con su papel y el motivo', async () => {
    const id = await placeOrder();
    const operator = await staffUser(BusinessRole.EMPLOYEE);
    expect((await cancelViaApi(id, operator, 'Sin ingredientes')).status).toBe(200);

    const logs = await eventually(() => AuditLog.find({ action: AuditAction.ORDER_CANCELLED, entityId: id }).lean());
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(operator._id.toString());
    expect(logs[0].timestamp).toBeInstanceOf(Date);
    expect(logs[0].metadata).toMatchObject({
      actorBusinessRole: BusinessRole.EMPLOYEE,
      cancellationCode: 'other',
      businessId: business._id.toString(),
    });
  });

  it('un intento rechazado no deja registro de cancelación ni avisa al dueño', async () => {
    const id = await placeOrder();
    await Product.updateOne({ _id: product._id }, { $set: { isAvailable: true } });
    const cashier = await staffUser(BusinessRole.EMPLOYEE);
    // Sin motivo: el servicio lo rechaza antes de tocar nada.
    const res = await request(app)
      .patch(`/api/v1/orders/${id}/status`)
      .set(await authHeader(cashier))
      .send({ status: OrderStatus.CANCELLED, cancellationCode: 'other' });
    expect(res.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await AuditLog.countDocuments({ action: AuditAction.ORDER_CANCELLED, entityId: id })).toBe(0);
    expect(await ownerAlerts('order_cancelled_by_staff')).toHaveLength(0);
  });
});

describe('Cambios del catálogo', () => {
  const put = async (user: any, body: Record<string, unknown>) =>
    request(app)
      .put(`/api/v1/products/${product._id}`)
      .set(await authHeader(user))
      .send({ businessId: business._id.toString(), ...body });

  const logsOf = (action: AuditAction) =>
    AuditLog.find({ action, entityId: product._id.toString() }).sort({ timestamp: 1 }).lean();

  it('cambiar el precio deja actor, papel, valor anterior y nuevo', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    expect((await put(manager, { price: 25000 })).status).toBe(200);

    const logs = await eventually(() => logsOf(AuditAction.PRODUCT_PRICE_CHANGED));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(manager._id.toString());
    expect(logs[0].metadata).toMatchObject({
      actorBusinessRole: BusinessRole.MANAGER,
      businessId: business._id.toString(),
      price: { from: 20000, to: 25000 },
    });
  });

  it('agotar y reponer dejan al operador como autor, con stock antes y después', async () => {
    const operator = await staffUser(BusinessRole.EMPLOYEE);
    expect((await put(operator, { isAvailable: false })).status).toBe(200);
    expect((await put(operator, { stock: 8 })).status).toBe(200);

    const logs = await eventually(() => logsOf(AuditAction.PRODUCT_AVAILABILITY_CHANGED), 2);
    expect(logs).toHaveLength(2);
    expect(logs[0].userId).toBe(operator._id.toString());
    expect(logs[0].metadata).toMatchObject({ actorBusinessRole: BusinessRole.EMPLOYEE, isAvailable: { from: true, to: false } });
    expect(logs[1].metadata).toMatchObject({ stock: { from: null, to: 8 }, isAvailable: { from: false, to: true } });
    // No es un cambio de precio.
    expect(await logsOf(AuditAction.PRODUCT_PRICE_CHANGED)).toHaveLength(0);
  });

  it('reenviar el mismo valor no escribe otro registro', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    await put(manager, { price: 25000 });
    await eventually(() => logsOf(AuditAction.PRODUCT_PRICE_CHANGED));
    await put(manager, { price: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await logsOf(AuditAction.PRODUCT_PRICE_CHANGED)).toHaveLength(1);
  });

  it('un cambio rechazado no deja registro', async () => {
    const operator = await staffUser(BusinessRole.EMPLOYEE);
    expect((await put(operator, { price: 1 })).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await logsOf(AuditAction.PRODUCT_PRICE_CHANGED)).toHaveLength(0);
  });

  it('eliminar un producto deja quién y cuál era', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    const res = await request(app)
      .delete(`/api/v1/products/${product._id}`)
      .set(await authHeader(manager))
      .send({ businessId: business._id.toString() });
    expect(res.status).toBe(200);

    const logs = await eventually(() => logsOf(AuditAction.PRODUCT_DELETED));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(manager._id.toString());
    expect(logs[0].metadata).toMatchObject({ price: 20000, actorBusinessRole: BusinessRole.MANAGER });
  });

  it('el registro no guarda tokens ni datos de la cuenta', async () => {
    const manager = await staffUser(BusinessRole.MANAGER);
    await put(manager, { price: 26000 });
    const logs = await eventually(() => logsOf(AuditAction.PRODUCT_PRICE_CHANGED));
    const raw = JSON.stringify(logs);
    expect(raw).not.toMatch(/Bearer|authorization|password|token/i);
    expect(raw).not.toContain(manager.email as string);
  });
});

describe('Cancelaciones desde el mostrador (sesión counter, decisión 2026-10-09)', () => {
  it('la cuenta del dueño en el mostrador cancela y el dueño SÍ recibe el aviso de personal', async () => {
    const id = await placeOrder();
    const res = await request(app)
      .patch(`/api/v1/orders/${id}/status`)
      .set(await counterAuthHeader(owner))
      .send({ status: OrderStatus.CANCELLED, cancellationReason: 'El cliente no contesta', cancellationCode: 'other' });
    expect(res.status).toBe(200);

    const alerts = await eventually(() => ownerAlerts('order_cancelled_by_staff'));
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as any).body).toContain('El mostrador');
  });

  it('el dueño en su sesión completa cancela y NO se avisa a sí mismo', async () => {
    const id = await placeOrder();
    expect((await cancelViaApi(id, owner, 'El cliente no contesta')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await ownerAlerts('order_cancelled_by_staff')).toHaveLength(0);
  });
});
