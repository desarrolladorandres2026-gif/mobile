import { Router } from 'express';
import { requirePermission, validate } from '../middlewares';
import { Permission } from '../security';
import { adminAlertsController as c } from '../controllers/adminAlerts.controller';
import { listAlertsSchema, markSeenSchema } from '../validators/adminAlerts.validator';

// /admin/alerts. Se monta dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN). El filtro por tipo de alerta lo aplica el
// servicio con los mismos permisos que Incidentes (INCIDENT_PERMISSION).
const router = Router();

router.get('/', requirePermission(Permission.ADMIN_PANEL), validate(listAlertsSchema), (req, res, next) => c.list(req, res, next));
router.post('/seen', requirePermission(Permission.ADMIN_PANEL), validate(markSeenSchema), (req, res, next) => c.markSeen(req, res, next));

export default router;
