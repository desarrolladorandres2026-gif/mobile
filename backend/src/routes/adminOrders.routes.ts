import { Router } from 'express';
import { requirePermission } from '../middlewares';
import { orderNotifyRateLimiter } from '../middlewares/security';
import { Permission } from '../security';
import { adminOrdersController } from '../controllers/adminOrders.controller';

// Dueño: B4 (Fase 2 del panel admin). Rutas relativas a /admin/orders/:id; el id llega en req.params.id.
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router({ mergeParams: true });

router.get('/profile-360', requirePermission(Permission.ORDERS_VIEW_ALL), (req, res, next) =>
  adminOrdersController.profile360(req, res, next)
);
router.post('/unassign-driver', requirePermission(Permission.ORDERS_ASSIGN_DRIVER), (req, res, next) =>
  adminOrdersController.unassignDriver(req, res, next)
);
router.post('/notify', requirePermission(Permission.ORDERS_UPDATE), orderNotifyRateLimiter, (req, res, next) =>
  adminOrdersController.notify(req, res, next)
);

export default router;
