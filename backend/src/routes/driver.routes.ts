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
const emergencyContactSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(7).max(20),
    relationship: z.string().trim().max(40).optional(),
  }),
});

/** A quién avisar si algo va mal. Requisito previo del botón de pánico. */
router.put('/emergency-contact', authenticate, authorize(UserRole.DRIVER), validate(emergencyContactSchema), (req, res, next) => driverController.setEmergencyContact(req, res, next));

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

// Verificación de identidad en turno
// Sin `validate`: la foto llega como multipart y el esquema Zod se ejecuta
// antes de que multer haya poblado el cuerpo. La validación vive dentro del
// controlador, después de leer el archivo.
router.get('/verifications', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.myVerifications(req, res, next));
router.post('/verifications', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.submitVerification(req, res, next));

// Admin
router.get('/', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.getAll(req, res, next));
router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.approve(req, res, next));
router.patch('/:id/base-fund', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.updateBaseFund(req, res, next));
router.get('/verifications/queue', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.verificationQueue(req, res, next));
router.patch('/verifications/:verificationId/review', authenticate, authorize(UserRole.ADMIN), validate(z.object({ body: z.object({ status: z.enum(['approved','rejected']), rejectionReason: z.string().max(300).optional() }) })), (req, res, next) => driverController.reviewVerification(req, res, next));
router.post('/:id/request-verification', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.requestVerification(req, res, next));
router.get('/documents/queue', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.documentQueue(req, res, next));
router.get('/:id/documents', authenticate, authorize(UserRole.ADMIN), (req, res, next) => driverController.listDriverDocuments(req, res, next));
router.patch('/documents/:documentId/review', authenticate, authorize(UserRole.ADMIN), validate(z.object({ body: z.object({ status: z.enum(['approved','rejected']) }) })), (req, res, next) => driverController.reviewDocument(req, res, next));

export default router;
