import { Router } from 'express';
import { z } from 'zod';
import { authorize, validate } from '../middlewares';
import { requirePermission } from '../middlewares/auth';
import { AuditAction, logAudit, Permission } from '../security';
import { UserRole } from '../types';
import { SupportMacro } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { sendResponse, param } from '../utils';

// /pqrs/macros. Ver las plantillas basta con `support:view` (las usa quien
// responde); crearlas y editarlas es `support:manage` y queda auditado.
const router = Router();
router.use(authorize(UserRole.ADMIN));

const types = z.array(z.enum(['petition', 'complaint', 'claim', 'suggestion'])).max(4).default([]);
const create = z.object({ body: z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(5).max(2000),
  appliesTo: types,
}) });
const update = z.object({ body: z.object({
  title: z.string().trim().min(3).max(80).optional(),
  body: z.string().trim().min(5).max(2000).optional(),
  appliesTo: types.optional(),
  isActive: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nada que actualizar') });

router.get('/', requirePermission(Permission.SUPPORT_VIEW), async (req, res, next) => {
  try {
    // Quien gestiona ve también las archivadas; quien solo responde, las activas.
    const includeInactive = req.query.all === 'true' && (req.permissions || []).includes(Permission.SUPPORT_MANAGE);
    sendResponse(res, 200, 'Respuestas predefinidas', await SupportMacro.find(includeInactive ? {} : { isActive: true }).sort({ title: 1 }).lean());
  } catch (e) { next(e); }
});

router.post('/', requirePermission(Permission.SUPPORT_MANAGE), validate(create), async (req, res, next) => {
  try {
    const macro = await SupportMacro.create({ ...req.body, createdBy: req.user!._id });
    void logAudit(req, { action: AuditAction.SUPPORT_MACRO_CREATED, entity: 'support_macro', entityId: macro._id.toString(), description: 'Respuesta predefinida creada' });
    sendResponse(res, 201, 'Respuesta creada', macro);
  } catch (e) { next(e); }
});

router.patch('/:id', requirePermission(Permission.SUPPORT_MANAGE), validate(update), async (req, res, next) => {
  try {
    const macro = await SupportMacro.findByIdAndUpdate(param(req, 'id'), { $set: { ...req.body, updatedBy: req.user!._id } }, { new: true, runValidators: true });
    if (!macro) throw new AppError('Respuesta no encontrada', 404);
    void logAudit(req, { action: AuditAction.SUPPORT_MACRO_UPDATED, entity: 'support_macro', entityId: macro._id.toString(), description: 'Respuesta predefinida editada', metadata: { fields: Object.keys(req.body) } });
    sendResponse(res, 200, 'Respuesta actualizada', macro);
  } catch (e) { next(e); }
});

router.delete('/:id', requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const macro = await SupportMacro.findByIdAndDelete(param(req, 'id'));
    if (!macro) throw new AppError('Respuesta no encontrada', 404);
    void logAudit(req, { action: AuditAction.SUPPORT_MACRO_DELETED, entity: 'support_macro', entityId: macro._id.toString(), description: 'Respuesta predefinida eliminada' });
    sendResponse(res, 200, 'Respuesta eliminada', null);
  } catch (e) { next(e); }
});

export default router;
