import { Types } from 'mongoose';
import { Review, Order, Business, Driver } from '../models';
import { AppError } from '../middlewares';
import {
  OrderStatus,
  ReviewReasonClientToBusiness, ReviewReasonClientToDriver,
  ReviewReasonDriverToBusiness, ReviewReasonBusinessToDriver,
} from '../types';
import { recalculateBusinessReputation, recalculateDriverReputation } from './reputation.service';

interface CreateReviewInput {
  orderId: string;
  userId: string;
  businessId: string;
  driverId?: string;
  businessRating: number;
  businessRatingReasons?: ReviewReasonClientToBusiness[];
  driverRating?: number;
  driverRatingReasons?: ReviewReasonClientToDriver[];
  comment?: string;
  productFeedback?: Array<{ productId: string; liked: boolean }>;
}

export class ReviewService {
  async create(input: CreateReviewInput) {
    // Validate order exists and belongs to user
    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.clientId.toString() !== input.userId) throw new AppError('No autorizado para calificar este pedido', 403);
    if (order.status !== OrderStatus.DELIVERED) throw new AppError('Solo puedes calificar pedidos entregados', 400);

    // El frontend manda businessId/driverId, pero nunca son la fuente de
    // verdad: el pedido lo es. Sin esto, un cliente podría calificar (o
    // hundir) un negocio o domiciliario que nunca participó en su pedido.
    if (!order.businessId || order.businessId.toString() !== input.businessId) {
      throw new AppError('El comercio no corresponde a este pedido', 400);
    }
    if (input.driverId && order.driverId?.toString() !== input.driverId) {
      throw new AppError('El domiciliario no corresponde a este pedido', 400);
    }
    if (input.driverRating && !input.driverId) {
      throw new AppError('Falta el domiciliario a calificar', 400);
    }

    const existing = await Review.findOne({ orderId: input.orderId });
    if (existing) throw new AppError('Ya calificaste este pedido', 409);

    const review = await Review.create({
      orderId: input.orderId,
      userId: input.userId,
      businessId: input.businessId,
      driverId: input.driverId || null,
      businessRating: input.businessRating,
      businessRatingReasons: input.businessRatingReasons?.length ? input.businessRatingReasons : undefined,
      driverRating: input.driverRating || null,
      driverRatingReasons: input.driverRatingReasons?.length ? input.driverRatingReasons : undefined,
      comment: input.comment || '',
      productFeedback: input.productFeedback?.length ? input.productFeedback : undefined,
    });

    await this.recalculateBusinessRating(input.businessId);
    if (input.driverId && input.driverRating) {
      await this.recalculateDriverRating(input.driverId);
    }

