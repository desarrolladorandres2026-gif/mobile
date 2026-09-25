import { Router } from 'express';
import { requirePermission, validate } from '../middlewares';
import { Permission } from '../security';
import { adminBusinessesController as c } from '../controllers/adminBusinesses.controller';
import { businessIdParamSchema, setSuspensionSchema, requestDocumentsSchema } from '../validators/adminBusiness.validator';

// Dueño: B5 (Fase 2 del panel admin). Rutas relativas a /admin/businesses/:id.
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router({ mergeParams: true });

router.get('/profile-360', requirePermission(Permission.BUSINESSES_VIEW), validate(businessIdParamSchema), (req, res, next) => c.profile360(req, res, next));
router.patch('/suspension', requirePermission(Permission.BUSINESSES_UPDATE_ALL), validate(setSuspensionSchema), (req, res, next) => c.setSuspension(req, res, next));
router.post('/request-documents', requirePermission(Permission.BUSINESSES_APPROVE), validate(requestDocumentsSchema), (req, res, next) => c.requestDocuments(req, res, next));

export default router;
