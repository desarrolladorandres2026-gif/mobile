import { Router } from 'express';
import { requirePermission, validate } from '../middlewares';
import { adminSearchRateLimiter } from '../middlewares/security';
import { Permission } from '../security';
import { adminSearchController } from '../controllers/adminSearch.controller';
import { adminSearchSchema } from '../validators/adminSearch.validator';

// /admin/search. El permiso de cada tipo se comprueba en el servicio con can().
const router = Router();

router.get(
  '/',
  requirePermission(Permission.ADMIN_PANEL),
  adminSearchRateLimiter,
  validate(adminSearchSchema),
  (req, res, next) => adminSearchController.search(req, res, next)
);

export default router;
