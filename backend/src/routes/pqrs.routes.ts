import { Router } from 'express'; import { authenticate, authorize, validate } from '../middlewares'; import { UserRole } from '../types'; import { pqrsController } from '../controllers/pqrs.controller'; import { z } from 'zod'; import { requirePermission } from '../middlewares/auth'; import { Permission, AuditAction, logAudit } from '../security'; import { AppError } from '../middlewares/errorHandler'; import macrosRouter from './supportMacros.routes'; import { pqrsCreateRateLimiter } from '../middlewares/security'; import { User } from '../models';
const router = Router(); const create = z.object({ body: z.object({ type: z.enum(['petition','complaint','claim','suggestion']), subject: z.string().trim().min(3).max(160), detail: z.string().trim().min(10).max(4000), orderId: z.string().trim().length(24).optional(), businessId: z.string().trim().length(24).optional() }) }); const evidence = z.object({ body: z.object({ url: z.string().url().max(1000), name: z.string().trim().min(1).max(160) }) }); const reply = z.object({ body: z.object({ message: z.string().trim().min(2).max(4000), status: z.enum(['in_review','answered','closed']).optional() }) });
router.use(authenticate); router.use('/macros', macrosRouter); router.post('/', pqrsCreateRateLimiter, validate(create), pqrsController.create.bind(pqrsController)); router.get('/my', pqrsController.mine.bind(pqrsController)); router.post('/:id/evidence', validate(evidence), pqrsController.addEvidence.bind(pqrsController)); router.get('/', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), pqrsController.list.bind(pqrsController)); router.patch('/:id/respond', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(reply), pqrsController.respond.bind(pqrsController));

// ── Bandeja de trabajo de soporte ──
// `Pqrs` ya guardaba tipo, estado y respuestas; esto añade lo que convierte
// una lista en una cola: quién lo tiene, cuándo vence y cuánto se tardó.
// La cola va antes de `/:id` para que "queue" no se lea como un id.
router.get('/support/queue', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, query } = await import('../utils');
    sendResponse(res, 200, 'Cola de soporte', await supportService.queue({
      assignedTo: query(req, 'assignedTo') || undefined,
      onlyOverdue: query(req, 'overdue') === 'true',
      onlyLegalOverdue: query(req, 'legalOverdue') === 'true',
      view: (['open', 'answered', 'done'] as const).find((v) => v === query(req, 'view')),
      type: (['petition', 'complaint', 'claim', 'suggestion'] as const).find((v) => v === query(req, 'type')),
      requesterRole: (['customer', 'business', 'driver'] as const).find((v) => v === query(req, 'requesterRole')),
      q: query(req, 'q') || undefined,
    }));
  } catch (error) { next(error); }
});

router.get('/support/metrics', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse } = await import('../utils');
    sendResponse(res, 200, 'Métricas de soporte', await supportService.metrics());
  } catch (error) { next(error); }
});

router.patch('/:id/assign', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    const agentId = req.body?.agentId ?? req.user!._id.toString();
    if (agentId !== req.user!._id.toString()) {
      // Solo se asigna a personal del panel: un id cualquiera podía ser un cliente.
      const agent = await User.findOne({ _id: String(agentId), role: UserRole.ADMIN, isActive: { $ne: false } }).select('_id').lean().catch(() => null);
      if (!agent) throw new AppError('Solo se puede asignar a personal del panel', 422);
    }
    const ticket = await supportService.assign(param(req, 'id'), String(agentId));
    void logAudit(req, { action: AuditAction.PQRS_ASSIGNED, entity: 'pqrs', entityId: ticket._id.toString(), description: 'Caso asignado', metadata: { assignedTo: String(agentId) } });
    sendResponse(res, 200, 'Caso asignado', ticket);
  } catch (error) { next(error); }
});

router.patch('/:id/classify', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body?.priority) ? req.body.priority : undefined;
    if (req.body?.priority && !priority) throw new AppError('Prioridad no válida', 422);
    const { ticket, previous } = await supportService.classifyWithPrevious(param(req, 'id'), priority);
    void logAudit(req, { action: AuditAction.PQRS_CLASSIFIED, entity: 'pqrs', entityId: ticket._id.toString(), description: 'Caso clasificado', metadata: { fromPriority: previous.priority, toPriority: ticket.priority, fromDueAt: previous.dueAt, toDueAt: ticket.dueAt } });
    sendResponse(res, 200, 'Caso clasificado', ticket);
  } catch (error) { next(error); }
});

router.patch('/:id/close', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    sendResponse(res, 200, 'Caso cerrado', await supportService.close(param(req, 'id'), req.user!._id.toString(), req.body?.message));
  } catch (error) { next(error); }
});

export default router;
