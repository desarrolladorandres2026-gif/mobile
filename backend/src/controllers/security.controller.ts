import { Request, Response, NextFunction } from 'express';
import { sendResponse } from '../utils';
import {
  AuditLog, AuditAction,
  FraudAlert, FraudAlertStatus, FraudAlertType, RiskLevel,
  UserRiskProfile,
  Session,
  DeviceFingerprint,
  antiFraudService,
  logAudit,
  AuditSeverity,
} from '../security';
import { User } from '../models';
import { AppError } from '../middlewares';
import { assertNotSelfTarget, assertCanModifyPrivilegedUser, assertIsSuperAdmin } from '../services/authorization.service';
import { sessionManager, SESSION_PUBLIC_FIELDS } from '../security/sessions';

export class SecurityController {
  /**
   * Informe del modo observación: cada (usuario, permiso, ruta) que se habría
   * bloqueado con `rbac_enforce` activo. Solo Super Administrador.
   */
  async getAuthzShadow(req: Request, res: Response, next: NextFunction) {
    try {
      await assertIsSuperAdmin(req.user!, 'Solo el Super Administrador puede ver este informe');
      const raw = Number.parseInt(String(req.query.days ?? '7'), 10);
      const days = Math.min(30, Math.max(1, Number.isFinite(raw) ? raw : 7));
      const since = new Date(Date.now() - days * 86_400_000);

      const rows = await AuditLog.aggregate([
        { $match: { action: AuditAction.PERMISSION_SHADOW_DENIED, timestamp: { $gte: since } } },
        {
          $group: {
            _id: {
              userId: '$userId',
              permission: '$metadata.permission',
              route: '$metadata.route',
              method: '$metadata.method',
            },
            count: { $sum: 1 },
            firstSeen: { $min: '$timestamp' },
            lastSeen: { $max: '$timestamp' },
            roleSlugs: { $last: '$metadata.roleSlugs' },
          },
        },
        { $sort: { lastSeen: -1 } },
        { $limit: 1000 },
      ]);

      const ids = [...new Set(rows.map((r) => r._id.userId).filter(Boolean))];
      const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
      const byId = new Map(users.map((u: any) => [String(u._id), u]));

      const items = rows.map((r) => {
        const u: any = byId.get(String(r._id.userId));
        return {
          userId: r._id.userId,
          userName: u?.name ?? null,
          email: u?.email ?? null,
          roleSlugs: r.roleSlugs ?? [],
          permission: r._id.permission,
          route: r._id.route,
          method: r._id.method,
          count: r.count,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
        };
      });

      const { RBAC_ENFORCE_FLAG } = await import('../services/authorization.service');
      sendResponse(res, 200, 'Informe del modo observación', {
        mode: req.authz?.mode ?? 'observe',
        enforceFlag: RBAC_ENFORCE_FLAG,
        days,
        items,
      });
    } catch (error) { next(error); }
  }

  // ── Audit Logs ──

