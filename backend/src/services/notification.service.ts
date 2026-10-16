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
  //
  // Todas llevan `orderId` en el `data` del push, además de `orderNumber`.
  // Antes solo viajaba el número legible (`ZIPP-1234`), y la app decide a
  // qué pedido abrir por el id de Mongo: tocar cualquier push de pedido no
  // hacía nada, para cliente y para domiciliario por igual. El id nunca fue
  // opcional para esto — sin él, la condición que abre la pantalla del
  // pedido en `usePushNotifications.ts` no se cumple jamás.

  async notifyOrderCreated(userId: string, orderId: string, orderNumber: string, businessName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Pedido recibido',
      body: `Tu pedido #${orderNumber} en ${businessName} fue recibido y está pendiente de aceptación.`,
      data: { orderId, orderNumber },
    });
  }

  async notifyBusinessNewOrder(ownerId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Nuevo pedido',
      body: `Tienes un nuevo pedido #${orderNumber} esperando aceptación.`,
      data: { orderId, orderNumber },
    });
  }

  async notifyOrderStatusChanged(userId: string, orderId: string, orderNumber: string, status: string) {
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
      data: { orderId, orderNumber, status },
    });
  }

  async notifyDriverAssigned(userId: string, orderId: string, driverName: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Domiciliario asignado',
      body: `${driverName} recogerá tu pedido #${orderNumber}.`,
      data: { orderId, orderNumber, driverName },
    });
  }

  async notifyDriverNewOrder(driverId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId: driverId,
      type: NotificationType.ORDER,
      title: 'Pedido asignado',
      body: `Se te asignó el pedido #${orderNumber}. Dirígete al negocio a recogerlo.`,
      data: { orderId, orderNumber },
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
    orderId: string,
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
      data: { orderId, orderNumber, reason, event: 'order_cancelled' },
    });
  }

  /**
   * Al propietario: un empleado canceló un pedido. Cuenta lo que pasó y nada
   * más —quién, cuál y por qué—: no promete ningún reembolso, que es otro
   * proceso con su propio estado.
   */
  async notifyOwnerOrderCancelledByStaff(
    ownerId: string,
    orderId: string,
    orderNumber: string,
    staffName: string,
    staffUserId: string,
    reason?: string
  ) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Un empleado canceló un pedido',
      body: reason
        ? `${staffName} canceló el pedido #${orderNumber}. Motivo: ${reason}`
        : `${staffName} canceló el pedido #${orderNumber}.`,
      data: { orderId, orderNumber, reason, staffUserId, event: 'order_cancelled_by_staff' },
    });
  }

  /** Al comercio: la venta se cerró y ya cuenta para la liquidación. */
  async notifyBusinessOrderDelivered(ownerId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Pedido entregado',
      body: `El pedido #${orderNumber} llegó al cliente y ya cuenta para tu próxima liquidación.`,
      data: { orderId, orderNumber, event: 'order_delivered' },
    });
  }

  /**
   * Al dueño: su negocio está Abierto pero ningún panel lo tiene conectado
   * hace rato (`businessPresence.service.ts`). Un pedido nuevo no suena en
   * ningún lado si esto pasa — por eso es `SYSTEM` y no `ORDER`: no es que
   * un pedido concreto falle, es que nadie está escuchando ninguno.
   */
  async notifyBusinessPanelDisconnected(ownerId: string, businessId: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.SYSTEM,
      title: 'Tu negocio está Abierto sin nadie conectado',
      body: 'Ningún panel de Zipp está recibiendo tus pedidos en este momento. Ábrelo o cierra el negocio si no vas a atender.',
      data: { businessId, event: 'panel_disconnected' },
    });
  }

  /** Al comercio: ya se sabe quién va a venir a recoger. */
  async notifyBusinessDriverAssigned(
    ownerId: string,
    orderId: string,
    orderNumber: string,
    driverName: string
  ) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Domiciliario asignado',
      body: `${driverName} va en camino a recoger el pedido #${orderNumber}.`,
      data: { orderId, orderNumber, driverName, event: 'driver_assigned' },
    });
  }

  /** Al comercio: el domiciliario está en la puerta. */
  async notifyDriverArrivedAtStore(ownerId: string, orderId: string, orderNumber: string, driverName: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'El domiciliario llegó',
      body: `${driverName} está en el local para recoger el pedido #${orderNumber}.`,
      data: { orderId, orderNumber, event: 'driver_arrived_store' },
    });
  }

  /** Al comercio: la recogida quedó autorizada con el código. */
  async notifyPickupVerified(ownerId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: 'Pedido entregado al domiciliario',
      body: `El pedido #${orderNumber} salió del local con el código validado.`,
      data: { orderId, orderNumber, event: 'pickup_verified' },
    });
  }

  /** Al cliente: su pedido salió y ya tiene código de entrega. */
  async notifyDeliveryCodeReady(userId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Tu pedido va en camino',
      body:
        `Tu código de entrega del pedido #${orderNumber} está en la app. ` +
        'Compártelo solo cuando tengas el pedido en la mano.',
      data: { orderId, orderNumber, event: 'delivery_code_ready' },
    });
  }

  /** Al cliente: el domiciliario está en la puerta. */
  async notifyDriverArrivedAtCustomer(userId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Tu domiciliario llegó',
      body: `Ya está en tu dirección con el pedido #${orderNumber}. Ten tu código a mano.`,
      data: { orderId, orderNumber, event: 'driver_arrived_customer' },
    });
  }

  /** Mensaje nuevo en el chat del pedido. Sin previsualizar el contenido. */
  async notifyChatMessage(userId: string, orderId: string, orderNumber: string, senderName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Mensaje sobre tu pedido #${orderNumber}`,
      body: `${senderName} te escribió.`,
      data: { orderId, orderNumber, event: 'chat_message' },
    });
  }

  /** Llamada perdida del pedido. */
  async notifyMissedCall(userId: string, orderId: string, orderNumber: string, callerName: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: 'Llamada perdida',
      body: `${callerName} te llamó por el pedido #${orderNumber}.`,
      data: { orderId, orderNumber, event: 'missed_call' },
    });
  }

  /** Al cliente: falta un producto y hay que decidir en pocos minutos. */
  async notifyItemShortageAsked(userId: string, orderId: string, orderNumber: string, shortageId: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Pedido #${orderNumber}`,
      body: 'Falta un producto en tu pedido: ¿sigues con el resto?',
      data: { orderId, orderNumber, event: 'item_shortage', shortageId },
    });
  }

  /** Al cliente: la consulta venció sin respuesta y el pedido se canceló. */
  async notifyItemShortageExpired(userId: string, orderId: string, orderNumber: string) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Pedido #${orderNumber}`,
      body: 'No respondiste a tiempo por el producto que faltaba y el pedido se canceló.',
      data: { orderId, orderNumber, event: 'item_shortage_expired' },
    });
  }

  /** Al comercio: lo que decidió el cliente. */
  async notifyItemShortageResult(
    ownerId: string,
    orderId: string,
    orderNumber: string,
    result: 'accepted' | 'rejected' | 'expired'
  ) {
    const body: Record<typeof result, string> = {
      accepted: `El cliente del pedido #${orderNumber} aceptó seguir sin el producto que falta.`,
      rejected: `El cliente del pedido #${orderNumber} no aceptó seguir sin el producto: el pedido se canceló.`,
      expired: `El cliente del pedido #${orderNumber} no respondió a tiempo: el pedido se canceló.`,
    };
    return this.create({
      userId: ownerId,
      type: NotificationType.ORDER,
      title: `Pedido #${orderNumber}`,
      body: body[result],
      data: { orderId, orderNumber, event: `item_shortage_${result}` },
    });
  }

  /** Al domiciliario del pedido: el cobro en la puerta cambió. */
  async notifyDriverCashAmountChanged(userId: string, orderId: string, orderNumber: string, amount: number) {
    return this.create({
      userId,
      type: NotificationType.ORDER,
      title: `Cambió el cobro del pedido #${orderNumber}`,
      body: `El cliente seguirá sin un producto. Ahora cobra $${amount.toLocaleString('es-CO')} en la puerta.`,
      data: { orderId, orderNumber, event: 'cash_amount_changed', amount },
    });
  }

  /** La bolsa se quedó llena y sin tocar. Se manda una sola vez por bolsa. */
  async notifyAbandonedCart(userId: string, businessName: string, itemCount: number) {
    const plural = itemCount === 1 ? 'producto' : 'productos';
    return this.create({
      userId,
      type: NotificationType.SYSTEM,
      title: 'Se te quedó la bolsa llena',
      body: `Tienes ${itemCount} ${plural} de ${businessName} esperando en tu bolsa. ¿Los pedimos?`,
      data: { event: 'abandoned_cart' },
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
