import { Router } from 'express';
import { driverController } from '../controllers/driver.controller';
import { authenticate, authorize, validate } from '../middlewares';
import { reportCashSchema } from '../validators/finance.validator';
import { UserRole } from '../types';
import { z } from 'zod';

const router = Router();

// Driver self-service
router.post('/register', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.register(req, res, next));
router.get('/profile', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getProfile(req, res, next));
router.patch('/status', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.updateStatus(req, res, next));
router.patch('/location', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.updateLocation(req, res, next));
router.get('/earnings', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getEarnings(req, res, next));
router.get('/debts', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getDebts(req, res, next));
const documentSchema = z.object({ body: z.object({ type: z.enum(['identity','license','soat','technical_review','vehicle_registration']), reference: z.string().trim().min(3).max(500), expiresAt: z.coerce.date().optional() }) });
router.get('/documents', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getDocuments(req, res, next));
router.post('/documents', authenticate, authorize(UserRole.DRIVER), validate(documentSchema), (req, res, next) => driverController.submitDocument(req, res, next));

/**
 * A driver may declare a remittance; they may not settle it.
 *
 * `POST /debts/pay` used to mark the balance paid with no money attached.
 * It is gone: clearing a balance now requires a verified transaction or a
 * finance admin, through /finance/cash/verify and /finance/cash/settle.
 */
router.post(
  '/cash/report',
  authenticate,
  authorize(UserRole.DRIVER),
  validate(reportCashSchema),
  (req, res, next) => driverController.reportCash(req, res, next)
);

// Admin
router.get('/', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.getAll(req, res, next));
router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.approve(req, res, next));
router.patch('/:id/base-fund', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.updateBaseFund(req, res, next));
router.patch('/documents/:documentId/review', authenticate, authorize(UserRole.ADMIN), validate(z.object({ body: z.object({ status: z.enum(['approved','rejected']) }) })), (req, res, next) => driverController.reviewDocument(req, res, next));

export default router;
