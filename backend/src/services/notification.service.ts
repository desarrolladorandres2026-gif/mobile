import { Notification } from '../models';
import { NotificationType } from '../types';
import { emitToUser } from '../sockets/emitter';
import { pushService } from './push.service';

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
}

export class NotificationService {
  /**
   * Persiste la notificación y la reparte por los dos canales:
   *
   *  - Socket (`notification:new` + `notification:unread`) para la app
   *    abierta: la campana y el punto rojo se actualizan solos.
   *  - Push de Expo para la app cerrada o en segundo plano.
   *
   * El reparto va en segundo plano (`void`): guardar la notificación es lo
   * que no puede fallar; que un socket o una push se caigan no debe
   * bloquear al pedido que las originó.
   */
  async create(input: CreateNotificationInput) {
    const notification = await Notification.create(input);

    void this.dispatch(input.userId, notification);

    return notification;
  }

  private async dispatch(userId: string, notification: any) {
    try {
      emitToUser(userId, 'notification:new', notification);
      const unreadCount = await this.getUnreadCount(userId);
      emitToUser(userId, 'notification:unread', { unreadCount });
      await pushService.sendToUser(userId, {
        title: notification.title,
        body: notification.body,
        data: { ...(notification.data ?? {}), notificationId: notification._id?.toString(), type: notification.type },
      });
    } catch (err) {
      console.error('[Notification] Error repartiendo notificación:', err);
    }
  }

