import { Router } from 'express';
import { couponController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import { validateCouponSchema, createCouponSchema, updateCouponSchema } from '../validators';
import { UserRole } from '../types';
import { z } from 'zod';

const router = Router();

// Public — promotions shown in the app
router.get('/public', (req, res, next) => couponController.getPublic(req, res, next));

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
const businessCouponSchema = z.object({
  body: z.object({
    code: z.string().trim().min(3).max(20),
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().max(200).optional(),
    type: z.enum(['percentage', 'fixed', 'free_delivery']),
    scope: z.enum(['product', 'delivery']).optional(),
    value: z.number().min(0),
    maxDiscount: z.number().min(0).optional(),
    minOrderAmount: z.number().min(0).optional(),
    budgetLimit: z.number().min(0).optional(),
    usageLimit: z.number().int().min(0).optional(),
    perUserLimit: z.number().int().min(0).optional(),
    firstOrderOnly: z.boolean().optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date(),
    isPublic: z.boolean().optional(),
  }),
});

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
router.patch('/business/:id/deactivate', authenticate, authorize(UserRole.BUSINESS), (req, res, next) =>
  couponController.deactivateMine(req, res, next)
);

// Admin — CRUD
router.get('/', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  couponController.list(req, res, next)
);
router.get('/:id/redemptions', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  couponController.redemptions(req, res, next)
);
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(createCouponSchema),
  (req, res, next) => couponController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(updateCouponSchema),
  (req, res, next) => couponController.update(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  couponController.remove(req, res, next)
);

export default router;
