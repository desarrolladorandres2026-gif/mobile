import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business, Driver, Review } from '../models';
import { OrderStatus, UserRole, PaymentMethod, ReviewReasonDriverToBusiness, ReviewReasonBusinessToDriver } from '../types';
import { reviewService } from '../services/review.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, GARZON,
} from './factories';

/**
 * La otra mitad del sistema de reputación: comercio↔domiciliario.
 *
 * Vive en el mismo documento `Review` que la calificación del cliente
 * (mismo pedido, mismo eje), pero no toca `rating` público — solo
 * `reputationScore` interno. Estas pruebas cubren esa separación, las
 * razones estructuradas, y `reviewStatusForOrder`, que es lo que decide qué
 * botones ve cada app.
 */
describe('Calificación operativa comercio↔domiciliario', () => {
  let client: any;
  let businessOwner: any;
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
    businessOwner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(businessOwner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
  });

  describe('domiciliario → comercio', () => {
    it('el domiciliario puede calificar al comercio que recogió', async () => {
      const order = await deliveredOrder();

      const review = await reviewService.rateBusinessByDriver(
        order._id.toString(), driverUser._id.toString(), 2,
        [ReviewReasonDriverToBusiness.WAITING_TIME]
      );

      expect(review.driverRatingOfBusiness).toBe(2);
      expect(review.driverRatingOfBusinessReasons).toEqual(['waiting_time']);
    });

    it('no mueve el rating público del comercio, solo su reputación interna', async () => {
      const order = await deliveredOrder();
      const before = await Business.findById(business._id);

      await reviewService.rateBusinessByDriver(order._id.toString(), driverUser._id.toString(), 1);

      const after = await Business.findById(business._id);
      expect(after!.rating).toBe(before!.rating);
      expect(after!.totalReviews).toBe(before!.totalReviews);
    });

    it('un domiciliario ajeno al pedido no puede calificar', async () => {
      const order = await deliveredOrder();
      const otroDriverUser = await makeUser({ role: UserRole.DRIVER });
      await makeDriver(otroDriverUser._id);

      await expect(
        reviewService.rateBusinessByDriver(order._id.toString(), otroDriverUser._id.toString(), 3)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('no se puede calificar dos veces', async () => {
      const order = await deliveredOrder();
      await reviewService.rateBusinessByDriver(order._id.toString(), driverUser._id.toString(), 4);

      await expect(
        reviewService.rateBusinessByDriver(order._id.toString(), driverUser._id.toString(), 5)
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('no se puede calificar un pedido no entregado', async () => {
      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });
      await Order.updateOne({ _id: order._id }, { driverId: driver._id });

      await expect(
        reviewService.rateBusinessByDriver(order._id.toString(), driverUser._id.toString(), 3)
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('comercio → domiciliario', () => {
    it('el comercio puede calificar al domiciliario que recogió el pedido', async () => {
      const order = await deliveredOrder();

      const review = await reviewService.rateDriverByBusiness(
        order._id.toString(), businessOwner._id.toString(), 2,
        [ReviewReasonBusinessToDriver.LATE_PICKUP]
      );

      expect(review.businessRatingOfDriver).toBe(2);
      expect(review.businessRatingOfDriverReasons).toEqual(['late_pickup']);
    });

    it('no mueve el rating público del domiciliario, solo su reputación interna', async () => {
      const order = await deliveredOrder();
      const before = await Driver.findById(driver._id);

      await reviewService.rateDriverByBusiness(order._id.toString(), businessOwner._id.toString(), 1);

      const after = await Driver.findById(driver._id);
      expect(after!.rating).toBe(before!.rating);
    });

    it('un negocio ajeno al pedido no puede calificar', async () => {
      const order = await deliveredOrder();
      const otroOwner = await makeUser({ role: UserRole.BUSINESS });

      await expect(
        reviewService.rateDriverByBusiness(order._id.toString(), otroOwner._id.toString(), 3)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('no se puede calificar dos veces', async () => {
      const order = await deliveredOrder();
      await reviewService.rateDriverByBusiness(order._id.toString(), businessOwner._id.toString(), 4);

      await expect(
        reviewService.rateDriverByBusiness(order._id.toString(), businessOwner._id.toString(), 5)
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('reviewStatusForOrder', () => {
    it('el cliente ve pendiente calificar comercio y domiciliario antes de hacerlo', async () => {
      const order = await deliveredOrder();

      const status = await reviewService.reviewStatusForOrder(order._id.toString(), client._id.toString(), 'client');
      expect(status.customerCanRateBusiness).toBe(true);
      expect(status.customerCanRateDriver).toBe(true);
    });

    it('deja de estar pendiente después de calificar', async () => {
      const order = await deliveredOrder();
      await reviewService.create({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        businessId: business._id.toString(),
        driverId: driver._id.toString(),
        businessRating: 5,
        driverRating: 5,
      });

      const status = await reviewService.reviewStatusForOrder(order._id.toString(), client._id.toString(), 'client');
      expect(status.customerCanRateBusiness).toBe(false);
      expect(status.customerCanRateDriver).toBe(false);
    });

    it('un pedido no entregado no habilita ninguna calificación', async () => {
      const order = await orderService.create({
        clientId: client._id.toString(),
        businessId: business._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
        paymentMethod: PaymentMethod.ONLINE,
        deliveryAddress: 'Cra 1 #2-3',
        deliveryLongitude: GARZON.lng,
        deliveryLatitude: GARZON.lat,
      });

      const status = await reviewService.reviewStatusForOrder(order._id.toString(), client._id.toString(), 'client');
      expect(Object.values(status).every((v) => v === false)).toBe(true);
    });

    it('el domiciliario y el comercio ven sus propias banderas', async () => {
      const order = await deliveredOrder();

      const driverStatus = await reviewService.reviewStatusForOrder(order._id.toString(), driverUser._id.toString(), 'driver');
      expect(driverStatus.driverCanRateBusiness).toBe(true);
      expect(driverStatus.driverCanRateCustomer).toBe(true);

      const businessStatus = await reviewService.reviewStatusForOrder(order._id.toString(), businessOwner._id.toString(), 'business');
      expect(businessStatus.businessCanRateDriver).toBe(true);
    });
  });

  describe('seguridad: el target debe pertenecer al pedido', () => {
    it('rechaza calificar con un businessId que no es el del pedido', async () => {
      const order = await deliveredOrder();
      const otroOwner = await makeUser({ role: UserRole.BUSINESS });
      const otroBusiness = await makeBusiness(otroOwner._id, { lat: GARZON.lat, lng: GARZON.lng });

      await expect(
        reviewService.create({
          orderId: order._id.toString(),
          userId: client._id.toString(),
          businessId: otroBusiness._id.toString(),
          businessRating: 5,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rechaza calificar con un driverId que no es el del pedido', async () => {
      const order = await deliveredOrder();
      const otroDriverUser = await makeUser({ role: UserRole.DRIVER });
      const otroDriver = await makeDriver(otroDriverUser._id);

      await expect(
        reviewService.create({
          orderId: order._id.toString(),
          userId: client._id.toString(),
          businessId: business._id.toString(),
          driverId: otroDriver._id.toString(),
          businessRating: 5,
          driverRating: 5,
        })
      ).rejects.toMatchObject({ statusCode: 400 });

      // Y el pedido sigue sin reseña: el rechazo no dejó nada a medias.
      expect(await Review.findOne({ orderId: order._id })).toBeNull();
    });
  });
});
