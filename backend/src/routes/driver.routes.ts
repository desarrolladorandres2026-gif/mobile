import { Router } from 'express';
import { driverController } from '../controllers/driver.controller';
import {
  driverDossierController,
  contractBody,
  observationBody,
  requestUpdateBody,
  vehicleBody,
} from '../controllers/driverDossier.controller';
import { authenticate, authorize, requirePermission, requireFinanceAdmin, validate, driverDossierFileRateLimiter, driverDossierPdfRateLimiter, businessDocumentUploadRateLimiter } from '../middlewares';
import { listDriversQuerySchema, driverIdParamSchema } from '../validators/driver.validator';
import { Permission } from '../security';
import { reportCashSchema } from '../validators/finance.validator';
import { objectId } from '../validators/common';
import { UserRole } from '../types';
import { z } from 'zod';

// Fondo rotatorio: dinero real. `requireFinanceAdmin` + Zod acotado + auditoría
// con motivo obligatorio, igual que cualquier otro cambio de dinero de admin.
const baseFundSchema = z.object({
  body: z
    .object({
      baseFund: z.number().int().positive(),
      reason: z.string().trim().min(5).max(300),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: objectId }),
});

const router = Router();

// Driver self-service
router.post('/register', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.register(req, res, next));
router.get('/profile', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getProfile(req, res, next));
router.patch('/status', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.updateStatus(req, res, next));
router.patch('/location', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.updateLocation(req, res, next));
router.get('/earnings', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getEarnings(req, res, next));
/** Varios días a la vez. Sin `from`/`to`, la última semana. */
router.get('/earnings/range', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getEarningsRange(req, res, next));
router.get('/debts', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getDebts(req, res, next));

/**
 * Aceptación, tiempo de respuesta, entregas y calificación.
 *
 * Es un espejo, no una nota: nada de esto entra en el orden de la cascada,
 * y la propia respuesta lo dice en `affectsDispatch: false`.
 */
router.get('/metrics', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getPerformance(req, res, next));
const emergencyContactSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(7).max(20),
    relationship: z.string().trim().max(40).optional(),
  }),
});

/** A quién avisar si algo va mal. Requisito previo del botón de pánico. */
router.put('/emergency-contact', authenticate, authorize(UserRole.DRIVER), validate(emergencyContactSchema), (req, res, next) => driverController.setEmergencyContact(req, res, next));

router.patch('/vehicle', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.updateOwnVehicle(req, res, next));
router.get('/documents', authenticate, authorize(UserRole.DRIVER), (req, res, next) => driverController.getDocuments(req, res, next));
// Sin `validate`: la foto del documento llega como multipart y el esquema
// Zod correría antes de que multer hubiera poblado el cuerpo, rechazando
// todo envío por vacío. La validación vive en el controlador, después de
// leer el archivo — igual que en `/verifications` de aquí abajo.
router.post('/documents', authenticate, authorize(UserRole.DRIVER), businessDocumentUploadRateLimiter, (req, res, next) => driverController.submitDocument(req, res, next));

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
router.get('/', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_VIEW), validate(listDriversQuerySchema), (req, res, next) => driverController.getAll(req, res, next));
/** Por qué se rechazan los pedidos, en agregado. Pregunta de operaciones. */
router.get('/decline-reasons', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_VIEW), (req, res, next) => driverController.declineReasons(req, res, next));
router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), (req, res, next) => driverController.approve(req, res, next));
router.patch('/:id/base-fund', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.FINANCE_MANAGE), validate(baseFundSchema), (req, res, next) => driverController.updateBaseFund(req, res, next));
router.get('/verifications/queue', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), (req, res, next) => driverController.verificationQueue(req, res, next));
router.patch(
  '/verifications/:verificationId/review',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.DRIVERS_APPROVE),
  validate(
    z.object({
      body: z
        .object({ status: z.enum(['approved', 'rejected']), rejectionReason: z.string().trim().min(5).max(300).optional() })
        .refine((v) => v.status !== 'rejected' || !!v.rejectionReason, {
          message: 'El motivo del rechazo es obligatorio',
          path: ['rejectionReason'],
        }),
    })
  ),
  (req, res, next) => driverController.reviewVerification(req, res, next)
);
router.post('/:id/request-verification', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), (req, res, next) => driverController.requestVerification(req, res, next));
// S16: solo quien aprueba domiciliarios puede ver la cola de documentos y
// los documentos de uno en concreto — no cualquier admin. `authorize(ADMIN)`
// por sí solo no distinguía entre roles de admin con permisos distintos.
// Quién se quedó a medias en el alta, por etapa (no aparece en la cola de documentos).
router.get('/onboarding-funnel', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), async (_req, res, next) => {
  try {
    const { driverFunnel } = await import('../services/driverFunnel.service');
    const { sendResponse } = await import('../utils');
    sendResponse(res, 200, 'Embudo de alta de domiciliarios', await driverFunnel());
  } catch (error) { next(error); }
});
router.get('/documents/queue', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), driverDossierFileRateLimiter, (req, res, next) => driverController.documentQueue(req, res, next));
router.get('/:id/documents', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE), driverDossierFileRateLimiter, (req, res, next) => driverController.listDriverDocuments(req, res, next));
router.patch(
  '/documents/:documentId/review',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.DRIVERS_APPROVE),
  validate(
    z.object({
      body: z
        .object({
          status: z.enum(['approved', 'rejected']),
          rejectionReason: z.string().trim().min(5).max(300).optional(),
          // `submittedAt` (ms) que el panel tenía en pantalla: detecta reenvíos durante la revisión.
          revision: z.number().int().positive().optional(),
        })
        // O6: `rejectionReason` obligatorio si se rechaza — el servicio ya
        // lo exige, pero fallar aquí devuelve un mensaje de campo, no un 400 genérico.
        .refine((v) => v.status !== 'rejected' || !!v.rejectionReason, {
          message: 'El motivo del rechazo es obligatorio',
          path: ['rejectionReason'],
        }),
    })
  ),
  (req, res, next) => driverController.reviewDocument(req, res, next)
);

