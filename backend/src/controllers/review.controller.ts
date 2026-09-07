import { Request, Response, NextFunction } from 'express';
import { reviewService } from '../services/review.service';
import { sendResponse, param, query } from '../utils';

export class ReviewController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const review = await reviewService.create({
        ...req.body,
        userId: req.user!._id.toString(),
      });
      sendResponse(res, 201, 'Calificación enviada exitosamente', review);
    } catch (error) { next(error); }
  }

  async getByBusiness(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await reviewService.getByBusiness(
        param(req, 'businessId'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Reseñas obtenidas', result.reviews, result.meta);
    } catch (error) { next(error); }
  }

  async getByDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await reviewService.getByDriver(
        param(req, 'driverId'),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Calificaciones del domiciliario obtenidas', result.reviews, result.meta);
    } catch (error) { next(error); }
  }

  async getByOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const review = await reviewService.getByOrder(param(req, 'orderId'));
      sendResponse(res, 200, 'Reseña del pedido obtenida', review);
    } catch (error) { next(error); }
  }
}

export const reviewController = new ReviewController();
