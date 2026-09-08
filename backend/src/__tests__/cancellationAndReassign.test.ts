import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Order, Driver } from '../models';
import {
  OrderStatus, UserRole, PaymentMethod, CancellationReason, CancelledBy,
} from '../types';
import { orderService } from '../services/order.service';
import {
  reassignStalledPickups, setDispatchEnabled, dispatchService,
} from '../services/dispatch.service';
import { forgetDriver } from '../services/tracking.service';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, GARZON,
} from './factories';

/**
 * Cancelaciones con nombre y apellido, y rescate de pedidos estancados.
 *
 * Antes una cancelación era un texto libre y el actor solo quedaba en la
 * bitácora, así que la pregunta que importa —¿cancelamos por falta de
 * repartidores o porque los negocios no dan abasto?— no se podía responder.
 *
 * Y un domiciliario que aceptaba y no aparecía congelaba el pedido: dejaba
 * de ofrecerse a nadie más y nadie se enteraba hasta que alguien lo miraba
 * a mano.
 */
describe('Cancelaciones y reasignación', () => {
  let client: any;
  let business: any;
  let product: any;
  let driverUser: any;
  let driver: any;

  const newOrder = (paymentMethod = PaymentMethod.ONLINE) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id, { price: 20000 });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id, { isApproved: true, isActive: true });
    forgetDriver(driverUser._id.toString());
  });

  afterEach(() => {
    setDispatchEnabled(false);
    forgetDriver(driverUser._id.toString());
  });

  // ── Cancelaciones ──

  it('guarda el motivo del catálogo, no solo un texto libre', async () => {
    const order = await newOrder();

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Ya no lo necesito',
      {},
      CancellationReason.CLIENT_CHANGED_MIND
    );

    const saved = await Order.findById(order._id);
    expect(saved!.cancellationCode).toBe(CancellationReason.CLIENT_CHANGED_MIND);
    expect(saved!.cancellationReason).toBe('Ya no lo necesito');
  });

  it('registra quién canceló en el propio pedido', async () => {
    const order = await newOrder();

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      undefined,
      {},
      CancellationReason.CLIENT_CHANGED_MIND
    );

    // Es la pregunta que hace soporte en cada reclamo. Antes había que
    // reconstruirla leyendo la bitácora.
    const saved = await Order.findById(order._id);
    expect(saved!.cancelledBy).toBe(CancelledBy.CLIENT);
    expect(saved!.cancelledByUserId!.toString()).toBe(client._id.toString());
  });

  it('distingue una cancelación del negocio de una del cliente', async () => {
    const order = await newOrder();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      business.ownerId.toString(),
      UserRole.BUSINESS,
      undefined,
      {},
      CancellationReason.BUSINESS_OUT_OF_STOCK
    );

    const saved = await Order.findById(order._id);
    expect(saved!.cancelledBy).toBe(CancelledBy.BUSINESS);
    expect(saved!.cancellationCode).toBe(CancellationReason.BUSINESS_OUT_OF_STOCK);
  });

  it('cancelar sin motivo del catálogo sigue funcionando', async () => {
    // Los pedidos anteriores al catálogo y las integraciones viejas no
    // pueden romperse por un campo nuevo.
    const order = await newOrder();

    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT
    );

    const saved = await Order.findById(order._id);
    expect(saved!.status).toBe(OrderStatus.CANCELLED);
    expect(saved!.cancellationCode).toBeFalsy();
    expect(saved!.cancelledBy).toBe(CancelledBy.CLIENT);
  });

  // ── Liberar a quien no aparece ──

  it('quita el pedido al domiciliario que aceptó y no recogió', async () => {
    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    const released = await orderService.unassignDriver(order._id.toString(), 'prueba');

    expect(released).not.toBeNull();
    const saved = await Order.findById(order._id);
    expect(saved!.driverId).toBeNull();
    expect(saved!.assignedAt).toBeNull();
  });

  it('le devuelve el fondo retenido si el pedido era en efectivo', async () => {
    // El efectivo viene apagado en la configuración de prueba por defecto.
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 500000 });

    const order = await newOrder(PaymentMethod.CASH_ON_DELIVERY);
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });

    const before = await Driver.findById(driver._id);
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    const during = await Driver.findById(driver._id);
    expect(during!.currentFund).toBeLessThan(before!.currentFund);

    await orderService.unassignDriver(order._id.toString(), 'prueba');

    // Es dinero de una persona, apartado por un pedido que ya no reparte.
    const after = await Driver.findById(driver._id);
    expect(after!.currentFund).toBe(before!.currentFund);
  });

  it('NO se lo quita si ya lo recogió', async () => {
    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.PICKED_UP });

    // Después de recoger, el pedido ya está en la moto: quitárselo por
    // reloj inventaría un problema peor.
    const released = await orderService.unassignDriver(order._id.toString(), 'prueba');
    expect(released).toBeNull();

    const saved = await Order.findById(order._id);
    expect(saved!.driverId!.toString()).toBe(driver._id.toString());
  });

  it('un pedido sin domiciliario no se puede liberar', async () => {
    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });

    expect(await orderService.unassignDriver(order._id.toString(), 'prueba')).toBeNull();
  });

  // ── Barrido de estancados ──

  it('el barrido rescata un pedido que lleva demasiado sin recogerse', async () => {
    setDispatchEnabled(true);

    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    // Se envejece la asignación por el driver nativo: `assignedAt` lo
    // escribe el servicio y aquí hace falta moverlo al pasado.
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { assignedAt: new Date(Date.now() - dispatchService.PICKUP_GRACE_MS - 60_000) } }
    );

    expect(await reassignStalledPickups()).toBe(1);

    const saved = await Order.findById(order._id);
    expect(saved!.driverId).toBeNull();
  });

  it('el barrido no toca una asignación reciente', async () => {
    setDispatchEnabled(true);

    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());

    expect(await reassignStalledPickups()).toBe(0);

    const saved = await Order.findById(order._id);
    expect(saved!.driverId!.toString()).toBe(driver._id.toString());
  });

  it('con el reparto apagado, el barrido no hace nada', async () => {
    setDispatchEnabled(false);

    const order = await newOrder();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.READY });
    await orderService.assignDriver(order._id.toString(), driver._id.toString());
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { assignedAt: new Date(Date.now() - dispatchService.PICKUP_GRACE_MS - 60_000) } }
    );

    expect(await reassignStalledPickups()).toBe(0);
  });
});
