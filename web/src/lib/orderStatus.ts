/** Estado del pedido en una palabra. Mismo texto que la app (`ORDER_STATUS_LABELS`). */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Enviado al local',
  accepted: 'Aceptado',
  preparing: 'Preparando',
  ready: 'Listo',
  picked_up: 'Recogido',
  on_way: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

/** Qué está pasando de verdad, en segunda persona. */
export const ORDER_STATUS_DETAIL: Record<string, string> = {
  pending: 'Le avisamos al local. Confirma en un momento.',
  accepted: 'El local aceptó tu pedido y ya lo va a empezar.',
  preparing: 'Lo están preparando ahora mismo.',
  ready: 'Está listo. Un domiciliario pasa a recogerlo.',
  picked_up: 'Ya lo recogieron. Va saliendo hacia ti.',
  on_way: 'Va en camino a tu dirección.',
  delivered: 'Entregado. Buen provecho.',
  cancelled: 'Este pedido se canceló.',
};

/** Estados en los que el pedido todavía se está moviendo. */
export const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way'];

export const isActiveStatus = (status: string): boolean => ACTIVE_ORDER_STATUSES.includes(status);

/** Cobro en línea que quedó sin pagar: el pedido existe pero el negocio aún no lo ve. */
export const needsPayment = (order: { paymentMethod: string; paymentStatus?: string; status: string }): boolean =>
  order.paymentMethod === 'online' && order.paymentStatus === 'pending' && order.status === 'pending';

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente de pago',
  paid: 'Pagado',
  refunded: 'Reembolsado',
  failed: 'Pago fallido',
  pending_cash: 'Pagas al recibir',
  cash_received: 'Pagado en efectivo',
  cash_not_received: 'Efectivo no recibido',
};
