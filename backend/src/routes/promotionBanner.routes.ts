import { Router } from 'express';
import { promotionBannerController } from '../controllers';
import { authenticate, authorize, validate } from '../middlewares';
import {
  createPromotionBannerSchema,
  updatePromotionBannerSchema,
  reorderPromotionBannersSchema,
  bannerIdSchema,
} from '../validators';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// ── Público — lo consume la app. Solo lectura, y solo lo vigente ─────
router.get('/active', (req, res, next) => promotionBannerController.getForApp(req, res, next));

// ── Admin ────────────────────────────────────────────────────────────
// Todo lo que sigue exige sesión de administrador. El cliente móvil no
// tiene forma de activar, reordenar, editar fechas ni tocar imágenes:
// ninguna de esas rutas existe sin este par de middlewares delante.
router.use(authenticate, authorize(UserRole.ADMIN));

router.get('/options', requirePermission(Permission.CONTENT_VIEW), (req, res, next) => promotionBannerController.options(req, res, next));
router.post('/upload', requirePermission(Permission.CONTENT_MANAGE), (req, res, next) => promotionBannerController.upload(req, res, next));

router.get('/', requirePermission(Permission.CONTENT_VIEW), (req, res, next) => promotionBannerController.list(req, res, next));
router.post('/', requirePermission(Permission.CONTENT_MANAGE), validate(createPromotionBannerSchema), (req, res, next) =>
  promotionBannerController.create(req, res, next)
);

// Antes de `/:id`: si no, Express leería "reorder" como un identificador.
router.patch('/reorder', requirePermission(Permission.CONTENT_MANAGE), validate(reorderPromotionBannersSchema), (req, res, next) =>
  promotionBannerController.reorder(req, res, next)
);

router.get('/:id', requirePermission(Permission.CONTENT_VIEW), validate(bannerIdSchema), (req, res, next) =>
  promotionBannerController.get(req, res, next)
);
router.patch('/:id', requirePermission(Permission.CONTENT_MANAGE), validate(updatePromotionBannerSchema), (req, res, next) =>
  promotionBannerController.update(req, res, next)
);
router.patch('/:id/toggle', requirePermission(Permission.CONTENT_MANAGE), validate(bannerIdSchema), (req, res, next) =>
  promotionBannerController.toggle(req, res, next)
);
router.delete('/:id', requirePermission(Permission.CONTENT_MANAGE), validate(bannerIdSchema), (req, res, next) =>
  promotionBannerController.remove(req, res, next)
);

export default router;
