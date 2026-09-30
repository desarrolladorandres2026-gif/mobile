import type { BusinessOrder } from './orderFlow';
import type { OrderStatusPayload } from '../hooks/realtimeContext';

/**
 * Qué pedidos hacen sonar el timbre, y con qué urgencia.
 *
 * La alarma depende del **estado** (hay pedidos que esperan y se pueden
 * aceptar), no de cada evento del socket. Un evento perdido —una
 * reconexión, una recarga, un aviso incompleto— no puede dejar un pedido
 * sin sonar: la lista se vuelve a leer y el timbre se recalcula. Todo lo de
 * este archivo es puro para poder probarlo sin navegador.
 */

/** Cuánto dura "Silenciar" sobre los pedidos que están sonando. */
export const SNOOZE_MS = 60_000;

export type RingPattern = 'normal' | 'urgent';

export interface EscalationInput {
  /** Minutos que lleva esperando el pedido más antiguo que está sonando. */
  oldestWaitingMinutes: number;
  /** Pedidos sonando ahora mismo (los silenciados no cuentan). */
  ringingCount: number;
}

/**
 * TODO(usuario): decide cuándo el timbre pasa de normal a urgente.
 *
 * Es una decisión de negocio, no técnica: ¿cuánto es "demasiado" sin que el
 * comercio acepte? Piensa en un pedido que se enfría mientras tanto y en el
 * ruido que tolera una cocina. Como referencia, el tablero ya pinta ámbar a
 * los 10 min y rojo a los 20 (`OrderBoard.tsx`). Puedes usar solo el tiempo,
 * o también cuántos pedidos se acumulan (`ringingCount`).
 *
 * Mientras no la escribas, el timbre nunca escala.
 */
export function escalationPolicy(input: EscalationInput): RingPattern {
  void input;
  return 'normal';
}

/** Pedidos en línea sin pagar no se aceptan: la cocina no los ve todavía. */
export function isActionable(order: BusinessOrder): boolean {
  if (order.status !== 'pending') return false;
  if (order.paymentMethod === 'online') return order.paymentStatus === 'paid';
  return true;
}

/**
 * Desde cuándo espera de verdad la cocina.
 *
 * `createdAt` miente en dos casos: un programado existe días antes de que le
 * toque a la cocina, y un pedido en línea puede crearse minutos antes de
 * pagarse. Para el primero hay fecha de activación; para el segundo, el
 * momento en que este panel lo vio aceptable (`firstSeen`, que sobrevive a
 * una recarga). Sin ese dato se cae a `createdAt`, que adelanta el
 * escalamiento: es el error seguro.
 */
export function waitingSince(order: BusinessOrder, firstSeen?: number): number {
  const created = new Date(order.createdAt).getTime();
  if (order.scheduledActivatedAt) return new Date(order.scheduledActivatedAt).getTime();
  if (order.paymentMethod === 'online' && firstSeen) return Math.max(created, firstSeen);
  return created;
}

/** Los pedidos que esperan aceptación, el más antiguo primero. */
export function waitingOrders(
  orders: readonly BusinessOrder[],
  firstSeen: Readonly<Record<string, number>> = {}
): BusinessOrder[] {
  return orders
    .filter(isActionable)
    .sort((a, b) => waitingSince(a, firstSeen[a._id]) - waitingSince(b, firstSeen[b._id]));
}

/**
 * Los que hacen ruido ahora: esperan y no están silenciados. Un pedido que
 * entra después de pulsar "Silenciar" no está en el mapa, así que suena de
 * inmediato: silenciar calla lo que ya se vio, no lo que todavía no llegó.
 */
export function ringingOrders(
  waiting: readonly BusinessOrder[],
  snoozes: Readonly<Record<string, number>>,
  now: number
): BusinessOrder[] {
  return waiting.filter((order) => (snoozes[order._id] ?? 0) <= now);
}

/** `null` si no hay nada que hacer sonar. */
export function ringPatternFor(
  ringing: readonly BusinessOrder[],
  now: number,
  firstSeen: Readonly<Record<string, number>> = {},
  policy: (input: EscalationInput) => RingPattern = escalationPolicy
): RingPattern | null {
  if (ringing.length === 0) return null;
  const oldest = Math.min(...ringing.map((order) => waitingSince(order, firstSeen[order._id])));
  return policy({
    oldestWaitingMinutes: Math.max(0, Math.floor((now - oldest) / 60_000)),
    ringingCount: ringing.length,
  });
}

/** Los silencios vencidos se sueltan para que el mapa no crezca sin fin. */
export function pruneSnoozes(snoozes: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(snoozes).filter(([, until]) => until > now));
}

/**
 * Cancelación que el comercio no provocó. Sin `cancelledBy` se da por ajena:
 * es el error seguro (un aviso de más, nunca uno de menos).
 */
export function isForeignCancellation(payload: Pick<OrderStatusPayload, 'status' | 'cancelledBy'>): boolean {
  return payload.status === 'cancelled' && payload.cancelledBy !== 'business';
}

export function cancelledByLabel(cancelledBy: OrderStatusPayload['cancelledBy']): string {
  return cancelledBy === 'client' ? 'el cliente' : 'ZIPP';
}
