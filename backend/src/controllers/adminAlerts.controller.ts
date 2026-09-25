import { Request, Response, NextFunction } from 'express';
import { sendResponse } from '../utils';
import { can } from '../middlewares/auth';
import { alertsService } from '../services/alerts.service';

export const adminAlertsController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const data = await alertsService.list({
        userId: String(req.user!._id),
        allows: (p) => can(req, p),
        limit,
      });
      sendResponse(res, 200, 'Alertas del equipo', data);
    } catch (e) { next(e); }
  },
  async markSeen(req: Request, res: Response, next: NextFunction) {
    try {
      await alertsService.markSeen(String(req.user!._id), req.body.keys, (p) => can(req, p));
      sendResponse(res, 200, 'Alertas marcadas como vistas', { ok: true });
    } catch (e) { next(e); }
  },
};
