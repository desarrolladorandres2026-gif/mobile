import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { BusinessStaff, BusinessRole, Order, Product } from '../models';
import { OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '../types';
import { makeUser, makeBusiness, makePricingConfig, makeProduct, authHeader, GARZON } from './factories';

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
  it('el empleado ve las ventas del turno y nada de la capa financiera', async () => {
    const res = await request(app).get(url()).set(await authHeader(await member(BusinessRole.EMPLOYEE)));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.kind).toBe('shift');
    expect(data.queue).toEqual({ pending: 1, preparing: 1, ready: 1, onTheWay: 0 });
    expect(data.sales).toBe(50000);
    expect(data.ordersDelivered).toBe(2);
    expect(data.ordersCancelled).toBe(1);
    expectNoFinance(res.body);
  });

  describe('lo que el empleado tiene presente', () => {
    const attention = async () => {
      const res = await request(app).get(url()).set(await authHeader(await member(BusinessRole.EMPLOYEE)));
      expect(res.status).toBe(200);
      expectNoFinance(res.body);
      return res.body.data.attention;
    };

    it('cuánto lleva esperando el pedido nuevo más antiguo', async () => {
      const old = await order(OrderStatus.PENDING, PaymentMethod.CASH_ON_DELIVERY, 8000);
      await Order.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 12 * 60_000) } });
      const { oldestPendingMinutes } = await attention();
      expect(oldestPendingMinutes).toBeGreaterThanOrEqual(12);
      expect(oldestPendingMinutes).toBeLessThan(14);
    });

    it('sin pedidos nuevos no hay espera', async () => {
      await Order.deleteMany({ businessId: business._id, status: OrderStatus.PENDING });
      expect((await attention()).oldestPendingMinutes).toBeNull();
    });

    it('cuenta los programados que esperan y da la hora del próximo, sin mezclar los ya activados', async () => {
      const soon = new Date(Date.now() + 2 * 3_600_000);
      const later = new Date(Date.now() + 72 * 3_600_000);
      const waiting = await order(OrderStatus.PENDING, PaymentMethod.CASH_ON_DELIVERY, 5000);
      const far = await order(OrderStatus.PENDING, PaymentMethod.CASH_ON_DELIVERY, 5000);
      const active = await order(OrderStatus.PENDING, PaymentMethod.CASH_ON_DELIVERY, 5000);
      await Order.updateOne({ _id: waiting._id }, { scheduledFor: soon });
      await Order.updateOne({ _id: far._id }, { scheduledFor: later });
      await Order.updateOne({ _id: active._id }, { scheduledFor: soon, scheduledActivatedAt: new Date() });

      const { scheduled } = await attention();
      expect(scheduled.next).toBe(soon.toISOString());
      // "hoy" depende de la hora a la que corra la prueba; lo que no puede pasar es contar el de 72 h.
      expect(scheduled.today).toBeLessThanOrEqual(1);
    });

    it('lista los productos apagados o sin stock', async () => {
      await makeProduct(business._id, { name: 'Pollo asado', isAvailable: false });
      const noStock = await makeProduct(business._id, { name: 'Gaseosa' });
      await Product.updateOne({ _id: noStock._id }, { stock: 0 });
      await makeProduct(business._id, { name: 'Arepa' });

      const { unavailable } = await attention();
      expect(unavailable.count).toBe(2);
      expect(unavailable.names).toEqual(['Gaseosa', 'Pollo asado']);
    });
  });

  it('el empleado sigue sin acceso al cierre financiero', async () => {
    const res = await request(app)
      .get(`/api/v1/businesses/${business._id}/daily-summary`)
      .set(await authHeader(await member(BusinessRole.EMPLOYEE)));
    expect(res.status).toBe(403);
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
        businessId: business._id, userId: user._id, role: BusinessRole.EMPLOYEE, status, isActive: false,
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

describe('Cierre de caja', () => {
  const closings = () => `/api/v1/businesses/${business._id}/shift-closings`;

  it('el empleado cierra: las ventas las pone el servidor y la diferencia sale del efectivo contado', async () => {
    const employee = await member(BusinessRole.EMPLOYEE);
    const res = await request(app)
      .post(closings())
      .set(await authHeader(employee))
      .send({ declaredCash: 18000, note: 'Faltó un billete' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      sales: 50000, cashSales: 20000, onlineSales: 30000,
      declaredCash: 18000, difference: -2000, closedByRole: BusinessRole.EMPLOYEE,
    });
    expectNoFinance(res.body);

    const list = await request(app).get(closings()).set(await authHeader(employee));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('sin efectivo contado el cierre queda sin diferencia', async () => {
    const res = await request(app).post(closings()).set(await authHeader(await member(BusinessRole.EMPLOYEE))).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.declaredCash).toBeNull();
    expect(res.body.data.difference).toBeNull();
  });

  it('no acepta ventas del cliente, decimales ni montos negativos', async () => {
    const headers = await authHeader(await member(BusinessRole.EMPLOYEE));
    for (const body of [{ sales: 999999 }, { declaredCash: 10.5 }, { declaredCash: -1 }]) {
      const res = await request(app).post(closings()).set(headers).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('el administrador consulta los cierres pero no cierra', async () => {
    const manager = await authHeader(await member(BusinessRole.MANAGER));
    expect((await request(app).get(closings()).set(manager)).status).toBe(200);
    expect((await request(app).post(closings()).set(manager).send({})).status).toBe(403);
  });

  it('un empleado de otro negocio no cierra ni consulta este', async () => {
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const alien = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: other._id, userId: alien._id, role: BusinessRole.EMPLOYEE });
    const headers = await authHeader(alien);
    expect((await request(app).post(closings()).set(headers).send({})).status).toBe(403);
    expect((await request(app).get(closings()).set(headers)).status).toBe(403);
  });
});
