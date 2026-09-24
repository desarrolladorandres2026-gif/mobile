import { Pqrs, IPqrs, Order } from '../models';
import { addBusinessDays } from '../utils';

/**
 * Plazo legal de respuesta por tipo de PQRS, en días hábiles.
 *
 * Ley 1480 de 2011 (Estatuto del Consumidor) / Ley 1755 de 2015 (derecho de
 * petición) — confirmar con asesor legal antes de publicar esto de cara al
 * usuario. Una `suggestion` no tiene plazo legal: no es un derecho de
 * petición, es una idea.
 */
export const PQRS_LEGAL_BUSINESS_DAYS: Record<IPqrs['type'], number | null> = {
  petition: 15,
  complaint: 15,
  claim: 15,
  suggestion: null,
};

/** Cuántos días hábiles o menos cuentan como "por vencer" en la bandeja. */
export const LEGAL_DUE_SOON_BUSINESS_DAYS = 3;

export function computePqrsLegalDueAt(type: IPqrs['type'], createdAt: Date = new Date()): Date | null {
  const days = PQRS_LEGAL_BUSINESS_DAYS[type];
  if (days == null) return null;
  return addBusinessDays(createdAt, days);
}

export interface CreatePqrsInput {
  userId: string;
  type: IPqrs['type'];
  subject: string;
  detail: string;
  orderId?: string | null;
}

/**
 * Crea la PQRS con todo lo que hace falta para que soporte vea las partes
 * sin tener que ir a buscar el pedido aparte: comercio y domiciliario se
 * copian del pedido al momento de crear, porque después el pedido puede
 * cambiar de estado o de repartidor y la foto de "quién estaba implicado"
 * se perdería.
 */
export async function createPqrs(input: CreatePqrsInput): Promise<IPqrs> {
  const createdAt = new Date();
  let businessId: string | null = null;
  let driverId: string | null = null;

  if (input.orderId) {
    const order = await Order.findById(input.orderId).select('businessId driverId').lean();
    if (order) {
      businessId = order.businessId ? String(order.businessId) : null;
      driverId = order.driverId ? String(order.driverId) : null;
    }
  }

  return Pqrs.create({
    userId: input.userId,
    type: input.type,
    subject: input.subject,
    detail: input.detail,
    orderId: input.orderId || null,
    businessId,
    driverId,
    legalDueAt: computePqrsLegalDueAt(input.type, createdAt),
    createdAt,
  });
}
