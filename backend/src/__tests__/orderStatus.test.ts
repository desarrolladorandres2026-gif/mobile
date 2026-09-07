import { describe, it, expect } from 'vitest';
import { orderService } from '../services/order.service';
import { Order, Coupon } from '../models';
import { OrderStatus, UserRole, PaymentStatus, CouponType } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makeCoupon,
  makePricingConfig, pickUpOrder, deliverToCustomer,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

async function createOrder(extra: Record<string, unknown> = {}) {
  // This file exercises the cash flow (driver fund, remittance), which is
  // now an admin-controlled switch that ships disabled.
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const product = await makeProduct(business._id, { price: 20000 });

  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
    ...extra,
  });

  return { client, owner, business, product, order };
}

/** Drives an order forward through the happy path. */
async function advanceTo(orderId: string, ownerId: string, target: OrderStatus) {
  const path: OrderStatus[] = [
    OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY,
  ];
  for (const status of path) {
    await orderService.updateStatus(orderId, status, ownerId, UserRole.BUSINESS);
    if (status === target) return;
  }
}

describe('OrderService.updateStatus — transiciones', () => {
  it('permite la secuencia normal del negocio', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();
    const ownerId = owner._id.toString();

    let updated = await orderService.updateStatus(id, OrderStatus.ACCEPTED, ownerId, UserRole.BUSINESS);
    expect(updated.status).toBe(OrderStatus.ACCEPTED);
    expect(updated.acceptedAt).toBeTruthy();

    updated = await orderService.updateStatus(id, OrderStatus.PREPARING, ownerId, UserRole.BUSINESS);
    expect(updated.status).toBe(OrderStatus.PREPARING);

    updated = await orderService.updateStatus(id, OrderStatus.READY, ownerId, UserRole.BUSINESS);
    expect(updated.status).toBe(OrderStatus.READY);
  });

  it('rechaza saltarse estados', async () => {
    const { owner, order } = await createOrder();

    await expect(
      orderService.updateStatus(
        order._id.toString(), OrderStatus.DELIVERED, owner._id.toString(), UserRole.BUSINESS
      )
    ).rejects.toThrow(/transición inválida/i);
  });

  it('rechaza retroceder de estado', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();
    const ownerId = owner._id.toString();

    await orderService.updateStatus(id, OrderStatus.ACCEPTED, ownerId, UserRole.BUSINESS);

    await expect(
      orderService.updateStatus(id, OrderStatus.ACCEPTED, ownerId, UserRole.BUSINESS)
    ).rejects.toThrow(/transición inválida/i);
  });

  it('un pedido entregado es terminal', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();
    const ownerId = owner._id.toString();

    await advanceTo(id, ownerId, OrderStatus.READY);

    // El reparto ya no se puede simular cambiando estados: hay que estar
    // asignado y pasar por los dos códigos.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
    await orderService.assignDriver(id, driver._id.toString());
    const driverId = driverUser._id.toString();

    await pickUpOrder(id, driverUser);
    await orderService.updateStatus(id, OrderStatus.ON_WAY, driverId, UserRole.DRIVER);
    await deliverToCustomer(id, driverUser);

    await expect(
      orderService.updateStatus(id, OrderStatus.CANCELLED, ownerId, UserRole.BUSINESS)
    ).rejects.toThrow(/transición inválida/i);
  });

  /**
   * Delivering is not collecting.
   *
   * This assertion used to be the opposite, and it was the mechanism by
   * which every online order was marked PAID without a single peso being
   * charged. A cash order does not become PAID at the door either: it stays
   * in PENDING_CASH until the driver declares they took the money
   * (PaymentService.confirmCashCollection), and only then does the
   * remittance ZIPP is owed start counting.
   */
  it('entregar no marca el pago como cobrado', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();

    await advanceTo(id, owner._id.toString(), OrderStatus.READY);

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
    await orderService.assignDriver(id, driver._id.toString());

    const driverId = driverUser._id.toString();
    await pickUpOrder(id, driverUser);
    await orderService.updateStatus(id, OrderStatus.ON_WAY, driverId, UserRole.DRIVER);
    const delivered = await deliverToCustomer(id, driverUser);

    expect(delivered.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
    expect(delivered.deliveredAt).toBeTruthy();
  });
});

