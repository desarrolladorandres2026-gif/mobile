import { describe, it, expect, beforeEach } from 'vitest';
import { Order } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { reviewService } from '../services/review.service';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, GARZON } from './factories';

/**
 * El listado de reseñas del panel: paginado y con los números de TODAS las
 * reseñas, no de las veinte que cupieron en la página. Antes el promedio y
 * el conteo «sin responder» salían de la primera página.
 */
describe('Reseñas del negocio: paginación, filtros y cifras', () => {
  let client: any;
  let owner: any;
  let business: any;
  let product: any;
  let driver: any;

  const rated = async (businessRating: number, reply?: string) => {
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
    const review = await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating,
      comment: 'Comentario',
    });
    if (reply) await reviewService.replyAsBusiness(review._id.toString(), owner._id.toString(), reply);
    return review;
  };

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
    driver = await makeDriver((await makeUser({ role: UserRole.DRIVER }))._id);
  });

  it('las cifras cuentan todas las reseñas aunque la página traiga pocas', async () => {
    await rated(5, 'Gracias');
    await rated(5);
    await rated(3);
    await rated(1);

    const page = await reviewService.getByBusiness(business._id.toString(), 1, 2);

    expect(page.reviews).toHaveLength(2);
    expect(page.meta.total).toBe(4);
    expect(page.meta.totalPages).toBe(2);
    expect(page.meta.stats).toEqual({
      rated: 4,
      average: 3.5,
      unanswered: 3,
      byRating: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 2 },
    });
  });

  it('filtra por nota y por sin responder, y el total sigue al filtro', async () => {
    await rated(5, 'Gracias');
    await rated(5);
    await rated(2);

    const fives = await reviewService.getByBusiness(business._id.toString(), 1, 20, { rating: 5 });
    expect(fives.reviews).toHaveLength(2);
    expect(fives.meta.total).toBe(2);

    const pending = await reviewService.getByBusiness(business._id.toString(), 1, 20, { unanswered: true });
    expect(pending.reviews).toHaveLength(2);
    expect(pending.reviews.every((review: any) => !review.businessReply)).toBe(true);

    // Las cifras no se mueven con el filtro.
    expect(pending.meta.stats.rated).toBe(3);
  });

  it('un negocio sin reseñas devuelve ceros', async () => {
    const page = await reviewService.getByBusiness(business._id.toString());
    expect(page.reviews).toEqual([]);
    expect(page.meta.stats).toEqual({
      rated: 0,
      average: 0,
      unanswered: 0,
      byRating: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
  });

  it('una reseña oculta no cuenta en las cifras', async () => {
    const review = await rated(1);
    await rated(5);
    await (await import('../models')).Review.updateOne({ _id: review._id }, { isHidden: true });

    const page = await reviewService.getByBusiness(business._id.toString());
    expect(page.meta.stats.rated).toBe(1);
    expect(page.meta.stats.average).toBe(5);
  });
});
