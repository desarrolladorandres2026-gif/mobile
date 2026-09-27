import { Request, Response, NextFunction } from 'express';
import { businessSecurityService } from '../services/businessSecurity.service';
import { sendResponse, param } from '../utils';
import { toCsv, csvFilename } from '../utils/csv';

const EVENT_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'Acceso exitoso',
  LOGIN_FAILED: 'Acceso fallido',
  LOGOUT: 'Cierre de sesión',
  NEW_DEVICE: 'Nuevo dispositivo',
  NEW_IP: 'Nueva IP',
  TWO_FACTOR_SUCCESS: 'Verificación en dos pasos correcta',
  TWO_FACTOR_FAILED: 'Verificación en dos pasos fallida',
  SESSION_REVOKED: 'Sesión cerrada por el sistema',
  REMOTE_LOGOUT: 'Cierre remoto por la cuenta',
  PASSWORD_CHANGED: 'Cambio de contraseña',
  SECURITY_SETTINGS_CHANGED: 'Cambio de ajustes de seguridad',
  ADMIN_SESSION_REVOCATION: 'Revocación por administrador',
};

/**
 * Centro de seguridad de un comercio (`/admin/businesses/:id/security/*`).
 * Nada de esto es cacheable: son sesiones vivas y datos de acceso.
 */
export const adminBusinessSecurityController = {
  async summary(req: Request, res: Response, next: NextFunction) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Resumen de seguridad', await businessSecurityService.summary(param(req, 'id')));
    } catch (error) { next(error); }
  },

  async sessions(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as Record<string, any>;
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Sesiones del negocio', await businessSecurityService.sessions(param(req, 'id'), q as any));
    } catch (error) { next(error); }
  },

  async devices(req: Request, res: Response, next: NextFunction) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Dispositivos del negocio', await businessSecurityService.devices(param(req, 'id'), req.query as any));
    } catch (error) { next(error); }
  },

  async device(req: Request, res: Response, next: NextFunction) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Detalle del dispositivo', await businessSecurityService.device(param(req, 'id'), param(req, 'deviceRecordId')));
    } catch (error) { next(error); }
  },

  async events(req: Request, res: Response, next: NextFunction) {
    try {
      const { type, ...rest } = req.query as Record<string, any>;
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Historial de seguridad', await businessSecurityService.events(param(req, 'id'), { ...rest, types: type } as any));
    } catch (error) { next(error); }
  },

  async revokeSession(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await businessSecurityService.revokeSession(param(req, 'id'), param(req, 'sessionId'), req.body.reason, req.user!, req);
      sendResponse(res, 200, 'Sesión cerrada', result);
    } catch (error) { next(error); }
  },

  async revokeUserSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await businessSecurityService.revokeUserSessions(
        param(req, 'id'), param(req, 'userId'), req.body.reason, req.body.totpToken, req.user!, req
      );
      sendResponse(res, 200, `${result.revoked} sesiones cerradas`, result);
    } catch (error) { next(error); }
  },

  async revokeBusinessSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await businessSecurityService.revokeBusinessSessions(param(req, 'id'), req.body.reason, req.body.totpToken, req.user!, req);
      sendResponse(res, 200, `${result.revoked} sesiones cerradas`, result);
    } catch (error) { next(error); }
  },

  async exportEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const { reason, totpToken, type, userId, from, to } = req.body;
      const { business, events } = await businessSecurityService.exportEvents(
        param(req, 'id'), { types: type, userId, from, to }, reason, totpToken, req
      );
      type Row = (typeof events)[number];
      const body = toCsv<Row>(events, [
        { header: 'Fecha', value: (e) => new Date(e.createdAt).toISOString() },
        { header: 'Evento', value: (e) => EVENT_LABELS[e.type] ?? e.type },
        { header: 'Resultado', value: (e) => e.result },
        { header: 'Usuario', value: (e) => e.user.name },
        { header: 'Correo', value: (e) => e.user.email ?? '' },
        { header: 'Rol en el negocio', value: (e) => e.user.businessRole ?? '' },
        { header: 'IP', value: (e) => e.ip },
        { header: 'Dispositivo', value: (e) => e.deviceShortId ?? '' },
        { header: 'Navegador', value: (e) => [e.device?.browser, e.device?.browserVersion].filter(Boolean).join(' ') },
        { header: 'Sistema', value: (e) => e.device?.os ?? '' },
        { header: 'Motivo', value: (e) => e.reason ?? '' },
        { header: 'Nota del administrador', value: (e) => e.note ?? '' },
        { header: 'Responsable', value: (e) => e.actor?.name ?? '' },
      ]);
      const slug = business.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'negocio';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(`seguridad-${slug}`)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (error) { next(error); }
  },
};
