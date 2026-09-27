import { Router } from 'express';
import { requirePermission, validate, securityCenterActionRateLimiter } from '../middlewares';
import { Permission } from '../security';
import { adminBusinessesController as c } from '../controllers/adminBusinesses.controller';
import { adminBusinessSecurityController as sec } from '../controllers/adminBusinessSecurity.controller';
import { businessIdParamSchema, setSuspensionSchema, requestDocumentsSchema } from '../validators/adminBusiness.validator';
import {
  businessSecuritySummarySchema,
  businessSecuritySessionsSchema,
  businessSecurityDevicesSchema,
  businessSecurityDeviceSchema,
  businessSecurityEventsSchema,
  businessSecurityRevokeSessionSchema,
  businessSecurityRevokeUserSchema,
  businessSecurityRevokeAllSchema,
  businessSecurityExportSchema,
} from '../validators/businessSecurity.validator';

// Dueño: B5 (Fase 2 del panel admin). Rutas relativas a /admin/businesses/:id.
// Se monta con router.use() dentro de admin.routes.ts, así que hereda
// authenticate + authorize(ADMIN); cada handler añade su requirePermission.
const router = Router({ mergeParams: true });

router.get('/profile-360', requirePermission(Permission.BUSINESSES_VIEW), validate(businessIdParamSchema), (req, res, next) => c.profile360(req, res, next));
router.patch('/suspension', requirePermission(Permission.BUSINESSES_UPDATE_ALL), validate(setSuspensionSchema), (req, res, next) => c.setSuspension(req, res, next));
router.post('/request-documents', requirePermission(Permission.BUSINESSES_APPROVE), validate(requestDocumentsSchema), (req, res, next) => c.requestDocuments(req, res, next));

// ── Centro de seguridad del comercio ──
//
// Ver: `security:view` (+ `businesses:view`). Cerrar sesiones:
// `security:manage` y un motivo; cerrar las de una persona o las del negocio
// entero pide además un TOTP (decisión del 2026-09-26, que relaja la S12 solo
// para cuentas de comercio: las cuentas admin siguen fuera de alcance aquí).
// El CSV lleva datos personales: Super Administrador, motivo y TOTP.
const view = requirePermission(Permission.SECURITY_VIEW, Permission.BUSINESSES_VIEW);
const manage = requirePermission(Permission.SECURITY_MANAGE, Permission.BUSINESSES_VIEW);

router.get('/security/summary', view, validate(businessSecuritySummarySchema), (req, res, next) => sec.summary(req, res, next));
router.get('/security/sessions', view, validate(businessSecuritySessionsSchema), (req, res, next) => sec.sessions(req, res, next));
router.get('/security/devices', view, validate(businessSecurityDevicesSchema), (req, res, next) => sec.devices(req, res, next));
router.get('/security/devices/:deviceRecordId', view, validate(businessSecurityDeviceSchema), (req, res, next) => sec.device(req, res, next));
router.get('/security/events', view, validate(businessSecurityEventsSchema), (req, res, next) => sec.events(req, res, next));
router.post('/security/sessions/:sessionId/revoke', manage, securityCenterActionRateLimiter, validate(businessSecurityRevokeSessionSchema), (req, res, next) => sec.revokeSession(req, res, next));
router.post('/security/users/:userId/revoke-all', manage, securityCenterActionRateLimiter, validate(businessSecurityRevokeUserSchema), (req, res, next) => sec.revokeUserSessions(req, res, next));
router.post('/security/revoke-all', manage, securityCenterActionRateLimiter, validate(businessSecurityRevokeAllSchema), (req, res, next) => sec.revokeBusinessSessions(req, res, next));
router.post('/security/export', view, securityCenterActionRateLimiter, validate(businessSecurityExportSchema), (req, res, next) => sec.exportEvents(req, res, next));

export default router;
