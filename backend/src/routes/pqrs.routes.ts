import { Router } from 'express'; import { authenticate, authorize, validate } from '../middlewares'; import { UserRole } from '../types'; import { pqrsController } from '../controllers/pqrs.controller'; import { z } from 'zod'; import { requirePermission } from '../middlewares/auth'; import { Permission, AuditAction, logAudit } from '../security'; import { AppError } from '../middlewares/errorHandler'; import macrosRouter from './supportMacros.routes'; import { pqrsCreateRateLimiter, pqrsEvidenceRateLimiter } from '../middlewares/security'; import { objectId } from '../validators/common'; import { User } from '../models'; import { PQRS_REASONS } from '../services/pqrs.service';
const router = Router(); const requesterReply = z.object({ body: z.object({ message: z.string().trim().min(2).max(4000) }) }); const create = z.object({ body: z.object({ type: z.enum(['petition','complaint','claim','suggestion']).optional(), reason: z.enum(PQRS_REASONS).optional(), subject: z.string().trim().min(3).max(160), detail: z.string().trim().min(10).max(4000), orderId: z.string().trim().length(24).optional(), businessId: z.string().trim().length(24).optional() }) }); const reply = z.object({ body: z.object({ message: z.string().trim().min(2).max(4000), status: z.enum(['in_review','answered','closed']).optional() }) });
router.use(authenticate); router.use('/macros', macrosRouter); router.post('/', pqrsCreateRateLimiter, validate(create), pqrsController.create.bind(pqrsController)); router.get('/my', pqrsController.mine.bind(pqrsController)); router.post('/:id/reply', pqrsCreateRateLimiter, validate(requesterReply), pqrsController.requesterReply.bind(pqrsController)); router.post('/:id/evidence', pqrsEvidenceRateLimiter, pqrsController.addEvidence.bind(pqrsController));
const evidenceParams = z.object({ params: z.object({ id: objectId, evidenceId: objectId }) });
const idParams = z.object({ params: z.object({ id: objectId }) });
const reopenBody = z.object({ params: z.object({ id: objectId }), body: z.object({ message: z.string().trim().min(5).max(4000) }) });
router.get('/:id/evidence/:evidenceId/url', validate(evidenceParams), pqrsController.evidenceUrl.bind(pqrsController));
// Quien abrió el caso cierra o reabre el suyo; el personal lo hace por las rutas de abajo.
router.post('/:id/resolve', validate(idParams), pqrsController.confirmResolved.bind(pqrsController));
router.post('/:id/reopen', pqrsCreateRateLimiter, validate(reopenBody), pqrsController.reopen.bind(pqrsController));
// Los casos de todo el local: lo que abrió cualquiera del equipo. Va aparte de `/my` porque exige un permiso del negocio.
router.get('/business/:businessId', validate(z.object({ params: z.object({ businessId: objectId }) })), async (req, res, next) => {
  try {
    const { businessStaffService } = await import('../services/businessStaff.service');
    const { BusinessPermission } = await import('../models');
    await businessStaffService.assertCan(req.user!._id.toString(), String(req.params.businessId), BusinessPermission.SUPPORT_VIEW_TEAM, 'Solo el propietario y los administradores ven los casos de todo el local', req.sessionScope);
    await pqrsController.businessCases(req, res, next);
  } catch (error) { next(error); }
});
router.get('/support/:id/evidence/:evidenceId/url', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), validate(evidenceParams), pqrsController.staffEvidenceUrl.bind(pqrsController)); router.get('/', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), pqrsController.list.bind(pqrsController)); router.patch('/:id/respond', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(reply), pqrsController.respond.bind(pqrsController));

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
      view: (['open', 'answered', 'closed', 'done'] as const).find((v) => v === query(req, 'view')),
      type: (['petition', 'complaint', 'claim', 'suggestion'] as const).find((v) => v === query(req, 'type')),
      requesterRole: (['customer', 'business', 'driver'] as const).find((v) => v === query(req, 'requesterRole')),
      q: query(req, 'q') || undefined,
      unassigned: query(req, 'unassigned') === 'true',
      refundRequested: query(req, 'refundRequested') === 'true',
      limit: Number(query(req, 'limit')) || undefined,
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

router.patch('/:id/reopen', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    const ticket = await supportService.reopen(param(req, 'id'), req.user!._id.toString());
    void logAudit(req, { action: AuditAction.PQRS_REOPENED, entity: 'pqrs', entityId: ticket._id.toString(), description: 'Caso reabierto' });
    sendResponse(res, 200, 'Caso reabierto', ticket);
  } catch (error) { next(error); }
});

// Soporte pide el reembolso; Finanzas (REFUNDS_CREATE) lo atiende en la ficha del pedido y cierra la petición.
const refundRequestBody = z.object({ body: z.object({ reason: z.string().trim().min(5).max(500) }) });
router.patch('/:id/refund-request', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(refundRequestBody), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    const ticket = await supportService.requestRefund(param(req, 'id'), req.user!._id.toString(), req.body.reason);
    void logAudit(req, { action: AuditAction.PQRS_REFUND_REQUESTED, entity: 'pqrs', entityId: ticket._id.toString(), description: 'Reembolso solicitado a Finanzas', metadata: { orderId: String(ticket.orderId) } });
    sendResponse(res, 200, 'Reembolso solicitado a Finanzas', ticket);
  } catch (error) { next(error); }
});

const refundResolveBody = z.object({ body: z.object({ outcome: z.enum(['done', 'rejected']), note: z.string().trim().max(500).optional() }) });
router.patch('/:id/refund-request/resolve', authorize(UserRole.ADMIN), requirePermission(Permission.REFUNDS_CREATE), validate(refundResolveBody), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    const ticket = await supportService.resolveRefundRequest(param(req, 'id'), req.user!._id.toString(), req.body.outcome, req.body.note);
    void logAudit(req, { action: AuditAction.PQRS_REFUND_RESOLVED, entity: 'pqrs', entityId: ticket._id.toString(), description: 'Solicitud de reembolso atendida', metadata: { outcome: req.body.outcome } });
    sendResponse(res, 200, 'Solicitud atendida', ticket);
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
