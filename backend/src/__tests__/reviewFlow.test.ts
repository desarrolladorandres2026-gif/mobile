import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business, Driver, Review } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { reviewService } from '../services/review.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, GARZON,
} from './factories';

/**
 * Calificaciones, de punta a punta.
 *
 * El servicio existía completo y nadie lo llamaba desde la app: la nota que
 * se muestra en cada tarjeta de negocio no era una nota, era el número que
 * dejó el sembrado. Estas pruebas cubren lo que faltaba para poder
 * conectarlo — saber qué está pendiente — y comprueban que calificar mueve
 * de verdad la media.
 */
describe('Flujo de calificación', () => {
  let client: any;
  let business: any;
  let product: any;
  let driverUser: any;
  let driver: any;

  const deliveredOrder = async () => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    await Order.updateOne(
      { _id: order._id },
      { status: OrderStatus.DELIVERED, deliveredAt: new Date(), driverId: driver._id }
    );

    return (await Order.findById(order._id))!;
  };

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
  });

  it('un pedido entregado y sin calificar aparece como pendiente', async () => {
    const order = await deliveredOrder();

    const pending = await reviewService.pendingForUser(client._id.toString());
    expect(pending.map((o: any) => o._id.toString())).toContain(order._id.toString());
  });

  it('deja de estar pendiente después de calificarlo', async () => {
    const order = await deliveredOrder();

    await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating: 5,
    });

    const pending = await reviewService.pendingForUser(client._id.toString());
    expect(pending.map((o: any) => o._id.toString())).not.toContain(order._id.toString());
  });

  it('calificar mueve la nota del negocio, que es el punto de todo esto', async () => {
    const before = await Business.findById(business._id);
    const order = await deliveredOrder();

    await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating: 5,
    });

    const after = await Business.findById(business._id);
    expect(after!.rating).toBe(5);
    expect(after!.totalReviews).toBe(1);
    expect(after!.rating).not.toBe(before!.rating);
  });

  it('la nota del domiciliario solo se mueve si se le califica', async () => {
    const order = await deliveredOrder();

    await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      driverId: driver._id.toString(),
      businessRating: 5,
      driverRating: 4,
    });

    const saved = await Driver.findById(driver._id);
    expect(saved!.rating).toBe(4);
  });

  it('calificar solo al negocio deja intacta la nota del domiciliario', async () => {
    const before = await Driver.findById(driver._id);
    const order = await deliveredOrder();

    // La comida y el viaje son dos servicios: una estrella para el
    // restaurante no puede arrastrar al repartidor.
    await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      driverId: driver._id.toString(),
      businessRating: 1,
    });

    const after = await Driver.findById(driver._id);
    expect(after!.rating).toBe(before!.rating);
  });

  it('no se puede calificar dos veces el mismo pedido', async () => {
    const order = await deliveredOrder();
    const input = {
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating: 5,
    };

    await reviewService.create(input);
    await expect(reviewService.create(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(await Review.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('no se puede calificar un pedido de otro', async () => {
    const order = await deliveredOrder();
    const intruso = await makeUser({ role: UserRole.CLIENT });

    await expect(
      reviewService.create({
        orderId: order._id.toString(),
        userId: intruso._id.toString(),
        businessId: business._id.toString(),
        businessRating: 5,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('no se puede calificar un pedido que aún no se entregó', async () => {
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    await expect(
      reviewService.create({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        businessId: business._id.toString(),
        businessRating: 5,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('no pide calificar pedidos viejos, cuya nota ya nadie recuerda', async () => {
    const order = await deliveredOrder();
    await Order.updateOne(
      { _id: order._id },
      { deliveredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    );

    const pending = await reviewService.pendingForUser(client._id.toString());
    expect(pending.map((o: any) => o._id.toString())).not.toContain(order._id.toString());
  });
});