describe('OrderService.updateStatus — permisos por rol', () => {
  it('un cliente no puede aceptar su propio pedido', async () => {
    const { client, order } = await createOrder();

    await expect(
      orderService.updateStatus(
        order._id.toString(), OrderStatus.ACCEPTED, client._id.toString(), UserRole.CLIENT
      )
    ).rejects.toThrow(/tu rol no puede/i);
  });

  it('un cliente sí puede cancelar su propio pedido', async () => {
    const { client, order } = await createOrder();

    const cancelled = await orderService.updateStatus(
      order._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Ya no lo necesito'
    );

    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.cancellationReason).toBe('Ya no lo necesito');
    expect(cancelled.cancelledAt).toBeTruthy();
  });

  it('un cliente no puede cancelar el pedido de otro', async () => {
    const { order } = await createOrder();
    const intruder = await makeUser({ role: UserRole.CLIENT });

    await expect(
      orderService.updateStatus(
        order._id.toString(), OrderStatus.CANCELLED, intruder._id.toString(), UserRole.CLIENT
      )
    ).rejects.toThrow(/no autorizado/i);
  });

  it('un negocio ajeno no puede modificar el pedido', async () => {
    const { order } = await createOrder();
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      orderService.updateStatus(
        order._id.toString(), OrderStatus.ACCEPTED, otherOwner._id.toString(), UserRole.BUSINESS
      )
    ).rejects.toThrow(/no autorizado/i);
  });

  it('un domiciliario no puede aceptar el pedido en nombre del negocio', async () => {
    const { order } = await createOrder();
    // Asignado de verdad: así lo que se prueba es la frontera de rol y no
    // la de asignación, que tiene su propio caso más abajo.
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
    await Order.updateOne({ _id: order._id }, { $set: { driverId: driver._id } });

    await expect(
      orderService.updateStatus(
        order._id.toString(), OrderStatus.ACCEPTED, driverUser._id.toString(), UserRole.DRIVER
      )
    ).rejects.toThrow(/tu rol no puede/i);
  });

  it('un domiciliario ajeno no puede mover el pedido de otro', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();
    await advanceTo(id, owner._id.toString(), OrderStatus.READY);

    const assignedUser = await makeUser({ role: UserRole.DRIVER });
    const assigned = await makeDriver(assignedUser._id, { currentFund: 50000 });
    await orderService.assignDriver(id, assigned._id.toString());

    const strangerUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(strangerUser._id, { currentFund: 50000 });

    await expect(
      orderService.updateStatus(id, OrderStatus.PICKED_UP, strangerUser._id.toString(), UserRole.DRIVER)
    ).rejects.toThrow(/no autorizado/i);
  });

  it('sin código de recogida no se puede marcar recogido', async () => {
    const { owner, order } = await createOrder();
    const id = order._id.toString();
    await advanceTo(id, owner._id.toString(), OrderStatus.READY);

    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 50000 });
    await orderService.assignDriver(id, driver._id.toString());

    await expect(
      orderService.updateStatus(id, OrderStatus.PICKED_UP, driverUser._id.toString(), UserRole.DRIVER)
    ).rejects.toThrow(/código de recogida/i);
  });
});

describe('OrderService — cancelación y cupones', () => {
  it('cancelar devuelve el uso del cupón', async () => {
    await makePricingConfig();
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });
    const coupon = await makeCoupon({ code: 'REEMBOLSO', type: CouponType.FIXED, value: 5000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'online',
      deliveryAddress: 'Calle 5',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      couponCode: 'REEMBOLSO',
    });

    expect((await Coupon.findById(coupon._id))!.usedCount).toBe(1);

    await orderService.updateStatus(
      order._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT
    );

    expect((await Coupon.findById(coupon._id))!.usedCount).toBe(0);
  });
});

describe('OrderService.assignDriver', () => {
  it('asigna un domiciliario disponible', async () => {
    const { order } = await createOrder();
    const driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id);

    const updated = await orderService.assignDriver(order._id.toString(), driver._id.toString());

    expect(updated.driverId!.toString()).toBe(driver._id.toString());
  });

  it('no reasigna un pedido que ya tiene domiciliario', async () => {
    const { order } = await createOrder();
    const driverA = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id);
    const driverB = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id);

    await orderService.assignDriver(order._id.toString(), driverA._id.toString());

    await expect(
      orderService.assignDriver(order._id.toString(), driverB._id.toString())
    ).rejects.toThrow(/ya tiene domiciliario/i);
  });

  it('rechaza domiciliarios no aprobados', async () => {
    const { order } = await createOrder();
    const driver = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id, {
      isApproved: false,
    });

    await expect(
      orderService.assignDriver(order._id.toString(), driver._id.toString())
    ).rejects.toThrow(/no disponible/i);
  });

  it('contra entrega exige fondo suficiente y lo descuenta', async () => {
    const { order } = await createOrder();
    const poorDriver = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id, {
      currentFund: 100,
    });

    await expect(
      orderService.assignDriver(order._id.toString(), poorDriver._id.toString())
    ).rejects.toThrow(/fondo insuficiente/i);

    const richDriver = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id, {
      currentFund: 50000,
    });

    await orderService.assignDriver(order._id.toString(), richDriver._id.toString());

    const { Driver } = await import('../models');
    const refreshed = await Driver.findById(richDriver._id);
    // 18.000 = subtotal 20.000 − comisión 2.000. El repartidor adelanta lo
    // que se le debe al comercio, no la comisión de ZIPP.
    expect(refreshed!.currentFund).toBe(50000 - order.finance.businessPayout);
    expect(order.finance.businessPayout).toBe(18000);
  });
});
