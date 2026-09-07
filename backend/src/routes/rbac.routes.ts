import { Router } from 'express';
import { rbacController } from '../controllers/rbac.controller';
import { authenticate, authorize, requirePermission } from '../middlewares';
import { UserRole } from '../types';
import { Permission } from '../security';

/**
 * Seguridad y Acceso → Cargos, Roles, catálogo de Permisos.
 *
 * Todo detrás de `authenticate` + rol `admin` (tipo de cuenta) + el
 * permiso granular específico de la acción — nunca solo lo primero. Ver
 * `services/authorization.service.ts` para las guardas contra
 * escalamiento de privilegios que aplican dentro de cada servicio.
 */
const router = Router();

router.use(authenticate, authorize(UserRole.ADMIN));

// ── Catálogo de permisos (solo lectura) ──
router.get('/permissions', requirePermission(Permission.ROLES_VIEW), (req, res, next) => rbacController.getPermissions(req, res, next));

// ── Cargos ──
router.get('/positions', requirePermission(Permission.POSITIONS_VIEW), (req, res, next) => rbacController.listPositions(req, res, next));
router.get('/positions/:id', requirePermission(Permission.POSITIONS_VIEW), (req, res, next) => rbacController.getPosition(req, res, next));
router.get('/positions/:id/users', requirePermission(Permission.POSITIONS_VIEW), (req, res, next) => rbacController.getPositionUsers(req, res, next));
router.post('/positions', requirePermission(Permission.POSITIONS_CREATE), (req, res, next) => rbacController.createPosition(req, res, next));
router.patch('/positions/:id', requirePermission(Permission.POSITIONS_UPDATE), (req, res, next) => rbacController.updatePosition(req, res, next));
router.delete('/positions/:id', requirePermission(Permission.POSITIONS_DELETE), (req, res, next) => rbacController.deletePosition(req, res, next));

// ── Roles ──
router.get('/roles', requirePermission(Permission.ROLES_VIEW), (req, res, next) => rbacController.listRoles(req, res, next));
router.get('/roles/:id', requirePermission(Permission.ROLES_VIEW), (req, res, next) => rbacController.getRole(req, res, next));
router.get('/roles/:id/users', requirePermission(Permission.ROLES_VIEW), (req, res, next) => rbacController.getRoleUsers(req, res, next));
router.post('/roles', requirePermission(Permission.ROLES_CREATE), (req, res, next) => rbacController.createRole(req, res, next));
router.patch('/roles/:id', requirePermission(Permission.ROLES_UPDATE), (req, res, next) => rbacController.updateRole(req, res, next));
router.delete('/roles/:id', requirePermission(Permission.ROLES_DELETE), (req, res, next) => rbacController.deleteRole(req, res, next));

export default router;
