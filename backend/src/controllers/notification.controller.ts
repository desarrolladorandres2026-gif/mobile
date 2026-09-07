import { Request, Response, NextFunction } from 'express';
import { notificationService } from '../services/notification.service';
import { pushService } from '../services/push.service';
import { sendResponse, param, query } from '../utils';

export class NotificationController {
  async getMyNotifications(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await notificationService.getByUser(
        req.user!._id.toString(),
        Number(query(req, 'page')) || 1,
        Number(query(req, 'limit')) || 20
      );
      sendResponse(res, 200, 'Notificaciones obtenidas', result.notifications, result.meta);
    } catch (error) { next(error); }
  }

  async getUnreadCount(req: Request, res: Response, next: NextFunction) {
    try {
      const count = await notificationService.getUnreadCount(req.user!._id.toString());
      sendResponse(res, 200, 'Contador de no leídas', { unreadCount: count });
    } catch (error) { next(error); }
  }

  async markAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const notification = await notificationService.markAsRead(
        param(req, 'id'),
        req.user!._id.toString()
      );
      if (!notification) {
        return sendResponse(res, 404, 'Notificación no encontrada');
      }
      sendResponse(res, 200, 'Notificación marcada como leída', notification);
    } catch (error) { next(error); }
  }

  async markAllAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await notificationService.markAllAsRead(req.user!._id.toString());
      sendResponse(res, 200, 'Todas las notificaciones marcadas como leídas', result);
    } catch (error) { next(error); }
  }

  /** El teléfono envía su Expo push token tras conceder el permiso. */
  async registerDevice(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, platform } = req.body ?? {};
      if (!token || typeof token !== 'string') {
        return sendResponse(res, 400, 'Token de dispositivo requerido');
      }
      await pushService.registerToken(
        req.user!._id.toString(),
        token,
        typeof platform === 'string' ? platform : 'unknown'
      );
      sendResponse(res, 200, 'Dispositivo registrado para notificaciones');
    } catch (error) { next(error); }
  }

  /** Al cerrar sesión: se deja de mandar push a este dispositivo. */
  async unregisterDevice(req: Request, res: Response, next: NextFunction) {
    try {
      const { token } = req.body ?? {};
      if (!token || typeof token !== 'string') {
        return sendResponse(res, 400, 'Token de dispositivo requerido');
      }
      await pushService.removeToken(req.user!._id.toString(), token);
      sendResponse(res, 200, 'Dispositivo dado de baja');
    } catch (error) { next(error); }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const notification = await notificationService.delete(
        param(req, 'id'),
        req.user!._id.toString()
      );
      if (!notification) {
        return sendResponse(res, 404, 'Notificación no encontrada');
      }
      sendResponse(res, 200, 'Notificación eliminada');
    } catch (error) { next(error); }
  }
}

export const notificationController = new NotificationController();
