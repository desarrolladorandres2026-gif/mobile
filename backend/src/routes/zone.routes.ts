import { Router } from 'express';
import { zoneController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import { createZoneSchema, updateZoneSchema, checkCoverageSchema } from '../validators';
import { UserRole } from '../types';

const router = Router();

// Public — coverage check before the customer builds a cart
router.get('/coverage', validate(checkCoverageSchema), (req, res, next) =>
  zoneController.checkCoverage(req, res, next)
);
router.get('/', (req, res, next) => zoneController.list(req, res, next));
router.get('/:id', (req, res, next) => zoneController.getById(req, res, next));

// Admin — CRUD
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(createZoneSchema),
  (req, res, next) => zoneController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(updateZoneSchema),
  (req, res, next) => zoneController.update(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), (req, res, next) =>
  zoneController.remove(req, res, next)
);

export default router;
