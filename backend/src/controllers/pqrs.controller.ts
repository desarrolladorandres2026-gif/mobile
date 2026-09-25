import { Request, Response, NextFunction } from 'express';
import { Pqrs } from '../models'; import { AppError } from '../middlewares'; import { sendResponse, param } from '../utils'; import { AuditAction, logAudit } from '../security'; import { createPqrs } from '../services/pqrs.service'; import { supportService } from '../services/support.service';
/** Lo que ve quien abrió el caso: sin ids del personal, prioridad ni SLA internos. */
const OWN_FIELDS = '-assignedTo -assignedAt -priority -dueAt -responses.userId';
export class PqrsController {
  async create(req: Request, res: Response, next: NextFunction) { try { const item = await createPqrs({ userId: req.user!._id.toString(), type: req.body.type, subject: req.body.subject, detail: req.body.detail, orderId: req.body.orderId, businessId: req.body.businessId, role: req.user!.role }); sendResponse(res, 201, 'PQRS recibida', await Pqrs.findById(item._id).select(OWN_FIELDS).lean()); } catch (e) { next(e); } }
  async mine(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'PQRS', await Pqrs.find({ userId: req.user!._id }).select(OWN_FIELDS).sort({ createdAt: -1 }).lean()); } catch (e) { next(e); } }
  async addEvidence(req: Request, res: Response, next: NextFunction) { try { const item = await Pqrs.findOneAndUpdate({ _id: param(req, 'id'), userId: req.user!._id, status: { $nin: ['closed'] } }, { $push: { evidence: { url: req.body.url, name: req.body.name } } }, { new: true, runValidators: true }); if (!item) throw new AppError('PQRS no encontrada o cerrada', 404); sendResponse(res, 201, 'Evidencia registrada', item); } catch (e) { next(e); } }
  async list(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'PQRS', await Pqrs.find().populate('userId', 'name email phone').sort({ createdAt: -1 })); } catch (e) { next(e); } }
  /**
   * Responde una PQRS. Es la misma ruta que usaba la pantalla Legal, y ahora
   * deja la misma traza que la bandeja de soporte (`supportService.reply`):
   * sella `firstResponseAt`, asigna el caso a quien responde si no tenía
   * asignado, y notifica al cliente por socket y push. Antes esta ruta
   * escribía directo sobre `Pqrs` y las dos vías dejaban estados distintos
   * (una asignaba y sellaba `firstResponseAt`, la otra no).
   */
  async respond(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      const existing = await Pqrs.findById(id).select('assignedTo status');
      if (!existing) throw new AppError('PQRS no encontrada', 404);

      if (!existing.assignedTo) await supportService.assign(id, req.user!._id.toString());

      let item = await supportService.reply(id, req.user!._id.toString(), req.body.message);

      const targetStatus = req.body.status || 'answered';
      if (targetStatus === 'closed') {
        item = await supportService.close(id, req.user!._id.toString());
      } else if (targetStatus !== item.status) {
        item = await Pqrs.findByIdAndUpdate(id, { $set: { status: targetStatus } }, { new: true, runValidators: true }) as typeof item;
      }

      void logAudit(req, { action: AuditAction.PQRS_ANSWERED, entity: 'pqrs', entityId: id, description: 'PQRS respondida', metadata: { status: item.status } });
      sendResponse(res, 200, 'Respuesta registrada', item);
    } catch (e) { next(e); }
  }
}
export const pqrsController = new PqrsController();
