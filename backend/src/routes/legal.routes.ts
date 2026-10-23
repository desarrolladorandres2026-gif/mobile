import { Router } from 'express'; import { authenticate, authorize, validate } from '../middlewares'; import { UserRole } from '../types'; import { legalController } from '../controllers/legal.controller'; import { z } from 'zod'; import { requirePermission } from '../middlewares/auth'; import { Permission } from '../security';
import { deletionOtpIpRateLimiter, deletionOtpPhoneRateLimiter, deletionConfirmRateLimiter } from '../middlewares';
import { publicFormsController } from '../controllers/publicForms.controller';
import { deletionSendOtpSchema, deletionConfirmSchema } from '../validators/publicForms.validator';
const router = Router(); const data = z.object({ body: z.object({ type: z.enum(['access','rectify','update','delete','revoke']), detail: z.string().trim().min(10).max(2000) }) });
router.get('/documents', legalController.active.bind(legalController));
// Eliminación de cuenta SIN sesión (requisito de Google Play). Públicas a propósito: van antes de authenticate.
// Responden igual exista o no la cuenta; ver accountDeletionRequest.service.
router.post('/deletion-request/send-otp', deletionOtpIpRateLimiter, validate(deletionSendOtpSchema), deletionOtpPhoneRateLimiter, publicFormsController.deletionSendOtp.bind(publicFormsController));
router.post('/deletion-request/confirm', deletionConfirmRateLimiter, validate(deletionConfirmSchema), publicFormsController.deletionConfirm.bind(publicFormsController));
router.use(authenticate);
router.get('/pending', legalController.pending.bind(legalController));
router.post('/documents/:id/accept', legalController.accept.bind(legalController)); router.get('/acceptances', legalController.myAcceptances.bind(legalController)); router.post('/data-requests', validate(data), legalController.createDataRequest.bind(legalController)); router.get('/data-requests', legalController.myDataRequests.bind(legalController));
router.get('/admin/data-requests', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_VIEW), legalController.adminDataRequests.bind(legalController)); router.patch('/admin/data-requests/:id', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_MANAGE), validate(z.object({ body: z.object({ status: z.enum(['received','in_review','resolved','rejected']), response: z.string().trim().min(2).max(4000), anonymize: z.boolean().optional().default(false) }) })), legalController.answerDataRequest.bind(legalController));
const kinds = z.enum(['terms', 'privacy', 'habeas_data', 'promotions', 'cancellations', 'payments', 'delivery', 'provider']);
router.get('/admin/documents', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_VIEW), legalController.adminDocuments.bind(legalController));
router.get('/admin/documents/:id', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_VIEW), legalController.adminDocument.bind(legalController));
router.get('/admin/documents/:id/acceptances', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_VIEW), legalController.adminAcceptances.bind(legalController));
router.post('/admin/documents', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_PUBLISH), validate(z.object({ body: z.object({ kind: kinds, version: z.string().trim().min(1).max(30), title: z.string().trim().min(3).max(160), content: z.string().trim().min(50).max(50000), changeNote: z.string().trim().max(500).optional() }) })), legalController.publishDocument.bind(legalController));
router.patch('/admin/data-requests/:id/take', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_MANAGE), legalController.takeDataRequest.bind(legalController));
router.patch('/admin/data-requests/:id/extend', authorize(UserRole.ADMIN), requirePermission(Permission.LEGAL_MANAGE), validate(z.object({ body: z.object({ reason: z.string().trim().min(10).max(1000) }) })), legalController.extendDataRequest.bind(legalController));
export default router;
