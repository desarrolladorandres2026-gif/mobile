import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { param, sendResponse } from '../utils';
import { AppError } from '../middlewares';
import { can } from '../middlewares/auth';
import { Permission, logAudit, AuditAction, AuditSeverity } from '../security';
import { Order } from '../models';
import { orderService } from '../services/order.service';
import { internalNoteService } from '../services/internalNote.service';
import { orderProfile360Service } from '../services/orderProfile360.service';
import { emitToAdmin } from '../sockets/emitter';

export const unassignBodySchema = z.object({
  reason: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(300, 'Máximo 300 caracteres'),
  redispatch: z.boolean().optional().default(true),
});

export const notifyBodySchema = z.object({
  audience: z.enum(['client', 'business', 'driver']),
  template: z.enum(['status', 'driver_assigned', 'delayed']),
});

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError(r.error.errors[0]?.message ?? 'Datos inválidos', 400);
  return r.data;
}

export class AdminOrdersController {
  async profile360(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = param(req, 'id');
      const data = await orderProfile360Service.profile360({
        orderId,
        user: req.user!,
        has: (p: Permission) => can(req, p),
        noteActor: await internalNoteService.noteActorFromRequest(req),
      });
      void logAudit(req, {
        action: AuditAction.PROFILE_VIEWED,
        entity: 'order',
        entityId: orderId,
        severity: AuditSeverity.LOW,
        description: 'Ficha 360 de pedido consultada',
      });
      sendResponse(res, 200, 'Ficha del pedido', data);
    } catch (error) { next(error); }
  }

  async paymentRefs(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = param(req, 'id');
      const data = await orderProfile360Service.paymentRefs(orderId);
      void logAudit(req, {
        action: AuditAction.PROFILE_VIEWED,
        entity: 'order',
        entityId: orderId,
        severity: AuditSeverity.LOW,
        description: 'Referencias de pago del pedido consultadas',
      });
      sendResponse(res, 200, 'Referencias de pago', data);
    } catch (error) { next(error); }
  }

  async unassignDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = param(req, 'id');
      const { reason, redispatch } = parseBody(unassignBodySchema, req.body);
      const before = await Order.findById(orderId).select('driverId').lean();
      if (!before) throw new AppError('Pedido no encontrado', 404);
      const previousDriverId = before.driverId ? String(before.driverId) : null;

      const released = await orderService.unassignDriver(orderId, reason, {
        userId: req.user!._id.toString(),
        role: req.user!.role,
      });
      if (!released) {
        throw new AppError('No se puede desasignar: el pedido no tiene domiciliario o ya fue recogido', 409);
      }

      // Al domiciliario ya le avisa `orderService.unassignDriver` (socket y push).
      const payload = { orderId, orderNumber: released.orderNumber, driverId: previousDriverId, reason };
      emitToAdmin(req.app.get('io'), 'orders', 'order:driver:unassigned', payload);

      if (redispatch) {
        const { startDispatch } = await import('../services/dispatch.service');
        await startDispatch(orderId).catch((e) => console.error('[AdminOrders] startDispatch:', e));
      }
      sendResponse(res, 200, 'Domiciliario desasignado', { orderId, status: released.status, redispatch });
    } catch (error) { next(error); }
  }

  async notify(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = param(req, 'id');
      const { audience, template } = parseBody(notifyBodySchema, req.body);
      const result = await orderProfile360Service.resendNotification(orderId, audience, template);
      void logAudit(req, {
        action: AuditAction.ORDER_NOTIFICATION_RESENT,
        entity: 'order',
        entityId: orderId,
        severity: AuditSeverity.LOW,
        description: `Aviso reenviado (${template}) a ${audience}`,
        metadata: { audience, template },
      });
      sendResponse(res, 200, 'Aviso reenviado', result);
    } catch (error) { next(error); }
  }
}

export const adminOrdersController = new AdminOrdersController();
