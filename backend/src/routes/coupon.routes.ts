import { Router } from 'express';
import { couponController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import { validateCouponSchema, createCouponSchema, updateCouponSchema } from '../validators';
import { UserRole } from '../types';

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
