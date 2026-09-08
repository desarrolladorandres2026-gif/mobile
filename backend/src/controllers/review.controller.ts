import { Request, Response, NextFunction } from 'express';
import { reviewService } from '../services/review.service';
import { sendResponse, param, query } from '../utils';
import { UserRole } from '../types';
import { AuditAction, logAudit } from '../security';

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

  /** Lo que el cliente tiene pendiente de calificar. */
  async pending(req: Request, res: Response, next: NextFunction) {
    try {
      const pending = await reviewService.pendingForUser(req.user!._id.toString());
      sendResponse(res, 200, 'Pedidos por calificar', pending);
    } catch (error) { next(error); }
  }

  /** El negocio responde públicamente a una reseña suya. */
  async reply(req: Request, res: Response, next: NextFunction) {
    try {
      const review = await reviewService.replyAsBusiness(
        param(req, 'id'),
        req.user!._id.toString(),
        req.body.reply
      );
      sendResponse(res, 200, 'Respuesta publicada', review);
    } catch (error) { next(error); }
  }

  /** El negocio o el domiciliario califican al cliente. No es público. */
  async rateClient(req: Request, res: Response, next: NextFunction) {
    try {
      const by = req.user!.role === UserRole.BUSINESS ? 'business' : 'driver';
      const review = await reviewService.rateClient(
        param(req, 'orderId'),
        by,
        req.user!._id.toString(),
        req.body.rating,
        req.body.notes
      );
      sendResponse(res, 200, 'Calificación registrada', review);
    } catch (error) { next(error); }
  }

  /** Cola de moderación para el panel de administración. */
  async moderationQueue(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Reseñas', await reviewService.moderationQueue());
    } catch (error) { next(error); }
  }

  async moderate(req: Request, res: Response, next: NextFunction) {
    try {
      const review = await reviewService.setHidden(
        param(req, 'id'),
        req.user!._id.toString(),
        req.body.hidden,
        req.body.reason
      );
      void logAudit(req, {
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'review',
        entityId: review._id.toString(),
        description: req.body.hidden
          ? 'Reseña ocultada por moderación'
          : 'Reseña restaurada',
        metadata: { reason: req.body.reason },
      });
      sendResponse(res, 200, req.body.hidden ? 'Reseña ocultada' : 'Reseña restaurada', review);
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
