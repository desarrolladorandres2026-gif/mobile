import { OrderKind, OrderStatus, PaymentMethod, PaymentStatus } from '../types';

/**
 * Cuándo un pedido es asunto del comercio.
 *
 * Un pedido en línea existe desde que se crea, pero la cocina no tiene nada
 * que hacer con él hasta que el dinero entra: aceptarlo antes da 409 y, si el
 * pago nunca llega, quedaría "pendiente" para siempre en el tablero. Un
 * programado tampoco es de la cocina hasta que se activa. Esta es la única
 * definición de ese "todavía no": el anuncio por socket, el listado del
 * comercio y el resumen del día la comparten, para que no se desincronicen.
 */

interface VisibilityFields {
  businessId?: unknown;
  kind?: string | null;
  scheduledFor?: Date | string | null;
  scheduledActivatedAt?: Date | string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  status?: string | null;
}

/** Pagado (o ya devuelto): el dinero entró alguna vez. */
const PAID_STATUSES = [PaymentStatus.PAID, PaymentStatus.REFUNDED];

/** ¿Ve el comercio este pedido? Un mandado no tiene comercio. */
export function isMerchantVisible(order: VisibilityFields): boolean {
  if (!order.businessId || order.kind === OrderKind.ERRAND) return false;
  if (order.scheduledFor && !order.scheduledActivatedAt) return false;
  if (
    order.paymentMethod === PaymentMethod.ONLINE &&
    !PAID_STATUSES.includes(order.paymentStatus as PaymentStatus)
  ) {
    return false;
  }
  return true;
}

/** ¿Puede el comercio aceptarlo ahora mismo? Visible y todavía pendiente. */
export function isActionableForBusiness(order: VisibilityFields): boolean {
  return order.status === OrderStatus.PENDING && isMerchantVisible(order);
}

/**
 * Filtro de Mongo: pedidos en línea cuyo cobro no ha entrado.
 * Se usa dentro de `$nor`, así que los pedidos anteriores a que existiera
 * `paymentMethod` (sin el campo) siguen viéndose.
 */
export const UNPAID_ONLINE_MATCH = {
  paymentMethod: PaymentMethod.ONLINE,
  paymentStatus: { $nin: PAID_STATUSES },
} as const;

/**
 * La ficha corta que viaja por los eventos de estado, con el negocio y quién
 * canceló. Sin `businessId` el panel no sabía a qué local pertenecía el
 * aviso (un dueño con varios locales oía los de todos), y sin `cancelledBy`
 * no podía distinguir un rechazo propio de una cancelación ajena.
 */
export function orderEventPayload(
  order: {
    _id: { toString(): string };
    orderNumber: string;
    status: string;
    businessId?: unknown;
    driverId?: { toString(): string } | null;
    cancelledBy?: string | null;
    cancellationReason?: string | null;
  },
  extra: Record<string, unknown> = {}
) {
  const business = order.businessId as { _id?: { toString(): string } } | { toString(): string } | null | undefined;
  const businessId = business
    ? String((business as { _id?: { toString(): string } })._id ?? business)
    : undefined;
  return {
    orderId: order._id.toString(),
    orderNumber: order.orderNumber,
    status: order.status,
    businessId,
    driverId: order.driverId?.toString(),
    cancelledBy: order.cancelledBy ?? undefined,
    cancellationReason: order.cancellationReason ?? undefined,
    ...extra,
  };
}
