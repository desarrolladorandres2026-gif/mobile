import { Router } from 'express';
import { homeCategoryController } from '../controllers';
import { authenticate, authorize } from '../middlewares';
import { UserRole } from '../types';
import { Permission } from '../security';
import { requirePermission, adminRequires, can } from '../middlewares/auth';

const router = Router();

// ── Público — lo consume la app en el Home. Solo lectura, solo activas ──
router.get('/', (req, res, next) => homeCategoryController.getForApp(req, res, next));

// ── Admin ────────────────────────────────────────────────────────────
router.get('/admin', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.CONTENT_VIEW), (req, res, next) =>
  homeCategoryController.list(req, res, next)
);
router.post('/upload', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.CONTENT_MANAGE), (req, res, next) =>
  homeCategoryController.upload(req, res, next)
);
router.post('/', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.CONTENT_MANAGE), (req, res, next) =>
  homeCategoryController.create(req, res, next)
);
router.put('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.CONTENT_MANAGE), (req, res, next) =>
  homeCategoryController.update(req, res, next)
);
router.delete('/:id', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.CONTENT_MANAGE), (req, res, next) =>
  homeCategoryController.remove(req, res, next)
);

export default router;
