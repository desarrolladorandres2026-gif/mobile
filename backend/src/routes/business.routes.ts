import { Router, Request, Response, NextFunction } from 'express';
import { assertIsSuperAdmin } from '../services/authorization.service';
import { businessController } from '../controllers';
import {
  authenticate,
  authorize,
  requirePermission,
  businessDocumentUploadRateLimiter,
  businessFiscalRateLimiter,
  payoutAccountRevealRateLimiter,
} from '../middlewares';
import { validate } from '../middlewares';
import { adminRequires } from '../middlewares/auth';
import {
  createBusinessSchema,
  updateBusinessSchema,
  reviewBusinessDocumentSchema,
  businessLegalSchema,
  businessPayoutAccountSchema,
  verifyPayoutAccountSchema,
} from '../validators';
import { objectId } from '../validators/common';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';
import { z } from 'zod';

/**
 * Solo el `:id` de la ruta. Se usa donde el cuerpo es multipart (lo lee multer
 * dentro del controlador) o no hay cuerpo: como el esquema no declara `body`,
 * `validate` no lo toca. Un `id` con forma inválida se rechaza aquí con 400 en
 * vez de llegar a Mongoose como un `CastError`.
 */
const idParamSchema = z.object({ params: z.object({ id: objectId }) });

/**
 * Escribir la cuenta de pago de un comercio es solo del dueño o de un Super
 * Administrador (decisión del dueño, Fase 1): a quien le cambia la cuenta le
 * cambia a dónde va el dinero. Otros roles pasan sin más.
 */
const adminSuperOnly = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user && req.user.role === UserRole.ADMIN) {
    assertIsSuperAdmin(req.user, 'Solo un Super Administrador puede escribir la cuenta de pago de un comercio').then(() => next(), next);
    return;
  }
  next();
};

const router = Router();

// Public
// ── Alta y verificación documental ──
// Va antes de `/:id` para que "pending" no se lea como el id de un negocio.
router.get('/pending', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.BUSINESSES_APPROVE), (req, res, next) => businessController.pendingApprovals(req, res, next));

router.get('/', (req, res, next) => businessController.getAll(req, res, next));
router.get('/slug/:slug', (req, res, next) => businessController.getBySlug(req, res, next));
/** Tarjeta pública para el enlace del botón "Compartir". Ver el controlador. */
router.get('/slug/:slug/share', (req, res, next) => businessController.sharePreview(req, res, next));
router.get('/:id', (req, res, next) => businessController.getById(req, res, next));
router.get('/:id/storefront', (req, res, next) => businessController.storefront(req, res, next));

// Protected – owner/admin
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_CREATE), validate(createBusinessSchema), (req, res, next) => businessController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), validate(updateBusinessSchema), (req, res, next) => businessController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => businessController.delete(req, res, next));

// ── Identidad visual: logo y portada ──
// Sin `validate`: el cuerpo es multipart y lo lee multer dentro del
// controlador, como en la foto de producto. Pasarlo por zod aquí vaciaría
// `req.body` antes de que multer llegue a verlo.
router.post('/:id/logo', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => businessController.uploadLogo(req, res, next));
router.post('/:id/cover', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => businessController.uploadCover(req, res, next));
router.delete('/:id/image/:slot', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => businessController.removeBrandImage(req, res, next));
// ── Documentos del comercio (O4) ──
// La subida es multipart: el archivo y sus campos los lee multer dentro del
// controlador, después de comprobar el acceso. Nunca `validate(body)` aquí.
router.get('/:id/documents', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(idParamSchema), (req, res, next) => businessController.listDocuments(req, res, next));
router.post('/:id/documents', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), businessDocumentUploadRateLimiter, validate(idParamSchema), (req, res, next) => businessController.submitDocument(req, res, next));
router.patch('/documents/:documentId/review', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.BUSINESSES_APPROVE), validate(reviewBusinessDocumentSchema), (req, res, next) => businessController.reviewDocument(req, res, next));
router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.BUSINESSES_APPROVE), validate(idParamSchema), (req, res, next) => businessController.approve(req, res, next));

// ── Datos legales y cuenta de pago ──
// El dueño edita los suyos; la cuenta queda pendiente hasta que finanzas la
// verifica, y solo finanzas puede leer el número completo.
router.get('/:id/legal', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), validate(idParamSchema), (req, res, next) => businessController.getLegal(req, res, next));
router.put('/:id/legal', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), businessFiscalRateLimiter, validate(businessLegalSchema), (req, res, next) => businessController.putLegal(req, res, next));
router.get('/:id/payout-account', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(idParamSchema), (req, res, next) => businessController.getPayoutAccount(req, res, next));
router.put('/:id/payout-account', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminSuperOnly, businessFiscalRateLimiter, validate(businessPayoutAccountSchema), (req, res, next) => businessController.putPayoutAccount(req, res, next));
router.post('/:id/payout-account/reauth-otp', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminSuperOnly, businessFiscalRateLimiter, validate(idParamSchema), (req, res, next) => businessController.requestPayoutAccountOtp(req, res, next));
router.patch('/:id/payout-account/verify', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.PAYOUTS_PROCESS), businessFiscalRateLimiter, validate(verifyPayoutAccountSchema), (req, res, next) => businessController.verifyPayoutAccount(req, res, next));
router.get('/:id/payout-account/reveal', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.PAYOUTS_REVEAL_ACCOUNT), payoutAccountRevealRateLimiter, businessFiscalRateLimiter, validate(idParamSchema), (req, res, next) => businessController.revealPayoutAccount(req, res, next));

router.get('/my/businesses', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_VIEW), (req, res, next) => businessController.getMyBusinesses(req, res, next));

// Lo que ZIPP le debe a este comercio. La propiedad se verifica en el
// controlador: un comercio no puede leer las cifras de otro.
const staffSchema = z.object({
  body: z.object({
    phone: z.string().trim().min(7).max(20),
    role: z.enum(['manager', 'staff']),
  }),
});

router.get('/:id/staff', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_VIEW), (req, res, next) => businessController.listStaff(req, res, next));
router.post('/:id/staff', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), validate(staffSchema), (req, res, next) => businessController.addStaff(req, res, next));
router.delete('/:id/staff/:staffId', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_UPDATE_ALL), (req, res, next) => businessController.removeStaff(req, res, next));
router.get('/:id/my-permissions', authenticate, (req, res, next) => businessController.myPermissions(req, res, next));

router.get('/:id/analytics', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.BUSINESSES_VIEW), (req, res, next) => businessController.analytics(req, res, next));
router.get('/:id/statement/export', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.FINANCE_VIEW), (req, res, next) => businessController.exportSales(req, res, next));
router.get('/:id/statement', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.FINANCE_VIEW), (req, res, next) => businessController.getStatement(req, res, next));
router.get('/:id/statement/lines', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), adminRequires(Permission.FINANCE_VIEW), (req, res, next) => businessController.getStatementLines(req, res, next));

export default router;