  async getAuditLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        page = '1',
        limit = '50',
        userId,
        action,
        severity,
        entity,
        startDate,
        endDate,
      } = req.query as Record<string, string>;

      const query: any = {};
      if (userId) query.userId = userId;
      if (action) query.action = action;
      if (severity) query.severity = severity;
      if (entity) query.entity = entity;

      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [logs, total] = await Promise.all([
        AuditLog.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        AuditLog.countDocuments(query),
      ]);

      sendResponse(res, 200, 'Logs de auditoría', {
        logs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) { next(error); }
  }

  async getAuditActions(_req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Acciones de auditoría', {
        actions: Object.values(AuditAction),
      });
    } catch (error) { next(error); }
  }

  // ── Fraud Alerts ──

  async getFraudAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        page = '1',
        limit = '20',
        status,
        riskLevel,
        type,
        userId,
      } = req.query as Record<string, string>;

      const result = await antiFraudService.getAlerts({
        status: status as FraudAlertStatus,
        riskLevel: riskLevel as RiskLevel,
        type: type as FraudAlertType,
        userId,
        page: parseInt(page),
        limit: parseInt(limit),
      });

      sendResponse(res, 200, 'Alertas antifraude', {
        alerts: result.alerts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.total,
          pages: Math.ceil(result.total / parseInt(limit)),
        },
      });
    } catch (error) { next(error); }
  }

  async resolveFraudAlert(req: Request, res: Response, next: NextFunction) {
    try {
      const alertId = req.params.alertId as string;
      const { actionTaken, status } = req.body;

      const alert = await antiFraudService.resolveAlert(
        alertId,
        req.user!._id.toString(),
        actionTaken,
        status || FraudAlertStatus.RESOLVED
      );

      if (!alert) {
        return sendResponse(res, 404, 'Alerta no encontrada');
      }

      await logAudit(req, {
        action: AuditAction.FRAUD_ALERT,
        entity: 'fraud_alert',
        entityId: alertId as string,
        severity: AuditSeverity.HIGH,
        description: `Alerta de fraude resuelta: ${actionTaken}`,
      });

      sendResponse(res, 200, 'Alerta resuelta', { alert });
    } catch (error) { next(error); }
  }

  async getFraudStats(_req: Request, res: Response, next: NextFunction) {
    try {
      const [
        totalAlerts,
        openAlerts,
        criticalAlerts,
        blockedUsers,
        recentAlerts,
      ] = await Promise.all([
        FraudAlert.countDocuments(),
        FraudAlert.countDocuments({ status: FraudAlertStatus.OPEN }),
        FraudAlert.countDocuments({
          status: FraudAlertStatus.OPEN,
          riskLevel: { $in: [RiskLevel.HIGH, RiskLevel.CRITICAL] },
        }),
        UserRiskProfile.countDocuments({ isBlocked: true }),
        FraudAlert.find({ status: FraudAlertStatus.OPEN })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean(),
      ]);

      sendResponse(res, 200, 'Estadísticas de fraude', {
        totalAlerts,
        openAlerts,
        criticalAlerts,
        blockedUsers,
        recentAlerts,
      });
    } catch (error) { next(error); }
  }

  // ── Blocked Users ──

  async getBlockedUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = '1', limit = '20' } = req.query as Record<string, string>;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [profiles, total] = await Promise.all([
        UserRiskProfile.find({ isBlocked: true })
          .sort({ blockedAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        UserRiskProfile.countDocuments({ isBlocked: true }),
      ]);

      // Enrich with user data
      const userIds = profiles.map((p) => p.userId);
      const users = await User.find({ _id: { $in: userIds } }).lean();
      const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

      const enriched = profiles.map((p) => ({
        ...p,
        user: userMap.get(p.userId) || null,
      }));

      sendResponse(res, 200, 'Usuarios bloqueados', {
        blockedUsers: enriched,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) { next(error); }
  }

  async unblockUser(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;
      await assertIsSuperAdmin(req.user!, 'Solo el Super Administrador puede desbloquear usuarios');
      assertNotSelfTarget(req.user!._id.toString(), userId, 'No puedes desbloquear tu propia cuenta');
      const targetUser = await User.findById(userId);
      if (!targetUser) throw new AppError('Usuario no encontrado', 404);
      await assertCanModifyPrivilegedUser(req.user!, targetUser);

      const profile = await UserRiskProfile.findOneAndUpdate(
        { userId },
        {
          isBlocked: false,
          blockedReason: undefined,
          blockedAt: undefined,
          riskScore: 0,
          riskLevel: RiskLevel.LOW,
        },
        { new: true }
      );

      if (!profile) {
        return sendResponse(res, 404, 'Perfil de riesgo no encontrado');
      }

      // Reactivate user
      await User.findByIdAndUpdate(userId, { isActive: true, isBlocked: false });

      await logAudit(req, {
        action: AuditAction.USER_UNBLOCKED,
        entity: 'user',
        entityId: userId as string,
        severity: AuditSeverity.HIGH,
        description: `Usuario desbloqueado por admin`,
      });

      sendResponse(res, 200, 'Usuario desbloqueado', { profile });
    } catch (error) { next(error); }
  }

  async blockUser(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;
      const { reason } = req.body;
      await assertIsSuperAdmin(req.user!, 'Solo el Super Administrador puede bloquear usuarios');
      assertNotSelfTarget(req.user!._id.toString(), userId, 'No puedes bloquear tu propia cuenta');
      const targetUser = await User.findById(userId);
      if (!targetUser) throw new AppError('Usuario no encontrado', 404);
      await assertCanModifyPrivilegedUser(req.user!, targetUser);

      let profile = await UserRiskProfile.findOne({ userId });
      if (!profile) {
        profile = await UserRiskProfile.create({
          userId,
          isBlocked: true,
          blockedReason: reason || 'Bloqueado por administrador',
          blockedAt: new Date(),
          riskScore: 100,
          riskLevel: RiskLevel.CRITICAL,
        });
      } else {
        profile.isBlocked = true;
        profile.blockedReason = reason || 'Bloqueado por administrador';
        profile.blockedAt = new Date();
        await profile.save();
      }

      // Deactivate user
      await User.findByIdAndUpdate(userId, { isActive: false, isBlocked: true });

      // S6: `Session.updateMany` solo apagaba el flag en la base — el
      // socket ya abierto seguía vivo y un domiciliario bloqueado seguía
      // emitiendo ubicación y estado. `sessionManager.revokeAllSessions`
      // marca las sesiones Y desconecta sus sockets (`session:<id>`).
      await sessionManager.revokeAllSessions(userId, { reason: 'admin' });

      await logAudit(req, {
        action: AuditAction.USER_BLOCKED,
        entity: 'user',
        entityId: userId as string,
        severity: AuditSeverity.CRITICAL,
        description: `Usuario bloqueado: ${reason || 'Sin razón especificada'}`,
      });

      sendResponse(res, 200, 'Usuario bloqueado', { profile });
    } catch (error) { next(error); }
  }

  // ── Active Sessions ──

  async getAllActiveSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = '1', limit = '50', userId } = req.query as Record<string, string>;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const query: any = { isActive: true };
      if (userId) query.userId = userId;

      const [sessions, total] = await Promise.all([
        Session.find(query)
          .select(SESSION_PUBLIC_FIELDS)
          .sort({ lastActivity: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        Session.countDocuments(query),
      ]);

      sendResponse(res, 200, 'Sesiones activas', {
        sessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) { next(error); }
  }

  async revokeUserSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;

      await assertIsSuperAdmin(req.user!, 'Solo el Super Administrador puede revocar las sesiones de otro usuario');
      // S12: sin guardas, cualquiera con `security:manage` podía cerrar las
      // sesiones del propio Super Administrador o de sí mismo. Misma pareja
      // de comprobaciones que `blockUser`.
      assertNotSelfTarget(req.user!._id.toString(), userId, 'No puedes revocar tus propias sesiones por aquí');
      const targetUser = await User.findById(userId);
      if (!targetUser) throw new AppError('Usuario no encontrado', 404);
      await assertCanModifyPrivilegedUser(req.user!, targetUser);

      // S6: revoca Y desconecta los sockets abiertos con esas sesiones.
      const revoked = await sessionManager.revokeAllSessions(userId, { reason: 'admin' });

      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED_ALL,
        entity: 'user',
        entityId: userId as string,
        severity: AuditSeverity.HIGH,
        description: `Todas las sesiones revocadas por admin (${revoked})`,
      });

      sendResponse(res, 200, `${revoked} sesiones revocadas`);
    } catch (error) { next(error); }
  }

  // ── Registered Devices ──

  async getRegisteredDevices(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.query as Record<string, string>;

      const query: any = {};
      if (userId) query.userId = userId;

      const devices = await DeviceFingerprint.find(query)
        .sort({ lastSeen: -1 })
        .limit(100)
        .lean();

      sendResponse(res, 200, 'Dispositivos registrados', { devices });
    } catch (error) { next(error); }
  }

  // ── Security Dashboard Stats ──

  async getSecurityDashboard(_req: Request, res: Response, next: NextFunction) {
    try {
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [
        totalActiveSessions,
        loginSuccessLast24h,
        loginFailedLast24h,
        openFraudAlerts,
        criticalFraudAlerts,
        blockedUsers,
        newDevicesLast24h,
        bruteForceAttemptsLast24h,
        totalUsersWithTOTP,
        recentSecurityEvents,
      ] = await Promise.all([
        Session.countDocuments({ isActive: true }),
        AuditLog.countDocuments({ action: AuditAction.LOGIN_SUCCESS, timestamp: { $gte: last24h } }),
        AuditLog.countDocuments({ action: AuditAction.LOGIN_FAILED, timestamp: { $gte: last24h } }),
        FraudAlert.countDocuments({ status: FraudAlertStatus.OPEN }),
        FraudAlert.countDocuments({
          status: FraudAlertStatus.OPEN,
          riskLevel: { $in: [RiskLevel.HIGH, RiskLevel.CRITICAL] },
        }),
        UserRiskProfile.countDocuments({ isBlocked: true }),
        AuditLog.countDocuments({ action: AuditAction.NEW_DEVICE_DETECTED, timestamp: { $gte: last24h } }),
        AuditLog.countDocuments({ action: AuditAction.BRUTE_FORCE_DETECTED, timestamp: { $gte: last24h } }),
        User.countDocuments({ twoFactorEnabled: true }),
        AuditLog.find({
          severity: { $in: ['high', 'critical'] },
          timestamp: { $gte: last7d },
        })
          .sort({ timestamp: -1 })
          .limit(20)
          .lean(),
      ]);

      sendResponse(res, 200, 'Dashboard de seguridad', {
        overview: {
          totalActiveSessions,
          loginSuccessLast24h,
          loginFailedLast24h,
          openFraudAlerts,
          criticalFraudAlerts,
          blockedUsers,
          newDevicesLast24h,
          bruteForceAttemptsLast24h,
          totalUsersWithTOTP,
        },
        recentSecurityEvents,
      });
    } catch (error) { next(error); }
  }

  // ── User Risk Profile ──

  async getUserRiskProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;

      const profile = await antiFraudService.assessUserRisk(userId);
      const alerts = await FraudAlert.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      const user = await User.findById(userId).lean();

      sendResponse(res, 200, 'Perfil de riesgo', {
        profile,
        alerts,
        user,
      });
    } catch (error) { next(error); }
  }
}

export const securityController = new SecurityController();
