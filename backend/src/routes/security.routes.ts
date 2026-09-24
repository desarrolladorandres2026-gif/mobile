import { Router } from 'express';
import { securityController } from '../controllers/security.controller';
import { authenticate, authorize, requirePermission } from '../middlewares';
import { can, requireRole } from '../middlewares/auth';
import { UserRole } from '../types';
import { Permission, SUPER_ADMIN_ROLE_SLUG } from '../security';

const router = Router();

// All security routes require authentication + admin role
router.use(authenticate);
router.use(authorize(UserRole.ADMIN));

// ── Security Dashboard ──
router.get(
  '/dashboard',
  requirePermission(Permission.SECURITY_VIEW),
  (req, res, next) => securityController.getSecurityDashboard(req, res, next)
);

// ── Audit Logs ──
router.get(
  '/audit-logs',
  requirePermission(Permission.ADMIN_AUDIT_LOGS),
  (req, res, next) => securityController.getAuditLogs(req, res, next)
);
router.get(
  '/audit-actions',
  requirePermission(Permission.ADMIN_AUDIT_LOGS),
  (req, res, next) => securityController.getAuditActions(req, res, next)
);

// ── Fraud Alerts ──
router.get(
  '/fraud-alerts',
  requirePermission(Permission.FRAUD_ALERTS_VIEW),
  (req, res, next) => securityController.getFraudAlerts(req, res, next)
);
router.get(
  '/fraud-stats',
  requirePermission(Permission.FRAUD_ALERTS_VIEW),
  (req, res, next) => securityController.getFraudStats(req, res, next)
);
router.patch(
  '/fraud-alerts/:alertId/resolve',
  requirePermission(Permission.FRAUD_ALERTS_MANAGE),
  (req, res, next) => securityController.resolveFraudAlert(req, res, next)
);

// ── Blocked Users ──
router.get(
  '/blocked-users',
  requirePermission(Permission.SECURITY_MANAGE),
  (req, res, next) => securityController.getBlockedUsers(req, res, next)
);
router.post(
  '/block-user/:userId',
  requirePermission(Permission.USERS_BLOCK),
  (req, res, next) => securityController.blockUser(req, res, next)
);
router.post(
  '/unblock-user/:userId',
  requirePermission(Permission.USERS_BLOCK),
  (req, res, next) => securityController.unblockUser(req, res, next)
);

// ── Sessions ──
router.get(
  '/sessions',
  requirePermission(Permission.SECURITY_VIEW),
  (req, res, next) => securityController.getAllActiveSessions(req, res, next)
);
router.delete(
  '/sessions/user/:userId',
  requirePermission(Permission.SECURITY_MANAGE),
  (req, res, next) => securityController.revokeUserSessions(req, res, next)
);

// ── Devices ──
router.get(
  '/devices',
  requirePermission(Permission.SECURITY_VIEW),
  (req, res, next) => securityController.getRegisteredDevices(req, res, next)
);

// ── User Risk ──
router.get(
  '/risk-profile/:userId',
  requirePermission(Permission.SECURITY_VIEW),
  (req, res, next) => securityController.getUserRiskProfile(req, res, next)
);

// ── Centro de incidentes ──
//
// Nada de esto es nuevo: alertas de fraude, faltantes de efectivo, botones
// de pánico, reclamos y pedidos detenidos ya existían, pero en cinco
// pantallas distintas. Nadie mira cinco pantallas a la vez, así que en la
// práctica se miraba una y las otras cuatro acumulaban.
router.get('/incidents', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADMIN_PANEL), async (req, res, next) => {
  try {
    const { incidentCenterService } = await import('../services/incidentCenter.service');
    const { sendResponse } = await import('../utils');
    sendResponse(res, 200, 'Incidentes abiertos', await incidentCenterService.open((p) => can(req, p)));
  } catch (error) { next(error); }
});

router.get('/incidents/summary', authenticate, authorize(UserRole.ADMIN), requirePermission(Permission.ADMIN_PANEL), async (req, res, next) => {
  try {
    const { incidentCenterService } = await import('../services/incidentCenter.service');
    const { sendResponse } = await import('../utils');
    sendResponse(res, 200, 'Resumen de incidentes', await incidentCenterService.summary((p) => can(req, p)));
  } catch (error) { next(error); }
});

// ── Informe del modo observación (Fase 1): a quién se le bloquearía qué ──
router.get('/authz-shadow', requireRole(SUPER_ADMIN_ROLE_SLUG), (req, res, next) =>
  securityController.getAuthzShadow(req, res, next)
);

export default router;
