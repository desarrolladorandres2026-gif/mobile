import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Business, BusinessStaff, BusinessRole, Order, Driver } from '../models';
import { OrderStatus, UserRole } from '../types';
import { orderService, TERMINAL_ORDER_STATUSES } from '../services/order.service';
import { resolveOrderAccess, TERMINAL_STATUSES } from '../services/orderAccess.service';
import { getOrderTracking } from '../services/tracking.service';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, makeDriver, runDelivery,
} from './factories';

/**
 * El PC del mostrador con la cuenta de un empleado.
 *
 * Antes los pedidos eran solo del dueño: el empleado los recibía por socket,
 * la lista le respondía 403 y su panel no hacía sonar nada. Estas pruebas
 * fijan lo que ahora puede cada papel, y lo que sigue fuera de su alcance.
 */

const DESTINATION = offsetKm(GARZON, 2);

let owner: any;
let business: any;
let product: any;
let client: any;

async function placeOrder() {
  return orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });
}

async function employee(role: BusinessRole.MANAGER | BusinessRole.OPERATOR, isActive = true) {
  const user = await makeUser({ role: UserRole.BUSINESS });
  await BusinessStaff.create({ businessId: business._id, userId: user._id, role, isActive });
  return user;
}

const list = async (user: any) =>
  request(app).get(`/api/v1/orders/business/${business._id}`).set(await authHeader(user));

beforeEach(async () => {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  owner = await makeUser({ role: UserRole.BUSINESS });
  business = await makeBusiness(owner._id);
  product = await makeProduct(business._id, { price: 20000 });
  client = await makeUser({ role: UserRole.CLIENT });
});

