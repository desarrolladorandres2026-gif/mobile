import { Router } from 'express';
import { exploreLayoutController } from '../controllers/exploreLayout.controller';
import { authenticate, authorize, requirePermission, validate, exploreLayoutPreviewRateLimiter } from '../middlewares';
import { Permission } from '../security/rbac';
import { UserRole } from '../types';
import {
  saveExploreDraftSchema,
  previewExploreLayoutSchema,
  publishExploreLayoutSchema,
  restoreExploreVersionSchema,
} from '../validators/exploreLayout.validator';

/**
 * El constructor de Explorar. Todo por permiso y no por tipo de cuenta:
 * ver el borrador y previsualizar es `explore:view`; guardar, publicar y
 * restaurar es `explore:manage`. El panel oculta los botones, pero quien
 * decide es esto. Además `authorize(ADMIN)`: `requirePermission` no mira el
 * tipo de cuenta, y una cuenta no admin con permisos heredados no debe pasar.
 */
const router = Router();

router.use(authenticate, authorize(UserRole.ADMIN));

router.get('/options', requirePermission(Permission.EXPLORE_VIEW), (req, res, next) =>
  exploreLayoutController.options(req, res, next)
);
router.get('/draft', requirePermission(Permission.EXPLORE_VIEW), (req, res, next) =>
  exploreLayoutController.getDraft(req, res, next)
);
router.put(
  '/draft',
  requirePermission(Permission.EXPLORE_MANAGE),
  validate(saveExploreDraftSchema),
  (req, res, next) => exploreLayoutController.saveDraft(req, res, next)
);
router.post(
  '/preview',
  requirePermission(Permission.EXPLORE_VIEW),
  exploreLayoutPreviewRateLimiter,
  validate(previewExploreLayoutSchema),
  (req, res, next) => exploreLayoutController.preview(req, res, next)
);
router.post(
  '/publish',
  requirePermission(Permission.EXPLORE_MANAGE),
  validate(publishExploreLayoutSchema),
  (req, res, next) => exploreLayoutController.publish(req, res, next)
);
router.get('/versions', requirePermission(Permission.EXPLORE_VIEW), (req, res, next) =>
  exploreLayoutController.listVersions(req, res, next)
);
router.post(
  '/versions/:version/restore',
  requirePermission(Permission.EXPLORE_MANAGE),
  validate(restoreExploreVersionSchema),
  (req, res, next) => exploreLayoutController.restore(req, res, next)
);

export default router;
