import { Router } from 'express';
import { advertisementController } from '../controllers';
import { authenticate, authenticateIfPresent, authorize, validate, productImageUploadRateLimiter, adEventDeviceRateLimiter, adEventNetworkRateLimiter } from '../middlewares';
import { createAdvertisementSchema, updateAdvertisementSchema, adEventSchema } from '../validators';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';
import { z } from 'zod';
import { advertisementService } from '../services/advertisement.service';
import { isOwnStorageUrl } from '../services/driverDossierFiles';
import { businessStaffService } from '../services/businessStaff.service';
import { sendResponse, param } from '../utils';
import { AdInvoice, Advertisement, AdPricingModel, BusinessPermission } from '../models';
import { AppError } from '../middlewares';

/**
 * IDOR (S2): `authorize(UserRole.BUSINESS)` solo comprueba que quien pide es
 * *algún* comercio, no que sea EL comercio de `:businessId` — cualquier
 * cuenta de comercio podía leer la publicidad, las facturas y la deuda de
 * otro con solo cambiar el id en la URL. Admin pasa siempre.
 */
async function assertOwnsBusinessOrAdmin(req: any, businessId: string): Promise<void> {
  if (req.user?.role === UserRole.ADMIN) {
    if (can(req, Permission.ADS_VIEW)) return;
    throw new AppError('No tienes permisos suficientes para esta acción', 403);
  }
  const permissions = await businessStaffService.permissionsFor(req.user!._id.toString(), businessId, req.sessionScope);
  if (!permissions.includes(BusinessPermission.ADVERTISING_MANAGE)) {
    throw new AppError('Sin permisos para gestionar publicidad.', 403);
  }
}

/**
 * M3: facturas y deuda de publicidad son dinero del negocio, no solo "sus
 * campañas". El dueño lo ve siempre (`permissionsFor` le da todos los
 * permisos); un empleado (mostrador, encargado) solo si tiene
 * `SETTLEMENTS_VIEW` — el mismo permiso que ya protege las liquidaciones.
 */
async function assertCanViewBusinessSettlements(req: any, businessId: string): Promise<void> {
  if (req.user?.role === UserRole.ADMIN) {
    if (can(req, Permission.ADS_VIEW)) return;
    throw new AppError('No tienes permisos suficientes para esta acción', 403);
  }
  const permissions = await businessStaffService.permissionsFor(req.user!._id.toString(), businessId, req.sessionScope);
  if (!permissions.includes(BusinessPermission.SETTLEMENTS_VIEW)) {
    throw new AppError('No autorizado', 403);
  }
}

const router = Router();

// ── Public — consumed by the app on open, no auth required ──────────
router.get('/active', (req, res, next) => advertisementController.getActive(req, res, next));
router.post(
  '/:id/impression',
  adEventNetworkRateLimiter,
  adEventDeviceRateLimiter,
  // Quien tiene sesión queda identificado: el clic cobrable es uno por cuenta, no solo por dispositivo.
  authenticateIfPresent,
  validate(adEventSchema),
  (req, res, next) => advertisementController.registerImpression(req, res, next)
);
router.post(
  '/:id/click',
  adEventNetworkRateLimiter,
  adEventDeviceRateLimiter,
  authenticateIfPresent,
  validate(adEventSchema),
  (req, res, next) => advertisementController.registerClick(req, res, next)
);

// ── Admin — CRUD ──────────────────────────────────────────────────────
router.post(
  '/upload',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ADS_MANAGE),
  (req, res, next) => advertisementController.uploadFlyer(req, res, next)
);

// ── Compra self-service del comercio ──────────────────────────────
// Van antes de `/:id` para que "business" no se lea como el id de una
// campaña, igual que en cupones.

/**
 * El flyer del comercio tiene que vivir en NUESTRO Cloudinary (auditoría
 * 2026-10-17). Con una URL libre, el comercio servía la imagen desde su propio
 * servidor: podía enseñar una al revisor y cambiarla después de aprobada, y
 * veía la IP del admin que revisa y la de cada cliente que abre la app. Se
 * sube por `POST /business/:businessId/flyer`, que inspecciona el archivo.
 */
const ownFlyerUrl = z
  .string()
  .url()
  .max(500)
  .refine((url) => isOwnStorageUrl(url) && new URL(url).hostname === 'res.cloudinary.com', {
    message: 'Sube el flyer desde el panel: no se aceptan enlaces externos',
  });

