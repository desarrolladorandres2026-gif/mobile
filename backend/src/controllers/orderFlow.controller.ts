import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middlewares';
import { uploadEvidenceImage } from '../middlewares/upload';
import { sendResponse, param, query, clientIp, userAgent, readLocation } from '../utils';
import {
  OrderCallStatus,
  OrderCodeKind,
  OrderEvidenceType,
  OrderStatus,
  OrderTimelineAction,
  UserRole,
} from '../types';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import {
  resolveOrderAccess,
  assertParticipant,
  getOrderParticipants,
  OrderAccess,
} from '../services/orderAccess.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderChatService } from '../services/orderChat.service';
import { orderCallService } from '../services/orderCall.service';
import { orderService, notificationService, paymentService } from '../services';
import { orderTimelineService } from '../services/orderTimeline.service';
import { User } from '../models';

export class OrderFlowController {
  // ── Estado agregado del flujo ──────────────────────────────────────

  /**
   * Todo lo que la pantalla del pedido necesita, en una sola llamada.
   *
   * Cada parte recibe únicamente lo suyo: el mismo endpoint le da al
   * cliente su código de entrega, al comercio el de recogida y al
   * domiciliario ninguno de los dos. La app no decide qué ocultar —recibe
   * ya solo lo que puede ver—, que es la única forma de que un cambio en
   * la interfaz no pueda convertirse en una fuga.
   */
  async getState(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const order = access.order;

      const [security, evidences, unread, activeCall, participants] = await Promise.all([
        orderSecurityService.viewFor(access).catch(() => null),
        orderEvidenceService.listForOrder(access),
        access.participant === 'client' || access.participant === 'driver'
          ? orderChatService.unreadCount(access)
          : Promise.resolve(0),
        orderCallService.current(access).catch(() => null),
        getOrderParticipants(order),
      ]);

      const evidenceOf = (type: OrderEvidenceType) =>
        evidences.find((evidence) => evidence.type === type) ?? null;

      sendResponse(res, 200, 'Estado del pedido', {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        participant: access.participant,
        pickup: {
          arrivedAt: security?.pickup.arrivedAt ?? null,
          codeStatus: security?.pickup.status ?? null,
          attempts: security?.pickup.attempts ?? 0,
          lockedUntil: security?.pickup.lockedUntil ?? null,
          verifiedAt: security?.pickup.usedAt ?? null,
          code: security?.pickupCode ?? null,
          evidence: evidenceOf(OrderEvidenceType.PICKUP),
        },
        delivery: {
          arrivedAt: security?.delivery.arrivedAt ?? null,
          codeStatus: security?.delivery.status ?? null,
          attempts: security?.delivery.attempts ?? 0,
          lockedUntil: security?.delivery.lockedUntil ?? null,
          verifiedAt: security?.delivery.usedAt ?? null,
          code: security?.deliveryCode ?? null,
          evidence: evidenceOf(OrderEvidenceType.DELIVERY),
        },
        chat: {
          available: orderChatService.isOpen(access),
          unread,
        },
        call: {
          available: orderCallService.isAvailable(access),
          active: activeCall,
        },
        counterpart: await this.describeCounterpart(access, participants),
      });
    } catch (error) { next(error); }
  }

  /** Con quién habla cada parte. Nombre y foto; nunca el teléfono. */
  private async describeCounterpart(
    access: OrderAccess,
    participants: Awaited<ReturnType<typeof getOrderParticipants>>
  ) {
    const targetId =
      access.participant === 'client'
        ? participants.driverUserId
        : access.participant === 'driver'
          ? participants.clientUserId
          : null;

    if (!targetId) return null;

    const user = await User.findById(targetId).select('name avatar');
    if (!user) return null;

    return {
      userId: user._id.toString(),
      name: user.name,
      avatar: user.avatar ?? null,
      role: access.participant === 'client' ? UserRole.DRIVER : UserRole.CLIENT,
    };
  }

  // ── Llegadas ───────────────────────────────────────────────────────

  async arriveAtStore(req: Request, res: Response, next: NextFunction) {
    return this.registerArrival(req, res, next, OrderCodeKind.PICKUP);
  }

  async arriveAtCustomer(req: Request, res: Response, next: NextFunction) {
    return this.registerArrival(req, res, next, OrderCodeKind.DELIVERY);
  }

  private async registerArrival(
    req: Request,
    res: Response,
    next: NextFunction,
    kind: OrderCodeKind
  ) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const arrivedAt = await orderSecurityService.markArrival(access, kind);
      const order = access.order;
      const participants = await getOrderParticipants(order);

      const io = req.app.get('io');
      const payload = {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        stage: kind,
        arrivedAt,
      };

      if (kind === OrderCodeKind.PICKUP) {
        io?.to(`business:${participants.businessId}`).emit('order:driver:arrived', payload);
        if (participants.businessOwnerId) {
          io?.to(`user:${participants.businessOwnerId}`).emit('order:driver:arrived', payload);
          notificationService
            .notifyDriverArrivedAtStore(
              participants.businessOwnerId,
              order._id.toString(),
              order.orderNumber,
              req.user!.name
            )
            .catch(console.error);
        }
      } else {
        io?.to(`user:${participants.clientUserId}`).emit('order:driver:arrived', payload);
        notificationService
          .notifyDriverArrivedAtCustomer(participants.clientUserId, order._id.toString(), order.orderNumber)
          .catch(console.error);
      }

      io?.to('admin').emit('order:driver:arrived', payload);

      orderTimelineService
        .record(
          order._id.toString(),
          kind === OrderCodeKind.PICKUP
            ? OrderTimelineAction.ARRIVED_PICKUP
            : OrderTimelineAction.ARRIVED_DELIVERY,
          { userId: access.userId, role: access.participant },
          {
            ip: clientIp(req),
            userAgent: userAgent(req),
            location: readLocation(req.body) ?? undefined,
          }
        )
        .catch(console.error);

      sendResponse(res, 200, 'Llegada registrada', { stage: kind, arrivedAt });
    } catch (error) { next(error); }
  }

  // ── Evidencias ─────────────────────────────────────────────────────

  async uploadPickupEvidence(req: Request, res: Response, next: NextFunction) {
    return this.uploadEvidence(req, res, next, OrderEvidenceType.PICKUP);
  }

  async uploadDeliveryEvidence(req: Request, res: Response, next: NextFunction) {
    return this.uploadEvidence(req, res, next, OrderEvidenceType.DELIVERY);
  }

  private uploadEvidence(
    req: Request,
    res: Response,
    next: NextFunction,
    type: OrderEvidenceType
  ) {
    // multer se ejecuta aquí dentro y no como middleware de ruta a
    // propósito: así el control de acceso al pedido ocurre *después* de
    // rechazar formatos y tamaños, pero antes de tocar Cloudinary, y un
    // desconocido no puede hacernos subir imágenes a pedidos ajenos.
    uploadEvidenceImage(req, res, async (err: unknown) => {
      try {
        if (err) {
          throw new AppError(
            err instanceof Error ? err.message : 'No se pudo procesar la imagen',
            400,
            'EVIDENCE_INVALID_FILE'
          );
        }
        if (!req.file) throw new AppError('Adjunta una foto', 400, 'EVIDENCE_INVALID_FILE');

        const access = await resolveOrderAccess(param(req, 'id'), req.user!);
        const evidence = await orderEvidenceService.upload({
          access,
          type,
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          location: readLocation(req.body),
        });

        logAudit(req, {
          action: AuditAction.ORDER_EVIDENCE_UPLOADED,
          entity: 'order',
          entityId: access.order._id.toString(),
          severity: AuditSeverity.LOW,
          description: `Evidencia ${type} registrada`,
          metadata: { evidenceId: evidence.id, type },
        }).catch(console.error);

        orderTimelineService
          .record(
            access.order._id.toString(),
            type === OrderEvidenceType.PICKUP
              ? OrderTimelineAction.EVIDENCE_PICKUP
              : OrderTimelineAction.EVIDENCE_DELIVERY,
            { userId: access.userId, role: access.participant },
            {
              ip: clientIp(req),
              userAgent: userAgent(req),
              newValue: { evidenceId: evidence.id, checksum: evidence.metadata.checksum },
            }
          )
          .catch(console.error);

        sendResponse(res, 201, 'Evidencia registrada', evidence);
      } catch (error) { next(error); }
    });
  }

  async listEvidence(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const evidences = await orderEvidenceService.listForOrder(access);

      if (access.participant === 'admin') {
        logAudit(req, {
          action: AuditAction.ORDER_EVIDENCE_VIEWED,
          entity: 'order',
          entityId: access.order._id.toString(),
          severity: AuditSeverity.LOW,
          description: 'Un administrador consultó las evidencias del pedido',
        }).catch(console.error);
      }

      sendResponse(res, 200, 'Evidencias del pedido', evidences);
    } catch (error) { next(error); }
  }

  // ── Línea de tiempo ────────────────────────────────────────────────

  /**
   * La historia completa del pedido, para quien participa en él.
   *
   * Existía ya para administración (`/admin/orders/:id/security`), pero
   * no para las tres partes que de verdad discuten sobre lo que pasó. Un
   * comercio al que le reclaman un pedido que "nunca llegó" necesita
   * poder enseñar a qué hora salió del local y quién lo recogió; hasta
   * ahora ese dato solo lo tenía soporte.
   */
  async getTimeline(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const timeline = await orderTimelineService.forOrder(access);

      if (access.participant === 'admin') {
        logAudit(req, {
          action: AuditAction.ORDER_EVIDENCE_VIEWED,
          entity: 'order',
          entityId: access.order._id.toString(),
          severity: AuditSeverity.LOW,
          description: 'Un administrador consultó la línea de tiempo del pedido',
        }).catch(console.error);
      }

      sendResponse(res, 200, 'Línea de tiempo del pedido', timeline);
    } catch (error) { next(error); }
  }

  // ── Códigos ────────────────────────────────────────────────────────

  async verifyPickup(req: Request, res: Response, next: NextFunction) {
    return this.verifyCode(req, res, next, OrderCodeKind.PICKUP);
  }

  async verifyDelivery(req: Request, res: Response, next: NextFunction) {
    return this.verifyCode(req, res, next, OrderCodeKind.DELIVERY);
  }

  /**
   * Valida el código y **avanza el pedido**, en ese orden.
   *
   * El estado es consecuencia de la validación: el cliente nunca manda un
   * "status", manda un código, y el servidor decide. Si el avance de
   * estado fallara después de haber consumido el código —una cancelación
   * que se cuela entre las dos escrituras— el código se libera para que la
   * entrega pueda reintentarse, y queda constancia de la anomalía.
   */
  private async verifyCode(
    req: Request,
    res: Response,
    next: NextFunction,
    kind: OrderCodeKind
  ) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const order = access.order;
      const orderId = order._id.toString();

      try {
        await orderSecurityService.verify({ access, kind, code: req.body.code });
      } catch (error) {
        logAudit(req, {
          action: AuditAction.ORDER_CODE_FAILED,
          entity: 'order',
          entityId: orderId,
          severity: AuditSeverity.MEDIUM,
          description: `Intento fallido de validación (${kind})`,
          metadata: { kind, reason: (error as AppError).code },
        }).catch(console.error);

        orderTimelineService
          .record(
            orderId,
            kind === OrderCodeKind.PICKUP
              ? OrderTimelineAction.CODE_FAILED_PICKUP
              : OrderTimelineAction.CODE_FAILED_DELIVERY,
            { userId: access.userId, role: access.participant },
            {
              ip: clientIp(req),
              userAgent: userAgent(req),
              // El motivo, nunca el código tecleado: la bitácora se lee en
              // soporte y un intento fallido a menudo es el código correcto
              // de *otro* pedido que el domiciliario lleva encima.
              newValue: { reason: (error as AppError).code },
            }
          )
          .catch(console.error);

        throw error;
      }

      const nextStatus =
        kind === OrderCodeKind.PICKUP ? OrderStatus.PICKED_UP : OrderStatus.DELIVERED;

      // El hito del código se escribe ANTES de mover el pedido, y se
      // espera. La causalidad es esa —el estado avanza *porque* el código
      // se validó— y una bitácora que la invierte cuenta al revés lo único
      // que se le pregunta en una disputa: qué autorizó qué.
      //
      // Si el avance de estado falla después, el código se libera y el
      // intento anulado queda registrado: eso también es verdad, y es la
      // clase de anomalía que soporte necesita poder ver.
      await orderTimelineService.record(
        orderId,
        kind === OrderCodeKind.PICKUP
          ? OrderTimelineAction.CODE_VERIFIED_PICKUP
          : OrderTimelineAction.CODE_VERIFIED_DELIVERY,
        { userId: access.userId, role: access.participant },
        {
          ip: clientIp(req),
          userAgent: userAgent(req),
          previousValue: { status: order.status },
          newValue: { status: nextStatus },
          location: readLocation(req.body) ?? undefined,
        }
      );

      let updated;
      try {
        updated = await orderService.updateStatus(
          orderId,
          nextStatus,
          access.userId,
          UserRole.DRIVER,
          undefined,
          {
            ip: clientIp(req),
            userAgent: userAgent(req),
            location: readLocation(req.body) ?? undefined,
          }
        );
      } catch (error) {
        await orderSecurityService.releaseCode(orderId, kind);
        logAudit(req, {
          action: AuditAction.SUSPICIOUS_ACTIVITY,
          entity: 'order',
          entityId: orderId,
          severity: AuditSeverity.HIGH,
          description:
            'Código validado pero el pedido no pudo avanzar; el código se liberó',
          metadata: { kind, error: (error as Error).message },
        }).catch(console.error);
        throw error;
      }

      logAudit(req, {
        action: AuditAction.ORDER_CODE_VERIFIED,
        entity: 'order',
        entityId: orderId,
        severity: AuditSeverity.MEDIUM,
        description: `Código de ${kind} validado`,
        metadata: { kind, newStatus: nextStatus },
      }).catch(console.error);

      await this.broadcastStageChange(req, access, kind, nextStatus);

      sendResponse(
        res,
        200,
        kind === OrderCodeKind.PICKUP
          ? 'Recogida autorizada'
          : 'Entrega confirmada',
        { status: updated.status, verifiedAt: new Date() }
      );
    } catch (error) { next(error); }
  }

  private async broadcastStageChange(
    req: Request,
    access: OrderAccess,
    kind: OrderCodeKind,
    status: OrderStatus
  ) {
    const order = access.order;
    const participants = await getOrderParticipants(order);
    const io = req.app.get('io');

    const payload = {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      status,
      stage: kind,
    };

    io?.to(`user:${participants.clientUserId}`).emit('order:status:changed', payload);
    if (participants.driverUserId) {
      io?.to(`user:${participants.driverUserId}`).emit('order:status:changed', payload);
    }
    io?.to(`business:${participants.businessId}`).emit('order:status:changed', payload);
    io?.to('admin').emit('order:status:changed', payload);

    if (kind === OrderCodeKind.PICKUP) {
      const notices: Promise<unknown>[] = [
        notificationService.notifyDeliveryCodeReady(
          participants.clientUserId,
          order._id.toString(),
          order.orderNumber
        ),
      ];
      if (participants.businessOwnerId) {
        notices.push(
          notificationService.notifyPickupVerified(
            participants.businessOwnerId,
            order._id.toString(),
            order.orderNumber
          )
        );
      }
      Promise.allSettled(notices).catch(console.error);
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────

  async getChat(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const result = await orderChatService.list(access, {
        page: Number(query(req, 'page')) || 1,
        limit: Number(query(req, 'limit')) || 50,
      });

      if (access.participant === 'admin') {
        logAudit(req, {
          action: AuditAction.ORDER_CHAT_READ_BY_ADMIN,
          entity: 'order',
          entityId: access.order._id.toString(),
          severity: AuditSeverity.MEDIUM,
          description: 'Un administrador leyó la conversación del pedido',
        }).catch(console.error);
      }

      sendResponse(res, 200, 'Conversación del pedido', result.messages, result.meta);
    } catch (error) { next(error); }
  }

  async sendMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const message = await orderChatService.send(access, req.body.message);
      const participants = await getOrderParticipants(access.order);

      const recipientId =
        access.participant === 'client'
          ? participants.driverUserId
          : participants.clientUserId;

      const io = req.app.get('io');
      const payload = { orderId: access.order._id.toString(), message };
      if (recipientId) io?.to(`user:${recipientId}`).emit('order:chat:message', payload);
      io?.to(`user:${access.userId}`).emit('order:chat:message', payload);

      if (recipientId) {
        notificationService
          .notifyChatMessage(recipientId, access.order._id.toString(), access.order.orderNumber, req.user!.name)
          .catch(console.error);
      }

      sendResponse(res, 201, 'Mensaje enviado', message);
    } catch (error) { next(error); }
  }

  async markChatRead(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const updated = await orderChatService.markRead(access);

      const participants = await getOrderParticipants(access.order);
      const otherId =
        access.participant === 'client'
          ? participants.driverUserId
          : participants.clientUserId;

      if (updated > 0 && otherId) {
        req.app
          .get('io')
          ?.to(`user:${otherId}`)
          .emit('order:chat:read', { orderId: access.order._id.toString() });
      }

      sendResponse(res, 200, 'Mensajes marcados como leídos', { updated });
    } catch (error) { next(error); }
  }

  // ── Llamadas ───────────────────────────────────────────────────────

  async startCall(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const call = await orderCallService.start(access);

      req.app.get('io')?.to(`user:${call.receiver.userId}`).emit('order:call:incoming', {
        orderId: access.order._id.toString(),
        orderNumber: access.order.orderNumber,
        call,
      });

      logAudit(req, {
        action: AuditAction.ORDER_CALL_STARTED,
        entity: 'order',
        entityId: access.order._id.toString(),
        severity: AuditSeverity.LOW,
        description: 'Llamada iniciada',
        metadata: { callId: call.id },
      }).catch(console.error);

      sendResponse(res, 201, 'Llamada iniciada', call);
    } catch (error) { next(error); }
  }

  async answerCall(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const call = await orderCallService.answer(param(req, 'callId'), access);

      req.app.get('io')?.to(`user:${call.caller.userId}`).emit('order:call:answered', { call });

      sendResponse(res, 200, 'Llamada contestada', call);
    } catch (error) { next(error); }
  }

  async endCall(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      const call = await orderCallService.end(
        param(req, 'callId'),
        access,
        req.body?.reason
      );

      const io = req.app.get('io');
      io?.to(`user:${call.caller.userId}`).emit('order:call:ended', { call });
      io?.to(`user:${call.receiver.userId}`).emit('order:call:ended', { call });

      // Una llamada que nadie contestó merece rastro: es lo que explica
      // después "intenté avisarte de que no había nadie en la dirección".
      if (call.status === OrderCallStatus.MISSED) {
        notificationService
          .notifyMissedCall(call.receiver.userId, access.order._id.toString(), access.order.orderNumber, call.caller.name)
          .catch(console.error);
      }

      logAudit(req, {
        action: AuditAction.ORDER_CALL_ENDED,
        entity: 'order',
        entityId: access.order._id.toString(),
        severity: AuditSeverity.LOW,
        description: `Llamada finalizada (${call.status})`,
        metadata: { callId: call.id, durationSeconds: call.durationSeconds },
      }).catch(console.error);

      sendResponse(res, 200, 'Llamada finalizada', call);
    } catch (error) { next(error); }
  }

  async listCalls(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      assertParticipant(access, ['client', 'driver', 'admin'], 'ver las llamadas');
      const calls = await orderCallService.listForOrder(access);
      sendResponse(res, 200, 'Llamadas del pedido', calls);
    } catch (error) { next(error); }
  }

  // ── Cobro en efectivo ──────────────────────────────────────────────

  /**
   * "¿Recibiste el efectivo?" — la única declaración que cierra un cobro
   * contra entrega.
   *
   * El acceso se resuelve como en el resto del traspaso: no basta con
   * tener rol de domiciliario, hay que ser *el* domiciliario de este
   * pedido. Y aun así el servicio vuelve a comprobarlo, junto con lo que
   * de verdad importa —que la entrega esté completada—, porque un
   * controlador es una puerta y el dinero merece dos.
   */
  async confirmCash(req: Request, res: Response, next: NextFunction) {
    try {
      const access = await resolveOrderAccess(param(req, 'id'), req.user!);
      assertParticipant(access, ['driver'], 'confirmar el efectivo');

      const received = req.body.received === true;

      const { payment, order, changed } = await paymentService.confirmCashCollection({
        orderId: access.order._id.toString(),
        driverId: access.driverId!,
        actorUserId: access.userId,
        received,
        note: req.body.note,
        context: { ip: clientIp(req), userAgent: userAgent(req) },
      });

      if (changed) {
        orderTimelineService
          .record(
            order._id.toString(),
            received
              ? OrderTimelineAction.CASH_CONFIRMED
              : OrderTimelineAction.CASH_NOT_RECEIVED,
            { userId: access.userId, role: UserRole.DRIVER },
            {
              ip: clientIp(req),
              userAgent: userAgent(req),
              newValue: { paymentStatus: payment.status, amount: payment.amount },
            }
          )
          .catch(console.error);

        // El cliente ya pagó: merece el acuse igual que lo tiene quien
        // paga con tarjeta. En un faltante no se le avisa nada — es una
        // discrepancia entre ZIPP y el domiciliario, y notificársela al
        // cliente sería acusarle de algo que nadie ha comprobado.
        if (received) {
          notificationService
            .notifySystem(
              order.clientId.toString(),
              'Pago registrado',
              `Registramos el pago en efectivo de tu pedido #${order.orderNumber}.`,
              { orderId: order._id.toString(), orderNumber: order.orderNumber, event: 'cash_paid' }
            )
            .catch(console.error);
        }
      }

      sendResponse(res, 200, received ? 'Efectivo confirmado' : 'Faltante registrado', {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        paymentStatus: order.paymentStatus,
        amount: payment.amount,
        currency: payment.currency,
        confirmedAt: payment.processedAt,
        changed,
      });
    } catch (error) { next(error); }
  }
}

export const orderFlowController = new OrderFlowController();
