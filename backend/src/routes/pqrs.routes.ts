import { Router } from 'express'; import { authenticate, authorize, validate } from '../middlewares'; import { UserRole } from '../types'; import { pqrsController } from '../controllers/pqrs.controller'; import { z } from 'zod'; import { requirePermission } from '../middlewares/auth'; import { Permission } from '../security';
const router = Router(); const create = z.object({ body: z.object({ type: z.enum(['petition','complaint','claim','suggestion']), subject: z.string().trim().min(3).max(160), detail: z.string().trim().min(10).max(4000), orderId: z.string().trim().length(24).optional() }) }); const evidence = z.object({ body: z.object({ url: z.string().url().max(1000), name: z.string().trim().min(1).max(160) }) }); const reply = z.object({ body: z.object({ message: z.string().trim().min(2).max(4000), status: z.enum(['in_review','answered','closed']).optional() }) });
router.use(authenticate); router.post('/', validate(create), pqrsController.create.bind(pqrsController)); router.get('/my', pqrsController.mine.bind(pqrsController)); router.post('/:id/evidence', validate(evidence), pqrsController.addEvidence.bind(pqrsController)); router.get('/', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_VIEW), pqrsController.list.bind(pqrsController)); router.patch('/:id/respond', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), validate(reply), pqrsController.respond.bind(pqrsController));

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
    sendResponse(res, 200, 'Caso asignado', await supportService.assign(param(req, 'id'), agentId));
  } catch (error) { next(error); }
});

router.patch('/:id/classify', authorize(UserRole.ADMIN), requirePermission(Permission.SUPPORT_MANAGE), async (req, res, next) => {
  try {
    const { supportService } = await import('../services/support.service');
    const { sendResponse, param } = await import('../utils');
    sendResponse(res, 200, 'Caso clasificado', await supportService.classify(param(req, 'id'), req.body?.priority));
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
