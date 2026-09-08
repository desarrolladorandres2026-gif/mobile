import { Router } from 'express';
import { advertisementController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import { createAdvertisementSchema, updateAdvertisementSchema, adEventSchema } from '../validators';
import { UserRole } from '../types';
import { z } from 'zod';
import { advertisementService } from '../services/advertisement.service';
import { sendResponse, param } from '../utils';
import { AdInvoice, Advertisement, AdPricingModel } from '../models';

const router = Router();

// ── Public — consumed by the app on open, no auth required ──────────
router.get('/active', (req, res, next) => advertisementController.getActive(req, res, next));
router.post(
  '/:id/impression',
  validate(adEventSchema),
  (req, res, next) => advertisementController.registerImpression(req, res, next)
);
router.post(
  '/:id/click',
  validate(adEventSchema),
  (req, res, next) => advertisementController.registerClick(req, res, next)
);

// ── Admin — CRUD ──────────────────────────────────────────────────────
router.post(
  '/upload',
  authenticate,
  authorize(UserRole.ADMIN),
  (req, res, next) => advertisementController.uploadFlyer(req, res, next)
);

// ── Compra self-service del comercio ──────────────────────────────
// Van antes de `/:id` para que "business" no se lea como el id de una
// campaña, igual que en cupones.

const buySchema = z.object({
  body: z.object({
    campaignName: z.string().trim().min(3).max(120),
    flyerUrl: z.string().url().max(500),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    pricingModel: z.enum([AdPricingModel.CPM, AdPricingModel.CPC]),
    cpmRate: z.number().int().min(0).max(1_000_000).default(0),
    cpcRate: z.number().int().min(0).max(1_000_000).default(0),
    /** Sin tope no se compra: sería firmar un gasto abierto. */
    budget: z.number().int().positive().max(20_000_000),
    targetCities: z.array(z.string().trim().max(80)).max(20).optional(),
  }),
});

router.post(
  '/business/:businessId',
  authenticate,
  authorize(UserRole.BUSINESS),
  validate(buySchema),
  async (req, res, next) => {
    try {
      const ad = await advertisementService.requestFromBusiness({
        ownerId: req.user!._id.toString(),
        businessId: param(req, 'businessId'),
        ...req.body,
      });
      sendResponse(res, 201, 'Campaña enviada a revisión', ad);
    } catch (error) { next(error); }
  }
);

/**
 * Las campañas de un comercio, vistas por él mismo.
 *
 * El listado general es solo de admin —expone contadores y notas internas
 * de todos los anunciantes—, así que el comercio necesita el suyo. Devuelve
 * únicamente lo que él compró: `billedToBusinessId` es el filtro y no un
 * parámetro que pueda cambiar desde el navegador.
 */
router.get(
  '/business/:businessId',
  authenticate,
  authorize(UserRole.BUSINESS, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const campaigns = await Advertisement.find({
        billedToBusinessId: param(req, 'businessId'),
      })
        .select('-internalNotes -pricePaid')
        .sort({ createdAt: -1 })
        .limit(50);
      sendResponse(res, 200, 'Tus campañas', campaigns);
    } catch (error) { next(error); }
  }
);

/** Lo que el comercio lleva gastado y todavía no se le ha descontado. */
router.get(
  '/business/:businessId/invoices',
  authenticate,
  authorize(UserRole.BUSINESS, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const businessId = param(req, 'businessId');
      const [invoices, outstanding] = await Promise.all([
        AdInvoice.find({ businessId }).sort({ createdAt: -1 }).limit(50),
        advertisementService.outstandingForBusiness(businessId),
      ]);
      sendResponse(res, 200, 'Facturas de publicidad', { invoices, outstanding });
    } catch (error) { next(error); }
  }
);

// ── Revisión y cierre, del admin ──────────────────────────────────

router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Campaña aprobada', await advertisementService.approve(param(req, 'id')));
  } catch (error) { next(error); }
});

router.patch('/:id/reject', authenticate, authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    const ad = await advertisementService.reject(param(req, 'id'), req.body?.reason);
    sendResponse(res, 200, 'Campaña rechazada', ad);
  } catch (error) { next(error); }
});

router.post('/:id/close', authenticate, authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    const invoice = await advertisementService.closeAndInvoice(param(req, 'id'));
    sendResponse(res, 201, 'Campaña cerrada y facturada', invoice);
  } catch (error) { next(error); }
});

router.get('/', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  advertisementController.list(req, res, next)
);
// Antes de `/:id`: si no, Express confundiría "stats" con un id de campaña.
router.get('/stats/summary', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  advertisementController.getGlobalStats(req, res, next)
);
router.get('/:id', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  advertisementController.get(req, res, next)
);
router.get('/:id/stats', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  advertisementController.getStats(req, res, next)
);
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(createAdvertisementSchema),
  (req, res, next) => advertisementController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(updateAdvertisementSchema),
  (req, res, next) => advertisementController.update(req, res, next)
);
router.patch(
  '/:id/toggle',
  authenticate,
  authorize(UserRole.ADMIN),
  (req, res, next) => advertisementController.toggle(req, res, next)
);
router.patch(
  '/:id/cancel',
  authenticate,
  authorize(UserRole.ADMIN),
  (req, res, next) => advertisementController.cancel(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  advertisementController.remove(req, res, next)
);

export default router;
