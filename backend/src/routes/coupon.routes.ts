import { Router } from 'express';
import { couponController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import {
  validateCouponSchema,
  createCouponSchema,
  updateCouponSchema,
  businessCouponSchema,
  updateBusinessCouponSchema,
} from '../validators';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// Public — promotions shown in the app
router.get('/public', (req, res, next) => couponController.getPublic(req, res, next));

// Los cupones nominales del cliente (los de canjear puntos). Privados: no
// salen en `/public`.
router.get('/mine', authenticate, authorize(UserRole.CLIENT), (req, res, next) =>
  couponController.getForUser(req, res, next)
);

// Cuáles de los cupones públicos puede usar quien pregunta. Separado de
// `/public` porque eso se sirve desde caché compartida y esto depende de
// quién es: mezclarlos serviría la respuesta de una persona a otra.
router.get('/eligibility', authenticate, authorize(UserRole.CLIENT), (req, res, next) =>
  couponController.eligibility(req, res, next)
);

// Authenticated — preview a coupon against a cart (does not consume it)
router.post(
  '/validate',
  authenticate,
  validate(validateCouponSchema),
  (req, res, next) => couponController.validate(req, res, next)
);

// ── Promociones que crea el propio comercio ──
// Van antes de `/:id` para que "business" no se lea como el id de un cupón.
// El servicio fuerza quién financia, de qué negocio es y que no puede
// autoaprobarse el margen: eso no se lee de la petición.
router.get('/business/:businessId', authenticate, authorize(UserRole.BUSINESS), (req, res, next) =>
  couponController.listMine(req, res, next)
);
router.post(
  '/business/:businessId',
  authenticate,
  authorize(UserRole.BUSINESS),
  validate(businessCouponSchema),
  (req, res, next) => couponController.createMine(req, res, next)
);
router.patch(
  '/business/:id',
  authenticate,
  authorize(UserRole.BUSINESS),
  validate(updateBusinessCouponSchema),
  (req, res, next) => couponController.updateMine(req, res, next)
);
router.patch('/business/:id/deactivate', authenticate, authorize(UserRole.BUSINESS), (req, res, next) =>
  couponController.deactivateMine(req, res, next)
);
router.patch('/business/:id/reactivate', authenticate, authorize(UserRole.BUSINESS), (req, res, next) =>
  couponController.reactivateMine(req, res, next)
);
router.delete('/business/:id', authenticate, authorize(UserRole.BUSINESS), (req, res, next) =>
  couponController.deleteMine(req, res, next)
);

// Admin — CRUD
router.get('/', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.COUPONS_VIEW), (req, res, next) =>
  couponController.list(req, res, next)
);
router.get('/:id/redemptions', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.COUPONS_VIEW), (req, res, next) =>
  couponController.redemptions(req, res, next)
);
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.COUPONS_MANAGE),
  validate(createCouponSchema),
  (req, res, next) => couponController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.COUPONS_MANAGE),
  validate(updateCouponSchema),
  (req, res, next) => couponController.update(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.COUPONS_MANAGE), (req, res, next) =>
  couponController.remove(req, res, next)
);

export default router;
