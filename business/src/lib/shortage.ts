import type { BusinessOrder, OrderItem } from './orderFlow';

/**
 * El producto que falta en un pedido: lo que el comercio manda y cómo se lee
 * lo que responde el servidor (`order.itemShortage`).
 */

export const SHORTAGE_REASONS = [
  { value: 'out_of_stock', label: 'Se agotó' },
  { value: 'damaged', label: 'Está dañado' },
  { value: 'other', label: 'Otro motivo' },
] as const;

export type ShortageReason = (typeof SHORTAGE_REASONS)[number]['value'];

export type ShortageStatus = 'pending_client' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export interface ItemShortage {
  id: string;
  status: ShortageStatus;
  reason: ShortageReason;
  note?: string;
  items: Array<{ itemId: string; productName: string; quantity: number; missingQty: number }>;
  requestedAt: string;
  /** Hasta cuándo puede responder el cliente. */
  expiresAt: string;
  respondedAt?: string | null;
  /** Lo que se le descuenta al cliente si acepta. */
  refundAmount: number;
}

export type OrderWithShortage = BusinessOrder & { itemShortage?: ItemShortage | null };

/** Lo que el servidor espera: solo las líneas con algo que falta. */
export function buildShortageBody(
  items: OrderItem[],
  missing: Record<string, number>,
  reason: ShortageReason
) {
  return {
    reason,
    items: items
      .filter((item) => item._id && (missing[item._id] ?? 0) > 0)
      .map((item) => ({
        itemId: item._id as string,
        missingQty: Math.min(item.quantity, missing[item._id as string]),
      })),
  };
}

/** ¿Hay una consulta al cliente sin responder? Mientras la haya, el pedido no se marca listo. */
export const isShortagePending = (order: OrderWithShortage, now = Date.now()): boolean =>
  order.itemShortage?.status === 'pending_client' && new Date(order.itemShortage.expiresAt).getTime() > now;

/** «2:41» que faltan para que el cliente deje de poder responder. */
export function shortageCountdown(shortage: ItemShortage, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((new Date(shortage.expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const SHORTAGE_RESULT_LABEL: Record<ShortageStatus, string> = {
  pending_client: 'Esperando al cliente',
  accepted: 'El cliente aceptó seguir sin ese producto',
  rejected: 'El cliente no aceptó: el pedido se canceló',
  expired: 'El cliente no respondió a tiempo: el pedido se canceló',
  superseded: 'El pedido se canceló antes de la respuesta',
};