  async getByUser(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId }).skip(skip).limit(limit).sort({ createdAt: -1 }),
      Notification.countDocuments({ userId }),
      Notification.countDocuments({ userId, isRead: false }),
    ]);
    return { notifications, unreadCount, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async markAsRead(notificationId: string, userId: string) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true },
      { new: true }
    );
  }

  async markAllAsRead(userId: string) {
    const result = await Notification.updateMany({ userId, isRead: false }, { isRead: true });
    return { updated: result.modifiedCount };
  }

  async getUnreadCount(userId: string) {
    return Notification.countDocuments({ userId, isRead: false });
  }

  async delete(notificationId: string, userId: string) {
    return Notification.findOneAndDelete({ _id: notificationId, userId });
  }

  // ── Helpers de notificaciones comunes ──

  async notifyOrderCreated(userId: string, orderNumber: string, businessName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Pedido recibido',
      body: `Tu pedido #${orderNumber} en ${businessName} fue recibido y está pendiente de aceptación.`,
      data: { orderNumber },
    });
  }

  async notifyBusinessNewOrder(ownerId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Nuevo pedido',
      body: `Tienes un nuevo pedido #${orderNumber} esperando aceptación.`,
      data: { orderNumber },
    });
  }

  async notifyOrderStatusChanged(userId: string, orderNumber: string, status: string) {
    const statusMessages: Record<string, string> = {
      accepted: 'ha sido aceptado y será preparado pronto',
      preparing: 'está siendo preparado',
      ready: 'está listo y esperando domiciliario',
      picked_up: 'fue recogido por el domiciliario',
      on_way: 'va en camino a tu dirección',
      delivered: 'fue entregado. ¡Buen provecho!',
      cancelled: 'fue cancelado',
    };
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Pedido #${orderNumber}`,
      body: `Tu pedido ${statusMessages[status] || 'cambió de estado'}.`,
      data: { orderNumber, status },
    });
  }

  async notifyDriverAssigned(userId: string, driverName: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Domiciliario asignado',
      body: `${driverName} recogerá tu pedido #${orderNumber}.`,
      data: { orderNumber, driverName },
    });
  }

  async notifyDriverNewOrder(driverId: string, orderNumber: string) {
    return this.create({
      userId: driverId,
      type: NotificationType.ORDER,
      title: 'Pedido asignado',
      body: `Se te asignó el pedido #${orderNumber}. Dirígete al negocio a recogerlo.`,
      data: { orderNumber },
    });
  }

  // ── Traspaso físico del pedido ──────────────────────────────────
  //
  // Ninguna de estas notificaciones lleva el código de seguridad, ni
  // siquiera la que se lo recuerda al cliente. Una notificación se ve en
  // la pantalla bloqueada, se sincroniza con el reloj y sobrevive en el
  // centro de notificaciones: mandar ahí el secreto sería regalarlo a
  // cualquiera que mire el teléfono de reojo, que es exactamente el
  // ataque contra el que existe el código.

  /**
   * Al comercio: alguien canceló un pedido que él no canceló.
   *
   * Es la única forma de que una cocina deje de trabajar en un pedido que
   * ya no existe. El evento por socket llega a la sala del comercio, pero
   * un socket solo avisa a quien tiene el panel abierto y delante; a las
   * dos de la tarde eso no se puede dar por hecho.
   */
  async notifyBusinessOrderCancelled(
    ownerId: string,
    orderNumber: string,
    reason?: string
  ) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Pedido cancelado',
      body: reason
        ? `El pedido #${orderNumber} se canceló: ${reason}`
        : `El pedido #${orderNumber} se canceló. No sigas preparándolo.`,
      data: { orderNumber, reason, event: 'order_cancelled' },
    });
  }

  /** Al comercio: la venta se cerró y ya cuenta para la liquidación. */
  async notifyBusinessOrderDelivered(ownerId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Pedido entregado',
      body: `El pedido #${orderNumber} llegó al cliente y ya cuenta para tu próxima liquidación.`,
      data: { orderNumber, event: 'order_delivered' },
    });
  }

  /** Al comercio: ya se sabe quién va a venir a recoger. */
  async notifyBusinessDriverAssigned(
    ownerId: string,
    orderNumber: string,
    driverName: string
  ) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Domiciliario asignado',
      body: `${driverName} va en camino a recoger el pedido #${orderNumber}.`,
      data: { orderNumber, driverName, event: 'driver_assigned' },
    });
  }

  /** Al comercio: el domiciliario está en la puerta. */
  async notifyDriverArrivedAtStore(ownerId: string, orderNumber: string, driverName: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'El domiciliario llegó',
      body: `${driverName} está en el local para recoger el pedido #${orderNumber}.`,
      data: { orderNumber, event: 'driver_arrived_store' },
    });
  }

  /** Al comercio: la recogida quedó autorizada con el código. */
  async notifyPickupVerified(ownerId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Pedido entregado al domiciliario',
      body: `El pedido #${orderNumber} salió del local con el código validado.`,
      data: { orderNumber, event: 'pickup_verified' },
    });
  }

  /** Al cliente: su pedido salió y ya tiene código de entrega. */
  async notifyDeliveryCodeReady(userId: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Tu pedido va en camino',
      body:
        `Tu código de entrega del pedido #${orderNumber} está en la app. ` +
        'Compártelo solo cuando tengas el pedido en la mano.',
      data: { orderNumber, event: 'delivery_code_ready' },
    });
  }

  /** Al cliente: el domiciliario está en la puerta. */
  async notifyDriverArrivedAtCustomer(userId: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Tu domiciliario llegó',
      body: `Ya está en tu dirección con el pedido #${orderNumber}. Ten tu código a mano.`,
      data: { orderNumber, event: 'driver_arrived_customer' },
    });
  }

  /** Mensaje nuevo en el chat del pedido. Sin previsualizar el contenido. */
  async notifyChatMessage(userId: string, orderNumber: string, senderName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Mensaje sobre tu pedido #${orderNumber}`,
      body: `${senderName} te escribió.`,
      data: { orderNumber, event: 'chat_message' },
    });
  }

  /** Llamada perdida del pedido. */
  async notifyMissedCall(userId: string, orderNumber: string, callerName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Llamada perdida',
      body: `${callerName} te llamó por el pedido #${orderNumber}.`,
      data: { orderNumber, event: 'missed_call' },
    });
  }

  async notifySystem(userId: string, title: string, body: string, data?: Record<string, any>) {
    return this.create({
      userId,
      type: NotificationType.SYSTEM,
      title,
      body,
      data,
    });
  }
}

export const notificationService = new NotificationService();