const buySchema = z.object({
  body: z.object({
    campaignName: z.string().trim().min(3).max(120),
    flyerUrl: ownFlyerUrl,
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    pricingModel: z.enum([AdPricingModel.CPM, AdPricingModel.CPC]),
    cpmRate: z.number().int().min(0).max(1_000_000).default(0),
    cpcRate: z.number().int().min(0).max(1_000_000).default(0),
    /** Sin tope no se compra: sería firmar un gasto abierto. */
    budget: z.number().int().positive().max(20_000_000),
    targetCities: z.array(z.string().trim().max(80)).max(20).optional(),
    // Dentro de lo que ofrece ZIPP; sin indicar, la primera que ofrezca.
    placement: z.enum(['splash', 'explore']).optional(),
  }),
});

/**
 * Qué puede comprar hoy este comercio: modalidades, rangos de tarifa,
 * presupuesto, duración y ubicaciones. El panel lo usa para guiar; la compra
 * y la aprobación lo vuelven a exigir.
 */
router.get(
  '/business/:businessId/offer',
  authenticate,
  authorize(UserRole.BUSINESS),
  async (req, res, next) => {
    try {
      await assertOwnsBusinessOrAdmin(req, param(req, 'businessId'));
      sendResponse(res, 200, 'Oferta de publicidad', await advertisementService.currentOffer());
    } catch (error) { next(error); }
  }
);

// Subida del flyer del comercio: misma inspección (tipo real, tamaño) que la
// del admin. El permiso se comprueba antes de leer el archivo entero a memoria.
router.post(
  '/business/:businessId/flyer',
  authenticate,
  authorize(UserRole.BUSINESS),
  productImageUploadRateLimiter,
  async (req, res, next) => {
    try {
      await assertOwnsBusinessOrAdmin(req, param(req, 'businessId'));
      advertisementController.uploadFlyer(req, res, next);
    } catch (error) { next(error); }
  }
);

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
        scope: req.sessionScope,
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
      const businessId = param(req, 'businessId');
      await assertOwnsBusinessOrAdmin(req, businessId);
      const campaigns = await Advertisement.find({
        billedToBusinessId: businessId,
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
      await assertCanViewBusinessSettlements(req, businessId);
      const [invoices, outstanding] = await Promise.all([
        AdInvoice.find({ businessId }).sort({ createdAt: -1 }).limit(50),
        advertisementService.outstandingForBusiness(businessId),
      ]);
      sendResponse(res, 200, 'Facturas de publicidad', { invoices, outstanding });
    } catch (error) { next(error); }
  }
);

// ── Revisión y cierre, del admin ──────────────────────────────────

router.patch('/:id/approve', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_MANAGE), async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Campaña aprobada', await advertisementService.approve(param(req, 'id')));
  } catch (error) { next(error); }
});

router.patch('/:id/reject', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_MANAGE), async (req, res, next) => {
  try {
    const ad = await advertisementService.reject(param(req, 'id'), req.body?.reason);
    sendResponse(res, 200, 'Campaña rechazada', ad);
  } catch (error) { next(error); }
});

router.post('/:id/close', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_MANAGE), async (req, res, next) => {
  try {
    // Cerrar y facturar mueve dinero del comercio: ademas de ads:manage exige finance:manage.
    if (!can(req, Permission.FINANCE_MANAGE)) {
      throw new AppError('Cerrar y facturar una campaña requiere permisos financieros', 403);
    }
    const invoice = await advertisementService.closeAndInvoice(param(req, 'id'));
    sendResponse(res, 201, 'Campaña cerrada y facturada', invoice);
  } catch (error) { next(error); }
});

router.get('/', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_VIEW), (req, res, next) =>
  advertisementController.list(req, res, next)
);
// Antes de `/:id`: si no, Express confundiría "stats" con un id de campaña.
router.get('/stats/summary', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_VIEW), (req, res, next) =>
  advertisementController.getGlobalStats(req, res, next)
);
router.get('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_VIEW), (req, res, next) =>
  advertisementController.get(req, res, next)
);
router.get('/:id/stats', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_VIEW), (req, res, next) =>
  advertisementController.getStats(req, res, next)
);
router.get('/:id/clicks', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_VIEW), (req, res, next) =>
  advertisementController.listClicks(req, res, next)
);
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ADS_MANAGE),
  validate(createAdvertisementSchema),
  (req, res, next) => advertisementController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ADS_MANAGE),
  validate(updateAdvertisementSchema),
  (req, res, next) => advertisementController.update(req, res, next)
);
router.patch(
  '/:id/toggle',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ADS_MANAGE),
  (req, res, next) => advertisementController.toggle(req, res, next)
);
router.patch(
  '/:id/cancel',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ADS_MANAGE),
  (req, res, next) => advertisementController.cancel(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADS_MANAGE), (req, res, next) =>
  advertisementController.remove(req, res, next)
);

export default router;
