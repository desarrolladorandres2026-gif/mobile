import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Order } from '../models';
import { OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import { makeUser, makeBusiness, makePricingConfig, authHeader, GARZON } from './factories';

/**
 * Portada por papel (`GET /businesses/:id/role-summary`).
 *
 * Lo que importa no es que sume bien —eso ya lo prueba el cierre del día—
 * sino que la forma dependa del permiso y que ninguna de ellas deje
 * escapar neto, comisión ni descuentos asumidos.
 */

let owner: any;
let business: any;
let client: any;
const url = () => `/api/v1/businesses/${business._id}/role-summary`;

async function member(role: BusinessRole) {
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role });
  return user;
}

function order(status: OrderStatus, paymentMethod: PaymentMethod, subtotal: number) {
  return Order.create({
    orderNumber: `ZIPP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    clientId: client._id,
    businessId: business._id,
    items: [],
    status,
    paymentMethod,
    paymentStatus: paymentMethod === PaymentMethod.ONLINE ? PaymentStatus.PAID : PaymentStatus.PENDING,
    deliveryAddress: 'Calle falsa 123',
    deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
    subtotal,
    deliveryFee: 4000,
    total: subtotal + 4000,
    platformCommission: 2000,
    businessPayout: subtotal - 2000,
    driverPayout: 4000,
    finance: { productSubtotal: subtotal, merchantCommission: 2000, businessPayout: subtotal - 2000 },
  });
}

/** Ninguna forma de la portada puede nombrar la capa financiera. */
function expectNoFinance(body: unknown) {
  const text = JSON.stringify(body);
  for (const key of ['merchantCommission', 'businessPayout', 'merchantFundedDiscount', 'platformCommission']) {
    expect(text).not.toContain(key);
  }
}

beforeEach(async () => {
  await makePricingConfig({});
  owner = await makeUser({ role: UserRole.BUSINESS });
  client = await makeUser({ role: UserRole.CLIENT });
  business = await makeBusiness(owner._id);

  await order(OrderStatus.PENDING, PaymentMethod.CASH_ON_DELIVERY, 10000);
  await order(OrderStatus.PREPARING, PaymentMethod.CASH_ON_DELIVERY, 15000);
  await order(OrderStatus.READY, PaymentMethod.ONLINE, 12000);
  await order(OrderStatus.DELIVERED, PaymentMethod.CASH_ON_DELIVERY, 20000);
  await order(OrderStatus.DELIVERED, PaymentMethod.ONLINE, 30000);
  await order(OrderStatus.CANCELLED, PaymentMethod.CASH_ON_DELIVERY, 9000);
});

describe('Portada por papel', () => {
  it('el operador ve la cola de pedidos y nada de dinero', async () => {
    const res = await request(app).get(url()).set(await authHeader(await member(BusinessRole.OPERATOR)));
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('kitchen');
    expect(res.body.data.queue).toEqual({ pending: 1, preparing: 1, ready: 1, onTheWay: 0 });
    expect(res.body.data.ordersDelivered).toBe(2);
    expect(res.body.data.ordersCancelled).toBe(1);
    expect(res.body.data).not.toHaveProperty('sales');
    expectNoFinance(res.body);
  });

  it('el cajero ve las ventas del día por medio de pago y lo pendiente', async () => {
    const res = await request(app).get(url()).set(await authHeader(await member(BusinessRole.CASHIER)));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.kind).toBe('shift');
    expect(data.sales).toBe(50000);
    expect(data.byPaymentMethod).toEqual([
      { method: PaymentMethod.CASH_ON_DELIVERY, orders: 1, sales: 20000 },
      { method: PaymentMethod.ONLINE, orders: 1, sales: 30000 },
    ]);
    expect(data.pendingOrders).toBe(3);
    expect(data.pendingSales).toBe(37000);
    expectNoFinance(res.body);
  });

  it('el administrador ve el día operativo sin neto ni comisión', async () => {
    const res = await request(app).get(url()).set(await authHeader(await member(BusinessRole.MANAGER)));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.kind).toBe('operations');
    expect(data.today.ordersDelivered).toBe(2);
    expect(data.today.sales).toBe(50000);
    expect(data.queue.pending).toBe(1);
    expectNoFinance(res.body);
  });

  it('el administrador sigue sin acceso al cierre financiero', async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${business._id}/daily-summary`)
      .set(await authHeader(await member(BusinessRole.MANAGER)));
    expect(res.status).toBe(403);
  });

  it('una invitación pendiente o un suspendido no ven nada', async () => {
    for (const status of ['pending', 'suspended'] as const) {
      const user = await makeUser({ role: UserRole.BUSINESS });
      await BusinessStaff.create({
        businessId: business._id, userId: user._id, role: BusinessRole.CASHIER, status, isActive: false,
      });
      const res = await request(app).get(url()).set(await authHeader(user));
      expect(res.status).toBe(403);
    }
  });

  it('un empleado de otro negocio no ve este', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const alien = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: other._id, userId: alien._id, role: BusinessRole.MANAGER });
    const res = await request(app).get(url()).set(await authHeader(alien));
    expect(res.status).toBe(403);
  });
});
