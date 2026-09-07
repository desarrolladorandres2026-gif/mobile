import { Review, Order, Business, Driver } from '../models';
import { AppError } from '../middlewares';
import { OrderStatus } from '../types';

interface CreateReviewInput {
  orderId: string;
  userId: string;
  businessId: string;
  driverId?: string;
  businessRating: number;
  driverRating?: number;
  comment?: string;
}

export class ReviewService {
  async create(input: CreateReviewInput) {
    // Validate order exists and belongs to user
    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);
    if (order.clientId.toString() !== input.userId) throw new AppError('No autorizado para calificar este pedido', 403);
    if (order.status !== OrderStatus.DELIVERED) throw new AppError('Solo puedes calificar pedidos entregados', 400);

    const existing = await Review.findOne({ orderId: input.orderId });
    if (existing) throw new AppError('Ya calificaste este pedido', 409);

    const review = await Review.create({
      orderId: input.orderId,
      userId: input.userId,
      businessId: input.businessId,
      driverId: input.driverId || null,
      businessRating: input.businessRating,
      driverRating: input.driverRating || null,
      comment: input.comment || '',
    });

    // Update business average rating
    const businessStats = await Review.aggregate([
      { $match: { businessId: review.businessId } },
      { $group: { _id: null, avgRating: { $avg: '$businessRating' }, count: { $sum: 1 } } },
    ]);

    if (businessStats.length > 0) {
      await Business.findByIdAndUpdate(input.businessId, {
        rating: Math.round(businessStats[0].avgRating * 10) / 10,
        totalReviews: businessStats[0].count,
      });
    }

    // Update driver average rating
    if (input.driverId && input.driverRating) {
      const driverStats = await Review.aggregate([
        { $match: { driverId: review.driverId, driverRating: { $ne: null } } },
        { $group: { _id: null, avgRating: { $avg: '$driverRating' }, count: { $sum: 1 } } },
      ]);

      if (driverStats.length > 0) {
        await Driver.findByIdAndUpdate(input.driverId, {
          rating: Math.round(driverStats[0].avgRating * 10) / 10,
        });
      }
    }

    return review;
  }

  async getByBusiness(businessId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      Review.find({ businessId })
        .skip(skip).limit(limit)
        .sort({ createdAt: -1 })
        .populate('userId', 'name avatar'),
      Review.countDocuments({ businessId }),
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

  async getByOrder(orderId: string) {
    return Review.findOne({ orderId })
      .populate('userId', 'name avatar');
  }
}

export const reviewService = new ReviewService();
