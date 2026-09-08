import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business, Review } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { reviewService } from '../services/review.service';
import { orderService } from '../services/order.service';
import {
  makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, GARZON,
} from './factories';

/**
 * La otra mitad de las reseñas.
 *
 * Hasta aquí solo existía una dirección: el cliente calificaba y nadie
 * podía contestar. Una mala reseña era una sentencia, un cliente que da
 * direcciones falsas no dejaba rastro en ninguna parte, y una reseña
 * inventada se quedaba contando en la media para siempre.
 */
describe('Respuestas, calificación al cliente y moderación', () => {
  let client: any;
  let owner: any;
  let business: any;
  let product: any;
  let driverUser: any;
  let driver: any;
  let admin: any;

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

  const ratedOrder = async (businessRating = 5) => {
    const order = await deliveredOrder();
    const review = await reviewService.create({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      businessId: business._id.toString(),
      businessRating,
      comment: 'Todo bien',
    });
    return { order, review };
  };

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
    admin = await makeUser({ role: UserRole.ADMIN });
  });

  // ── Respuesta del negocio ──

  it('el negocio puede contestar a una reseña suya', async () => {
    const { review } = await ratedOrder();

    const replied = await reviewService.replyAsBusiness(
      review._id.toString(),
      owner._id.toString(),
      'Gracias por escribirnos, lo tendremos en cuenta.'
    );

    expect(replied.businessReply).toContain('Gracias');
    expect(replied.businessRepliedAt).toBeInstanceOf(Date);
  });

  it('un negocio no puede contestar a la reseña de otro', async () => {
    const { review } = await ratedOrder();
    const intruso = await makeUser({ role: UserRole.BUSINESS });

    await expect(
      reviewService.replyAsBusiness(review._id.toString(), intruso._id.toString(), 'Hola')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('no se puede responder dos veces', async () => {
    const { review } = await ratedOrder();
    await reviewService.replyAsBusiness(review._id.toString(), owner._id.toString(), 'Primera');

    // Poder editarla indefinidamente convierte la respuesta en algo que se
    // cambia después de que el cliente ya la leyó.
    await expect(
      reviewService.replyAsBusiness(review._id.toString(), owner._id.toString(), 'Segunda')
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── Calificación al cliente ──

  it('el negocio califica al cliente y no sale a ninguna parte pública', async () => {
    const { order } = await ratedOrder();

    const review = await reviewService.rateClient(
      order._id.toString(),
      'business',
      owner._id.toString(),
      2,
      'Dirección incompleta'
    );

    expect(review!.clientRatingByBusiness).toBe(2);
    expect(review!.clientNotes).toBe('Dirección incompleta');

    // La nota del negocio no cambia por lo que el negocio piense del cliente.
    const saved = await Business.findById(business._id);
    expect(saved!.rating).toBe(5);
  });

  it('el domiciliario también puede calificar al cliente', async () => {
    const { order } = await ratedOrder();

    const review = await reviewService.rateClient(
      order._id.toString(),
      'driver',
      driverUser._id.toString(),
      1,
      'La dirección no existe'
    );

    expect(review!.clientRatingByDriver).toBe(1);
  });

  it('calificar al cliente funciona aunque el cliente no haya calificado', async () => {
    // Son dos actos independientes: ninguno debería esperar al otro.
    const order = await deliveredOrder();

    const review = await reviewService.rateClient(
      order._id.toString(),
      'business',
      owner._id.toString(),
      3
    );

    expect(review!.clientRatingByBusiness).toBe(3);
    expect(review!.businessRating).toBeFalsy();
  });

  it('una reseña sin nota del cliente no cuenta como un cero en la media', async () => {
    const order = await deliveredOrder();
    await reviewService.rateClient(order._id.toString(), 'business', owner._id.toString(), 3);

    await reviewService.recalculateBusinessRating(business._id.toString());

    const saved = await Business.findById(business._id);
    expect(saved!.totalReviews).toBe(0);
    expect(saved!.rating).toBe(0);
  });

  it('un domiciliario ajeno al pedido no puede calificar a su cliente', async () => {
    const { order } = await ratedOrder();
    const otroUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(otroUser._id);

    await expect(
      reviewService.rateClient(order._id.toString(), 'driver', otroUser._id.toString(), 1)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  // ── Moderación ──

  it('ocultar una reseña la saca de la media', async () => {
    await ratedOrder(5);
    const { review } = await ratedOrder(1);

    let saved = await Business.findById(business._id);
    expect(saved!.rating).toBe(3);

    await reviewService.setHidden(review._id.toString(), admin._id.toString(), true, 'Falsa');

    // Si la nota no se recalcula, moderar es puramente cosmético.
    saved = await Business.findById(business._id);
    expect(saved!.rating).toBe(5);
    expect(saved!.totalReviews).toBe(1);
  });

  it('restaurar una reseña la devuelve a la media', async () => {
    await ratedOrder(5);
    const { review } = await ratedOrder(1);

    await reviewService.setHidden(review._id.toString(), admin._id.toString(), true, 'Falsa');
    await reviewService.setHidden(review._id.toString(), admin._id.toString(), false);

    const saved = await Business.findById(business._id);
    expect(saved!.rating).toBe(3);
  });

  it('una reseña oculta no aparece en el listado público del negocio', async () => {
    const { review } = await ratedOrder(1);
    await reviewService.setHidden(review._id.toString(), admin._id.toString(), true, 'Ofensiva');

    const listado = await reviewService.getByBusiness(business._id.toString());
    expect(listado.reviews).toHaveLength(0);
  });

  it('ocultar deja constancia de quién y por qué', async () => {
    const { review } = await ratedOrder();

    const hidden = await reviewService.setHidden(
      review._id.toString(),
      admin._id.toString(),
      true,
      'Contenido ofensivo'
    );

    expect(hidden.hiddenBy!.toString()).toBe(admin._id.toString());
    expect(hidden.hiddenReason).toBe('Contenido ofensivo');
    expect(hidden.hiddenAt).toBeInstanceOf(Date);
  });

  it('la cola de moderación trae las reseñas con su negocio y su autor', async () => {
    await ratedOrder();

    const queue = await reviewService.moderationQueue();
    expect(queue.length).toBeGreaterThan(0);
    expect((queue[0] as any).businessId.name).toBe(business.name);
    expect((queue[0] as any).userId.name).toBeDefined();
  });

  it('moderar algo que no existe da 404, no un fallo silencioso', async () => {
    await expect(
      reviewService.setHidden('507f1f77bcf86cd799439011', admin._id.toString(), true)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
