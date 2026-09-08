import { describe, it, expect, beforeEach } from 'vitest';
import { Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { reviewService } from '../services/review.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON,
} from './factories';

/**
 * Pulgares por plato.
 *
 * Cinco estrellas por producto son demasiada fricción justo después de
 * comer: la gente abandona la pantalla y no se obtiene nada. Un gesto
 * binario se responde sin pensar y basta para ordenar una carta, que es
 * para lo único que se va a usar.
 */
describe('Opinión por producto', () => {
  let business: any;
  let bueno: any;
  let malo: any;

  const rateOrder = async (
    feedback: Array<{ product: any; liked: boolean }>,
    businessRating = 4
  ) => {
    const client = await makeUser({ role: UserRole.CLIENT });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: feedback.map((f) => ({ productId: f.product._id.toString(), quantity: 1 })),
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    await Order.updateOne(
      { _id: order._id },
      { status: OrderStatus.DELIVERED, deliveredAt: new Date() }
    );

    return reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating,
      productFeedback: feedback.map((f) => ({
        productId: f.product._id.toString(),
        liked: f.liked,
      })),
    });
  };

  beforeEach(async () => {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    bueno = await makeProduct(business._id, { name: 'Bandeja paisa' });
    malo = await makeProduct(business._id, { name: 'Ensalada triste' });
  });

  it('cuenta los pulgares arriba y el total por plato', async () => {
    await rateOrder([{ product: bueno, liked: true }]);
    await rateOrder([{ product: bueno, liked: true }]);
    await rateOrder([{ product: bueno, liked: false }]);

    const sentiment = await reviewService.productSentiment(business._id.toString());

    expect(sentiment[bueno._id.toString()]).toEqual({ likes: 2, total: 3 });
  });

  it('separa los platos: un mal plato no arrastra al bueno', async () => {
    await rateOrder([
      { product: bueno, liked: true },
      { product: malo, liked: false },
    ]);

    const sentiment = await reviewService.productSentiment(business._id.toString());

    expect(sentiment[bueno._id.toString()]).toEqual({ likes: 1, total: 1 });
    expect(sentiment[malo._id.toString()]).toEqual({ likes: 0, total: 1 });
  });

  it('devuelve el recuento crudo, no un porcentaje ya masticado', async () => {
    // "100% con un voto" y "92% con cincuenta" son el mismo porcentaje y no
    // significan lo mismo: quien pinta la carta necesita el total.
    await rateOrder([{ product: bueno, liked: true }]);

    const sentiment = await reviewService.productSentiment(business._id.toString());
    expect(sentiment[bueno._id.toString()].total).toBe(1);
  });

  it('un plato sin opiniones simplemente no aparece', async () => {
    await rateOrder([{ product: bueno, liked: true }]);

    const sentiment = await reviewService.productSentiment(business._id.toString());
    expect(sentiment[malo._id.toString()]).toBeUndefined();
  });

  it('una reseña oculta deja de contar también aquí', async () => {
    const admin = await makeUser({ role: UserRole.ADMIN });
    const review = await rateOrder([{ product: bueno, liked: false }]);
    await rateOrder([{ product: bueno, liked: true }]);

    await reviewService.setHidden(review._id.toString(), admin._id.toString(), true, 'Falsa');

    const sentiment = await reviewService.productSentiment(business._id.toString());
    expect(sentiment[bueno._id.toString()]).toEqual({ likes: 1, total: 1 });
  });

  it('calificar sin opinar de los platos sigue funcionando', async () => {
    // La opinión por plato es opcional: exigirla convertiría una pantalla
    // de dos toques en un formulario.
    const client = await makeUser({ role: UserRole.CLIENT });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: bueno._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });
    await Order.updateOne(
      { _id: order._id },
      { status: OrderStatus.DELIVERED, deliveredAt: new Date() }
    );

    const review = await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating: 5,
    });

    expect(review.businessRating).toBe(5);
    expect(await reviewService.productSentiment(business._id.toString())).toEqual({});
  });
});
