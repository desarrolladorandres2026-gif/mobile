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
import { assertNotSelfTarget, assertCanModifyPrivilegedUser } from '../services/authorization.service';

export class SecurityController {
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

      // Revoke all sessions
      await Session.updateMany({ userId }, { isActive: false });

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

      const result = await Session.updateMany(
        { userId, isActive: true },
        { isActive: false }
      );

      await logAudit(req, {
        action: AuditAction.SESSION_REVOKED_ALL,
        entity: 'user',
        entityId: userId as string,
        severity: AuditSeverity.HIGH,
        description: `Todas las sesiones revocadas por admin (${result.modifiedCount})`,
      });

      sendResponse(res, 200, `${result.modifiedCount} sesiones revocadas`);
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
