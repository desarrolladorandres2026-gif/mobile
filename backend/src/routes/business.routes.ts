import { Router } from 'express';
import { businessController } from '../controllers';
import { authenticate, authorize } from '../middlewares';
import { validate } from '../middlewares';
import { createBusinessSchema, updateBusinessSchema } from '../validators';
import { UserRole } from '../types';
import { z } from 'zod';

const businessDocumentSchema = z.object({
  body: z.object({
    type: z.enum(['rut', 'chamber_of_commerce', 'legal_rep_id', 'bank_certificate', 'health_permit']),
    reference: z.string().trim().min(3).max(500),
    expiresAt: z.coerce.date().optional(),
  }),
});

const reviewBusinessDocumentSchema = z.object({
  body: z.object({
    status: z.enum(['approved', 'rejected']),
    rejectionReason: z.string().max(300).optional(),
  }),
});

const router = Router();

// Public
// ── Alta y verificación documental ──
// Va antes de `/:id` para que "pending" no se lea como el id de un negocio.
router.get('/pending', authenticate, authorize(UserRole.ADMIN), (req, res, next) => businessController.pendingApprovals(req, res, next));

router.get('/', (req, res, next) => businessController.getAll(req, res, next));
router.get('/slug/:slug', (req, res, next) => businessController.getBySlug(req, res, next));
/** Tarjeta pública para el enlace del botón "Compartir". Ver el controlador. */
router.get('/slug/:slug/share', (req, res, next) => businessController.sharePreview(req, res, next));
router.get('/:id', (req, res, next) => businessController.getById(req, res, next));
router.get('/:id/storefront', (req, res, next) => businessController.storefront(req, res, next));

// Protected – owner/admin
router.post('/', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(createBusinessSchema), (req, res, next) => businessController.create(req, res, next));
router.put('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(updateBusinessSchema), (req, res, next) => businessController.update(req, res, next));
router.delete('/:id', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.delete(req, res, next));

// ── Identidad visual: logo y portada ──
// Sin `validate`: el cuerpo es multipart y lo lee multer dentro del
// controlador, como en la foto de producto. Pasarlo por zod aquí vaciaría
// `req.body` antes de que multer llegue a verlo.
router.post('/:id/logo', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.uploadLogo(req, res, next));
router.post('/:id/cover', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.uploadCover(req, res, next));
router.delete('/:id/image/:slot', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.removeBrandImage(req, res, next));
router.get('/:id/documents', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.listDocuments(req, res, next));
router.post('/:id/documents', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(businessDocumentSchema), (req, res, next) => businessController.submitDocument(req, res, next));
router.patch('/documents/:documentId/review', authenticate, authorize(UserRole.ADMIN), validate(reviewBusinessDocumentSchema), (req, res, next) => businessController.reviewDocument(req, res, next));
router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), (req, res, next) => businessController.approve(req, res, next));

router.get('/my/businesses', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getMyBusinesses(req, res, next));

// Lo que ZIPP le debe a este comercio. La propiedad se verifica en el
// controlador: un comercio no puede leer las cifras de otro.
const staffSchema = z.object({
  body: z.object({
    phone: z.string().trim().min(7).max(20),
    role: z.enum(['manager', 'staff']),
  }),
});

router.get('/:id/staff', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.listStaff(req, res, next));
router.post('/:id/staff', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), validate(staffSchema), (req, res, next) => businessController.addStaff(req, res, next));
router.delete('/:id/staff/:staffId', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.removeStaff(req, res, next));
router.get('/:id/my-permissions', authenticate, (req, res, next) => businessController.myPermissions(req, res, next));

router.get('/:id/analytics', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.analytics(req, res, next));
router.get('/:id/statement/export', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.exportSales(req, res, next));
router.get('/:id/statement', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getStatement(req, res, next));
router.get('/:id/statement/lines', authenticate, authorize(UserRole.BUSINESS, UserRole.ADMIN), (req, res, next) => businessController.getStatementLines(req, res, next));

export default router;