// ── Expediente digital ──────────────────────────────────────────────
// Todo exige `drivers:approve` (la cédula y los antecedentes son lo que ya ve
// quien revisa documentos). Los archivos se sirven por aquí, con el permiso
// comprobado y auditoría, nunca como URL del almacén.
const dossierAccess = [authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_APPROVE)] as const;
const dossierParams = z.object({ params: z.object({ id: objectId }) });
const dossierDocParams = z.object({ params: z.object({ id: objectId, documentId: objectId }) });
const dossierFileParams = z.object({ params: z.object({ id: objectId, fileId: z.union([z.literal('contract'), objectId]) }) });

router.get('/:id/dossier', ...dossierAccess, validate(dossierParams), (req, res, next) => driverDossierController.get(req, res, next));
router.get('/:id/dossier/pdf', ...dossierAccess, driverDossierPdfRateLimiter, validate(dossierParams), (req, res, next) => driverDossierController.exportPdf(req, res, next));
router.get('/:id/documents/:documentId/file', ...dossierAccess, driverDossierFileRateLimiter, validate(dossierDocParams), (req, res, next) => driverDossierController.documentFile(req, res, next));
router.post('/:id/documents/:documentId/request-update', ...dossierAccess, validate(z.object({ params: dossierDocParams.shape.params, body: requestUpdateBody })), (req, res, next) => driverDossierController.requestUpdate(req, res, next));
router.post('/:id/documents/:documentId/observations', ...dossierAccess, validate(z.object({ params: dossierDocParams.shape.params, body: observationBody })), (req, res, next) => driverDossierController.addObservation(req, res, next));
router.put('/:id/vehicle', ...dossierAccess, validate(z.object({ params: dossierParams.shape.params, body: vehicleBody })), (req, res, next) => driverDossierController.updateVehicle(req, res, next));
router.put('/:id/contract', ...dossierAccess, validate(z.object({ params: dossierParams.shape.params, body: contractBody })), (req, res, next) => driverDossierController.upsertContract(req, res, next));
router.post('/:id/contract/file', ...dossierAccess, businessDocumentUploadRateLimiter, validate(dossierParams), driverDossierController.attachFile('contract'));
router.post('/:id/contract/extras', ...dossierAccess, businessDocumentUploadRateLimiter, validate(dossierParams), driverDossierController.attachFile('extra'));
router.get('/:id/contract/files/:fileId', ...dossierAccess, driverDossierFileRateLimiter, validate(dossierFileParams), (req, res, next) => driverDossierController.contractFile(req, res, next));
router.delete('/:id/contract/extras/:fileId', ...dossierAccess, validate(dossierFileParams), (req, res, next) => driverDossierController.removeExtra(req, res, next));

// Va al final a propósito: `/:id` captura cualquier segmento, así que todas las
// rutas GET estáticas de arriba (/profile, /metrics, /decline-reasons...) tienen que registrarse antes.
router.get('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.DRIVERS_VIEW), validate(driverIdParamSchema), (req, res, next) => driverController.getById(req, res, next));

export default router;
