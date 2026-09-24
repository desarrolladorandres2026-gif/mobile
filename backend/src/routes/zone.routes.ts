import { Router } from 'express';
import { zoneController } from '../controllers';
import { authenticate, authorize, requirePermission, validate } from '../middlewares';
import {
  createZoneSchema,
  updateZoneSchema,
  deleteZoneSchema,
  zoneIdParamSchema,
  checkCoverageSchema,
} from '../validators';
import { UserRole } from '../types';
import { Permission } from '../security/rbac';

const router = Router();

// Public — coverage check before the customer builds a cart
router.get('/coverage', validate(checkCoverageSchema), (req, res, next) =>
  zoneController.checkCoverage(req, res, next)
);
router.get('/', (req, res, next) => zoneController.list(req, res, next));

// Admin — la lista completa: tarifas (pago al repartidor), prioridad y las
// zonas inactivas. Va antes de `/:id` para que "admin" no se lea como un id.
router.get(
  '/admin',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ZONES_VIEW),
  (req, res, next) => zoneController.listAdmin(req, res, next)
);

router.get('/:id', validate(zoneIdParamSchema), (req, res, next) => zoneController.getById(req, res, next));

// Admin — historial de tarifas. Solo lectura, pero la tarifa es interna.
router.get(
  '/:id/versions',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ZONES_VIEW),
  validate(zoneIdParamSchema),
  (req, res, next) => zoneController.versions(req, res, next)
);

// Admin — CRUD. Una zona cambia lo que se cobra y se paga por cada domicilio
// de su polígono (D9): cualquier escritura exige `zones:manage`, y un cambio
// de tarifa además crea una versión con motivo y autor.
router.post(
  '/',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ZONES_MANAGE),
  validate(createZoneSchema),
  (req, res, next) => zoneController.create(req, res, next)
);
router.patch(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ZONES_MANAGE),
  validate(updateZoneSchema),
  (req, res, next) => zoneController.update(req, res, next)
);
router.delete(
  '/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.ZONES_MANAGE),
  validate(deleteZoneSchema),
  (req, res, next) => zoneController.remove(req, res, next)
);

export default router;
