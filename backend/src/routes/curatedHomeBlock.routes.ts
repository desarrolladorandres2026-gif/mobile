import { Router } from 'express';
import { sendResponse } from '../utils';
import { curatedHomeBlockController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import {
  createCuratedHomeBlockSchema,
  updateCuratedHomeBlockSchema,
  curatedHomeBlockIdSchema,
} from '../validators';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// Todo admin-only: sin ruta pública propia. La app nunca pide este recurso
// directamente — `homeSections.service.ts` lo fusiona dentro de
// `/home-sections`, que es la única petición que ve el cliente.
router.use(authenticate, authorize(UserRole.ADMIN));

router.get('/options', requirePermission(Permission.CONTENT_VIEW), (req, res, next) => curatedHomeBlockController.options(req, res, next));

router.get('/order-map', requirePermission(Permission.CONTENT_VIEW), async (_req, res, next) => {
  try {
    const { homeOrderMap } = await import('../services/homeOrderMap.service');
    sendResponse(res, 200, 'Orden del inicio', await homeOrderMap());
  } catch (error) { next(error); }
});

router.get('/', requirePermission(Permission.CONTENT_VIEW), (req, res, next) => curatedHomeBlockController.list(req, res, next));
router.post('/', requirePermission(Permission.CONTENT_MANAGE), validate(createCuratedHomeBlockSchema), (req, res, next) =>
  curatedHomeBlockController.create(req, res, next)
);

router.get('/:id', requirePermission(Permission.CONTENT_VIEW), validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.get(req, res, next)
);
router.patch('/:id', requirePermission(Permission.CONTENT_MANAGE), validate(updateCuratedHomeBlockSchema), (req, res, next) =>
  curatedHomeBlockController.update(req, res, next)
);
router.patch('/:id/toggle', requirePermission(Permission.CONTENT_MANAGE), validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.toggle(req, res, next)
);
router.delete('/:id', requirePermission(Permission.CONTENT_MANAGE), validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.remove(req, res, next)
);

export default router;