describe('Pedidos para el personal del comercio', () => {
  it('el encargado y el mostrador ven la lista de su negocio', async () => {
    await placeOrder();
    for (const role of [BusinessRole.MANAGER, BusinessRole.OPERATOR] as const) {
      const res = await list(await employee(role));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    }
  });

  it('el personal recibe el pedido sin el margen de ZIPP ni el pago al domiciliario', async () => {
    await placeOrder();
    const res = await list(await employee(BusinessRole.OPERATOR));
    const order = res.body.data[0];
    expect(order.driverPayout).toBeUndefined();
    expect(order.finance?.driverPayout).toBeUndefined();
    expect(order.finance?.platformGrossRevenue).toBeUndefined();
    // Lo que el propio comercio cobra sí lo ve (MERCHANT_STAFF_FINANCE_FIELDS).
    expect(order.finance?.businessPayout).toBeDefined();
  });

  it('un empleado dado de baja o de otro negocio no ve nada', async () => {
    await placeOrder();
    expect((await list(await employee(BusinessRole.OPERATOR, false))).status).toBe(403);

    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const outsider = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: other._id, userId: outsider._id, role: BusinessRole.MANAGER });
    expect((await list(outsider)).status).toBe(403);
  });

  it('el mostrador acepta y prepara el pedido', async () => {
    const order = await placeOrder();
    const staff = await employee(BusinessRole.OPERATOR);
    const id = order._id.toString();

    const accepted = await orderService.updateStatus(id, OrderStatus.ACCEPTED, staff._id.toString(), UserRole.BUSINESS);
    expect(accepted.status).toBe(OrderStatus.ACCEPTED);
  });

  it('un empleado de otro negocio no puede mover el pedido', async () => {
    const order = await placeOrder();
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });
    const other = await makeBusiness(otherOwner._id);
    const outsider = await makeUser({ role: UserRole.BUSINESS });
    await BusinessStaff.create({ businessId: other._id, userId: outsider._id, role: BusinessRole.OPERATOR });

    await expect(
      orderService.updateStatus(order._id.toString(), OrderStatus.ACCEPTED, outsider._id.toString(), UserRole.BUSINESS)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('el mostrador ve solo el día: el historial cerrado de ayer queda fuera, lo que sigue en curso no', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const closed = await placeOrder();
    const ongoing = await placeOrder();
    await Order.collection.updateOne(
      { _id: closed._id },
      { $set: { createdAt: yesterday, status: OrderStatus.DELIVERED } }
    );
    await Order.collection.updateOne({ _id: ongoing._id }, { $set: { createdAt: yesterday } });

    const staffRes = await list(await employee(BusinessRole.OPERATOR));
    const staffIds = staffRes.body.data.map((o: any) => o._id);
    expect(staffIds).toContain(ongoing._id.toString());
    expect(staffIds).not.toContain(closed._id.toString());

    // El encargado y el dueño no tienen ese recorte.
    const managerIds = (await list(await employee(BusinessRole.MANAGER))).body.data.map((o: any) => o._id);
    expect(managerIds).toContain(closed._id.toString());

    // Y el detalle de un pedido fuera de su día responde igual que uno ajeno.
    const staff = await employee(BusinessRole.OPERATOR);
    await expect(resolveOrderAccess(closed._id.toString(), staff)).rejects.toMatchObject({ statusCode: 404 });
    const access = await resolveOrderAccess(ongoing._id.toString(), staff);
    expect(access.participant).toBe('business');
    expect(access.businessRole).toBe(BusinessRole.OPERATOR);
  });

  it('la copia local de estados terminales coincide con la máquina de estados', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([...TERMINAL_ORDER_STATUSES].sort());
  });

  // Auditoría de seguridad 2026-10-01.
  it('ALTO 1: aceptar/cancelar tampoco devuelve el margen de ZIPP al personal', async () => {
    const order = await placeOrder();
    const res = await request(app)
      .patch(`/api/v1/orders/${order._id}/status`)
      .set(await authHeader(await employee(BusinessRole.OPERATOR)))
      .send({ status: OrderStatus.ACCEPTED });
    expect(res.status).toBe(200);
    expect(res.body.data.driverPayout).toBeUndefined();
    expect(res.body.data.finance?.driverPayout).toBeUndefined();
    expect(res.body.data.finance?.platformGrossRevenue).toBeUndefined();
  });

  it('ALTO 2: GET /orders/:id no entrega el documento Driver entero', async () => {
    const order = await placeOrder();
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const res = await request(app)
      .get(`/api/v1/orders/${order._id}`)
      .set(await authHeader(await employee(BusinessRole.OPERATOR)));
    expect(res.status).toBe(200);
    expect(res.body.data.driverId.emergencyContact).toBeUndefined();
    expect(res.body.data.driverId.currentFund).toBeUndefined();
    expect(res.body.data.driverId.baseFund).toBeUndefined();
    expect(res.body.data.driverId.vehicleType).toBeDefined();
  });

  it('ALTO 3: sin ubicación en vivo del domiciliario tras la entrega, ni para el negocio', async () => {
    const order = await placeOrder();
    const staff = await employee(BusinessRole.OPERATOR);
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    const driver = await Driver.findOne({ userId: driverUser._id });
    await orderService.assignDriver(order._id.toString(), driver!._id.toString());
    await orderService.updateStatus(order._id.toString(), OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS);
    await orderService.updateStatus(order._id.toString(), OrderStatus.PREPARING, owner._id.toString(), UserRole.BUSINESS);
    await orderService.updateStatus(order._id.toString(), OrderStatus.READY, owner._id.toString(), UserRole.BUSINESS);

    // En curso: el negocio sí ve dónde está, pero no el destino del cliente.
    const inProgress = await getOrderTracking(order._id.toString(), { _id: staff._id, role: UserRole.BUSINESS });
    expect(inProgress.driver).not.toBeNull();
    expect(inProgress.destination.location).toBeNull();

    await runDelivery(order._id.toString(), driverUser);

    const afterDelivery = await getOrderTracking(order._id.toString(), { _id: staff._id, role: UserRole.BUSINESS });
    expect(afterDelivery.driver).toBeNull();

    // Y la lista del negocio tampoco arrastra la posición de un pedido cerrado.
    const list = await request(app)
      .get(`/api/v1/orders/business/${business._id}?status=delivered`)
      .set(await authHeader(staff));
    const listed = list.body.data.find((o: any) => o._id === order._id.toString());
    expect(listed.driverId.currentLocation).toBeUndefined();
  });

  it('ALTO 4: el historial cerrado enmascara el teléfono del cliente y quita la ubicación exacta', async () => {
    const order = await placeOrder();
    await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.DELIVERED } });

    const res = await request(app)
      .get(`/api/v1/orders/business/${business._id}?status=delivered`)
      .set(await authHeader(await employee(BusinessRole.MANAGER)));
    const listed = res.body.data[0];
    expect(listed.clientId.phone).not.toBe(client.phone);
    expect(listed.clientId.phone).toMatch(/\*/);
    expect(listed.deliveryLocation).toBeUndefined();

    // El dueño sigue viendo todo tal cual.
    const ownerRes = await request(app)
      .get(`/api/v1/orders/business/${business._id}?status=delivered`)
      .set(await authHeader(owner));
    expect(ownerRes.body.data[0].clientId.phone).toBe(client.phone);
  });

  it('MEDIO 5: el personal no lee el chat del pedido', async () => {
    const order = await placeOrder();
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const res = await request(app)
      .get(`/api/v1/orders/${order._id}/chat`)
      .set(await authHeader(await employee(BusinessRole.MANAGER)));
    expect(res.status).toBe(403);
  });

  it('MEDIO 7: el personal no cancela un pedido ya pagado en preparación; el dueño sí', async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'online',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'paid' } });
    const id = order._id.toString();
    await orderService.updateStatus(id, OrderStatus.ACCEPTED, owner._id.toString(), UserRole.BUSINESS);
    await orderService.updateStatus(id, OrderStatus.PREPARING, owner._id.toString(), UserRole.BUSINESS);

    const staff = await employee(BusinessRole.OPERATOR);
    await expect(
      orderService.updateStatus(id, OrderStatus.CANCELLED, staff._id.toString(), UserRole.BUSINESS, undefined, {}, 'other' as any)
    ).rejects.toMatchObject({ statusCode: 403, code: 'OWNER_CANCEL_REQUIRED' });

    const cancelled = await orderService.updateStatus(
      id, OrderStatus.CANCELLED, owner._id.toString(), UserRole.BUSINESS, undefined, {}, 'other' as any
    );
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
  });
});

