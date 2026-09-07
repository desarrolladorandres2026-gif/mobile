import { Router } from 'express';
import { advertisementController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import { createAdvertisementSchema, updateAdvertisementSchema, adEventSchema } from '../validators';
import { UserRole } from '../types';

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