    return review;
  }

  /**
   * Pedidos entregados que el cliente todavía no ha calificado.
   *
   * Existe para poder pedirlo sin molestar: la app enseña la calificación
   * de lo que falta, y no vuelve a preguntar por lo ya respondido. Sin esta
   * consulta habría que preguntar pedido por pedido si tiene reseña, que
   * son tantas peticiones como pedidos en el historial.
   *
   * Se limita a los últimos días porque calificar algo de hace un mes no
   * aporta información fiable —nadie recuerda— y sí ensucia la media.
   */
  async pendingForUser(userId: string, withinDays = 7) {
    const since = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);

    const delivered = await Order.find({
      clientId: userId,
      status: OrderStatus.DELIVERED,
      deliveredAt: { $gte: since },
    })
      // Los platos viajan con el pedido porque la pantalla de calificación
      // pregunta por cada uno: pedirlos aparte sería una consulta más por
      // cada pedido pendiente.
      .select('_id orderNumber businessId driverId deliveredAt items')
      .sort({ deliveredAt: -1 })
      .limit(20)
      .populate('businessId', 'name')
      .lean();

    if (!delivered.length) return [];

    const rated = await Review.find({
      orderId: { $in: delivered.map((o) => o._id) },
    }).distinct('orderId');

    const ratedSet = new Set(rated.map(String));
    return delivered.filter((order) => !ratedSet.has(order._id.toString()));
  }

  /**
   * Cuántos pulgares arriba y abajo lleva cada plato de un negocio.
   *
   * Se devuelve el recuento crudo y no un porcentaje ya calculado porque
   * quien pinta la carta necesita saber si el dato se sostiene: "100% con
   * un voto" y "92% con cincuenta" son el mismo porcentaje y no significan
   * lo mismo.
   */
  async productSentiment(businessId: string) {
    const rows = await Review.aggregate([
      { $match: { businessId: new Types.ObjectId(businessId), isHidden: { $ne: true } } },
      { $unwind: '$productFeedback' },
      {
        $group: {
          _id: '$productFeedback.productId',
          likes: { $sum: { $cond: ['$productFeedback.liked', 1, 0] } },
          total: { $sum: 1 },
        },
      },
    ]);

    const map: Record<string, { likes: number; total: number }> = {};
    for (const row of rows) {
      map[row._id.toString()] = { likes: row.likes, total: row.total };
    }
    return map;
  }

  async getByBusiness(businessId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      Review.find({ businessId, isHidden: { $ne: true }, businessRating: { $ne: null } })
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('userId', 'name avatar'),
      Review.countDocuments({ businessId, isHidden: { $ne: true }, businessRating: { $ne: null } }),
    ]);
    return { reviews, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getByDriver(driverId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      Review.find({ driverId, driverRating: { $ne: null } })
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('userId', 'name avatar'),
      Review.countDocuments({ driverId, driverRating: { $ne: null } }),
    ]);
    return { reviews, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Recalcula la media de un negocio desde cero.
   *
   * Hace falta cada vez que una reseña cambia de visibilidad: ocultar una de
   * una estrella tiene que subir la nota, y dejarla contando haría que la
   * moderación fuera puramente cosmética.
   */
  async recalculateBusinessRating(businessId: string): Promise<void> {
    const stats = await Review.aggregate([
      // Solo lo que el cliente puntuó de verdad: una reseña abierta por
      // el negocio para calificar al cliente no tiene nota y no puede
      // contar como una valoración de cero.
      { $match: { businessId: new Types.ObjectId(businessId), isHidden: { $ne: true }, businessRating: { $ne: null } } },
      { $group: { _id: null, avgRating: { $avg: '$businessRating' }, count: { $sum: 1 } } },
    ]);

    await Business.findByIdAndUpdate(businessId, {
      rating: stats.length ? Math.round(stats[0].avgRating * 10) / 10 : 0,
      totalReviews: stats.length ? stats[0].count : 0,
    });

    // El score interno se recalcula junto al público: son la misma fuente
    // de datos y mantenerlos separados en el tiempo abriría una ventana en
    // la que uno cambió y el otro todavía no.
    await recalculateBusinessReputation(businessId);
  }

  /** Igual que `recalculateBusinessRating`, para la nota pública del domiciliario. */
  async recalculateDriverRating(driverId: string): Promise<void> {
    const stats = await Review.aggregate([
      { $match: { driverId: new Types.ObjectId(driverId), isHidden: { $ne: true }, driverRating: { $ne: null } } },
      { $group: { _id: null, avgRating: { $avg: '$driverRating' }, count: { $sum: 1 } } },
    ]);

    await Driver.findByIdAndUpdate(driverId, {
      rating: stats.length ? Math.round(stats[0].avgRating * 10) / 10 : 5,
      totalReviews: stats.length ? stats[0].count : 0,
    });

    await recalculateDriverReputation(driverId);
  }

  /**
   * El negocio contesta públicamente a una reseña.
   *
   * Solo el dueño del negocio reseñado, y solo una vez: permitir editarla
   * indefinidamente convierte la respuesta en algo que se puede cambiar
   * después de que el cliente la haya leído.
   */
  async replyAsBusiness(reviewId: string, ownerId: string, reply: string) {
    const review = await Review.findById(reviewId);
    if (!review) throw new AppError('Reseña no encontrada', 404);

    const { businessStaffService } = await import('./businessStaff.service');
    const { BusinessPermission } = await import('../models');
    await businessStaffService.assertCan(
      ownerId,
      review.businessId.toString(),
      BusinessPermission.REVIEWS_RESPOND,
      'Sin permisos para responder reseñas.'
    );

    if (review.businessReply) {
      throw new AppError('Ya respondiste a esta reseña', 409);
    }

    review.businessReply = reply;
    review.businessRepliedAt = new Date();
    await review.save();
    return review;
  }

  /**
   * El negocio o el domiciliario califican al cliente.
   *
   * No sale a ninguna parte pública: alimenta el perfil de riesgo. Un
   * cliente que da direcciones falsas o insulta por el chat hoy no deja
   * rastro en ningún sitio, y el siguiente domiciliario lo descubre solo.
   */
  async rateClient(
    orderId: string,
    by: 'business' | 'driver',
    actorId: string,
    rating: number,
    notes?: string,
    reasons?: string[]
  ) {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.status !== OrderStatus.DELIVERED) {
      throw new AppError('Solo puedes calificar pedidos entregados', 400);
    }

    if (by === 'business') {
      const business = await Business.findById(order.businessId).select('ownerId');
      if (!business || business.ownerId.toString() !== actorId) {
        throw new AppError('No autorizado para calificar este pedido', 403);
      }
    } else {
      const driver = await Driver.findOne({ userId: actorId }).select('_id');
      if (!driver || order.driverId?.toString() !== driver._id.toString()) {
        throw new AppError('No autorizado para calificar este pedido', 403);
      }
    }

    const field = by === 'business' ? 'clientRatingByBusiness' : 'clientRatingByDriver';
    const reasonsField = by === 'business' ? 'clientRatingByBusinessReasons' : 'clientRatingByDriverReasons';
    const existing = await Review.findOne({ orderId }).select(field);
    if (existing && existing.get(field) != null) {
      throw new AppError('Ya calificaste al cliente de este pedido', 409);
    }

    // Se usa upsert porque la calificación al cliente puede llegar antes que
    // la del cliente al negocio: son dos actos independientes y ninguno
    // debería tener que esperar al otro.
    return Review.findOneAndUpdate(
      { orderId },
      {
        $set: {
          [field]: rating,
          ...(reasons?.length ? { [reasonsField]: reasons } : {}),
          ...(notes ? { clientNotes: notes } : {}),
        },
        $setOnInsert: {
          orderId,
          userId: order.clientId,
          businessId: order.businessId,
          driverId: order.driverId ?? null,
          // Sin nota del cliente todavía: se marca como no puntuada para que
          // no entre en la media del negocio.
          businessRating: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: false }
    );
  }

  /**
   * El domiciliario califica al comercio: qué tan lista estaba la orden al
   * recogerla. Operacional — no toca `Business.rating` público, solo el
   * `reputationScore` interno.
   */
  async rateBusinessByDriver(orderId: string, actorUserId: string, rating: number, reasons?: ReviewReasonDriverToBusiness[]) {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.status !== OrderStatus.DELIVERED) {
      throw new AppError('Solo puedes calificar pedidos entregados', 400);
    }

    const driver = await Driver.findOne({ userId: actorUserId }).select('_id');
    if (!driver || order.driverId?.toString() !== driver._id.toString()) {
      throw new AppError('No autorizado para calificar este pedido', 403);
    }
    if (!order.businessId) throw new AppError('Este pedido no tiene comercio que calificar', 400);

    const existing = await Review.findOne({ orderId }).select('driverRatingOfBusiness');
    if (existing?.driverRatingOfBusiness != null) {
      throw new AppError('Ya calificaste al comercio de este pedido', 409);
    }

    const review = await Review.findOneAndUpdate(
      { orderId },
      {
        $set: {
          driverRatingOfBusiness: rating,
          ...(reasons?.length ? { driverRatingOfBusinessReasons: reasons } : {}),
        },
        $setOnInsert: {
          orderId,
          userId: order.clientId,
          businessId: order.businessId,
          driverId: order.driverId ?? null,
          businessRating: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: false }
    );

    await recalculateBusinessReputation(order.businessId.toString());
    return review;
  }

  /**
   * El comercio califica al domiciliario: qué tal se portó al recoger.
   * Operacional — no toca `Driver.rating` público, solo el `reputationScore`
   * interno.
   */
  async rateDriverByBusiness(orderId: string, actorUserId: string, rating: number, reasons?: ReviewReasonBusinessToDriver[]) {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.status !== OrderStatus.DELIVERED) {
      throw new AppError('Solo puedes calificar pedidos entregados', 400);
    }
    if (!order.businessId) throw new AppError('Este pedido no tiene comercio', 400);

    const business = await Business.findById(order.businessId).select('ownerId');
    if (!business || business.ownerId.toString() !== actorUserId) {
      throw new AppError('No autorizado para calificar este pedido', 403);
    }
    if (!order.driverId) throw new AppError('Este pedido no tiene domiciliario que calificar', 400);

    const existing = await Review.findOne({ orderId }).select('businessRatingOfDriver');
    if (existing?.businessRatingOfDriver != null) {
      throw new AppError('Ya calificaste al domiciliario de este pedido', 409);
    }

    const review = await Review.findOneAndUpdate(
      { orderId },
      {
        $set: {
          businessRatingOfDriver: rating,
          ...(reasons?.length ? { businessRatingOfDriverReasons: reasons } : {}),
        },
        $setOnInsert: {
          orderId,
          userId: order.clientId,
          businessId: order.businessId,
          driverId: order.driverId,
          businessRating: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: false }
    );

    await recalculateDriverReputation(order.driverId.toString());
    return review;
  }

  /**
   * Qué le falta calificar a cada actor de un pedido entregado.
   *
   * El frontend no debería adivinar qué botones mostrar comprobando campos
   * sueltos: aquí se decide una sola vez, con las mismas reglas que
   * `create`/`rateClient`/`rateBusinessByDriver`/`rateDriverByBusiness`
   * usan para aceptar o rechazar la calificación.
   */
  async reviewStatusForOrder(orderId: string, actorUserId: string, role: 'client' | 'driver' | 'business') {
    const order = await Order.findById(orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    const deliverable = order.status === OrderStatus.DELIVERED;
    const review = await Review.findOne({ orderId }).lean();

    const status = {
      customerCanRateBusiness: false,
      customerCanRateDriver: false,
      driverCanRateBusiness: false,
      driverCanRateCustomer: false,
      businessCanRateDriver: false,
    };

    if (!deliverable) return status;

    if (role === 'client' && order.clientId.toString() === actorUserId) {
      status.customerCanRateBusiness = review?.businessRating == null;
      status.customerCanRateDriver = !!order.driverId && review?.driverRating == null;
    }

    if (role === 'driver') {
      const driver = await Driver.findOne({ userId: actorUserId }).select('_id');
      if (driver && order.driverId?.toString() === driver._id.toString()) {
        status.driverCanRateBusiness = !!order.businessId && review?.driverRatingOfBusiness == null;
        status.driverCanRateCustomer = review?.clientRatingByDriver == null;
      }
    }

    if (role === 'business' && order.businessId) {
      const business = await Business.findById(order.businessId).select('ownerId');
      if (business && business.ownerId.toString() === actorUserId) {
        status.businessCanRateDriver = !!order.driverId && review?.businessRatingOfDriver == null;
      }
    }

    return status;
  }

  /** Oculta o restaura una reseña, y recalcula lo que dependía de ella. */
  async setHidden(reviewId: string, adminId: string, hidden: boolean, reason?: string) {
    const review = await Review.findByIdAndUpdate(
      reviewId,
      hidden
        ? { isHidden: true, hiddenReason: reason, hiddenBy: adminId, hiddenAt: new Date() }
        : { isHidden: false, hiddenReason: null, hiddenBy: null, hiddenAt: null },
      { new: true }
    );

    if (!review) throw new AppError('Reseña no encontrada', 404);

    await this.recalculateBusinessRating(review.businessId.toString());
    if (review.driverId && review.driverRating != null) {
      await this.recalculateDriverRating(review.driverId.toString());
    }
    return review;
  }

  /** Las reseñas más recientes, para que un admin pueda moderarlas. */
  async moderationQueue(limit = 50) {
    return Review.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'name')
      .populate('businessId', 'name')
      .lean();
  }

  async getByOrder(orderId: string) {
    return Review.findOne({ orderId })
      .populate('userId', 'name avatar');
  }
}

export const reviewService = new ReviewService();
