import { Router } from 'express';
import { curatedHomeBlockController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import {
  createCuratedHomeBlockSchema,
  updateCuratedHomeBlockSchema,
  curatedHomeBlockIdSchema,
} from '../validators';
import { UserRole } from '../types';

const router = Router();

// Todo admin-only: sin ruta pública propia. La app nunca pide este recurso
// directamente — `homeSections.service.ts` lo fusiona dentro de
// `/home-sections`, que es la única petición que ve el cliente.
router.use(authenticate, authorize(UserRole.ADMIN));

router.get('/options', (req, res, next) => curatedHomeBlockController.options(req, res, next));

router.get('/', (req, res, next) => curatedHomeBlockController.list(req, res, next));
router.post('/', validate(createCuratedHomeBlockSchema), (req, res, next) =>
  curatedHomeBlockController.create(req, res, next)
);

router.get('/:id', validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.get(req, res, next)
);
router.patch('/:id', validate(updateCuratedHomeBlockSchema), (req, res, next) =>
  curatedHomeBlockController.update(req, res, next)
);
router.patch('/:id/toggle', validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.toggle(req, res, next)
);
router.delete('/:id', validate(curatedHomeBlockIdSchema), (req, res, next) =>
  curatedHomeBlockController.remove(req, res, next)
);

export default router;