describe('Abrir y cerrar el negocio', () => {
  const setOpen = async (user: any, isActive: boolean) =>
    request(app).patch(`/api/v1/businesses/${business._id}/open`).set(await authHeader(user)).send({ isActive });

  it('el dueño y el personal lo abren y lo cierran', async () => {
    for (const user of [owner, await employee(BusinessRole.MANAGER), await employee(BusinessRole.OPERATOR)]) {
      expect((await setOpen(user, false)).status).toBe(200);
      expect((await Business.findById(business._id))!.isActive).toBe(false);
      expect((await setOpen(user, true)).status).toBe(200);
      expect((await Business.findById(business._id))!.isActive).toBe(true);
    }
  });

  it('solo viaja isActive: cualquier otro campo se rechaza', async () => {
    const res = await request(app)
      .patch(`/api/v1/businesses/${business._id}/open`)
      .set(await authHeader(await employee(BusinessRole.OPERATOR)))
      .send({ isActive: true, name: 'Otro nombre' });
    expect(res.status).toBe(400);
  });

  it('un desconocido no puede', async () => {
    const stranger = await makeUser({ role: UserRole.BUSINESS });
    expect((await setOpen(stranger, false)).status).toBe(403);
  });

  it('el mostrador que cerró anoche sigue viendo el negocio para abrirlo', async () => {
    const staff = await employee(BusinessRole.OPERATOR);
    await setOpen(staff, false);
    const res = await request(app).get('/api/v1/businesses/my/businesses').set(await authHeader(staff));
    expect(res.status).toBe(200);
    expect(res.body.data.map((b: any) => b._id)).toContain(business._id.toString());
  });
});
