import { Request, Response, NextFunction } from 'express';
import { sendResponse, param } from '../utils';
import { internalNoteService } from '../services/internalNote.service';

export const adminNotesController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as Record<string, any>;
      const actor = await internalNoteService.noteActorFromRequest(req);
      const data = await internalNoteService.listFor({
        entityType: q.entityType, entityId: q.entityId, before: q.before, limit: q.limit, actor,
      });
      sendResponse(res, 200, 'Notas obtenidas', data);
    } catch (e) { next(e); }
  },
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await internalNoteService.noteActorFromRequest(req);
      const data = await internalNoteService.create({ ...req.body, actor, req });
      sendResponse(res, 201, 'Nota creada', data);
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await internalNoteService.noteActorFromRequest(req);
      const data = await internalNoteService.softDelete({ id: param(req, 'id'), reason: req.body?.reason, actor, req });
      sendResponse(res, 200, 'Nota eliminada', data);
    } catch (e) { next(e); }
  },
};
