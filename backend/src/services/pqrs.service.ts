import { Pqrs, IPqrs, Order, Business, BusinessStaff, Driver, Settlement, getNextSequence } from '../models';
import { PQRS_REASON_VALUES, PqrsReasonValue } from '../models/Pqrs';
import { AppError } from '../middlewares/errorHandler';
import { OrderStatus, PaymentMethod, PayoutBeneficiary, UserRole } from '../types';
import { addBusinessDays } from '../utils';
import { notifyAlertsChanged } from './alerts.service';

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

export type PqrsPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Cuánto se tarda como máximo en responder, por prioridad.
 *
 * Son horas, no días: en una operación de comida a domicilio, un reclamo
 * de ayer ya no tiene arreglo. Viven aquí (y no en `support.service`) para
 * que `createPqrs` fije el SLA al abrir sin crear un ciclo de importación.
 */
export const SLA_HOURS: Record<PqrsPriority, number> = { urgent: 1, high: 4, normal: 24, low: 72 };

/** Qué se considera urgente sin que nadie lo decida a mano. */
export function defaultPriority(type: IPqrs['type']): PqrsPriority {
  if (type === 'claim') return 'high';
  if (type === 'complaint') return 'normal';
  return 'low';
}

/**
 * Motivos que ofrece el panel de comercios en lugar de petición / queja /
 * reclamo / sugerencia: un cajero con el local lleno describe qué pasó, no el
 * tipo legal. El servidor traduce cada motivo a su tipo, así el plazo legal y
 * la cola de admin no cambian. `other` no es un motivo: el solicitante elige
 * el tipo a mano.
 *
 * `payment` es anterior a los motivos financieros específicos: el panel ya no
 * lo ofrece, pero hay casos guardados con él y el servidor lo sigue aceptando.
 */
export const PQRS_REASONS = PQRS_REASON_VALUES as unknown as readonly [PqrsReasonValue, ...PqrsReasonValue[]];
export type PqrsReason = PqrsReasonValue;

export type PqrsCategory = 'operational' | 'technical' | 'financial';

/** Quién arregla qué: lo que pasó en la calle, lo que falló en la cuenta o el panel, o lo que toca dinero. */
export const REASON_CATEGORY: Record<PqrsReason, PqrsCategory> = {
  driver_no_show: 'operational',
  order_issue: 'operational',
  customer_unreachable: 'operational',
  driver_issue: 'operational',
  preparation_issue: 'operational',
  order_status_error: 'operational',
  account: 'technical',
  panel_issue: 'technical',
  payment: 'financial',
  order_payment_cancel: 'financial',
  settlement_difference: 'financial',
  wrong_commission: 'financial',
  unidentified_payment: 'financial',
  cancelled_order_adjustment: 'financial',
  refund_question: 'financial',
};

export const REASON_TYPE: Record<PqrsReason, IPqrs['type']> = {
  driver_no_show: 'claim',
  order_issue: 'claim',
  customer_unreachable: 'complaint',
  driver_issue: 'claim',
  preparation_issue: 'complaint',
  order_status_error: 'complaint',
  payment: 'claim',
  order_payment_cancel: 'claim',
  settlement_difference: 'claim',
  wrong_commission: 'claim',
  unidentified_payment: 'claim',
  cancelled_order_adjustment: 'claim',
  refund_question: 'complaint',
  account: 'petition',
  panel_issue: 'complaint',
};

/** Motivos que hablan de un pedido concreto: sin pedido no hay nada que investigar. */
const ORDER_REQUIRED_REASONS: ReadonlySet<PqrsReason> = new Set<PqrsReason>([
  'driver_no_show', 'order_issue', 'customer_unreachable', 'driver_issue', 'preparation_issue', 'order_status_error',
  'order_payment_cancel', 'cancelled_order_adjustment', 'refund_question',
]);

/** Motivos que ocurren en la calle: si el pedido sigue en curso, no pueden esperar 24 h. */
const URGENT_WHEN_ACTIVE: ReadonlySet<PqrsReason> = new Set<PqrsReason>([
  'driver_no_show', 'order_issue', 'customer_unreachable', 'driver_issue', 'preparation_issue', 'order_status_error',
]);

/**
 * Prioridad al abrir. Un problema operativo sobre un pedido que todavía está
 * en curso (el domiciliario no llega, el cliente no contesta) se arregla en
 * minutos o no se arregla: `urgent` (SLA de 1 h). El resto sigue la regla
 * por tipo. La prioridad nunca la elige quien abre el caso.
 */
export function priorityFor(type: IPqrs['type'], reason: PqrsReason | undefined, orderActive: boolean): PqrsPriority {
  if (reason && URGENT_WHEN_ACTIVE.has(reason) && orderActive) return 'urgent';
  return defaultPriority(type);
}

/** Número legible del caso. Sin número (filas anteriores a la migración 027) se usa el final del `_id`. */
export function caseCode(ticket: { ticketNumber?: number | null; _id: unknown }): string {
  return ticket.ticketNumber
    ? `SOP-${String(ticket.ticketNumber).padStart(6, '0')}`
    : `SOP-${String(ticket._id).slice(-6).toUpperCase()}`;
}

/** Lee "SOP-000123" (o "sop 123") y devuelve 123; cualquier otra cosa, null. */
export function parseCaseCode(text: string): number | null {
  const match = /^\s*sop[-\s]?0*(\d{1,9})\s*$/i.exec(text);
  return match ? Number(match[1]) : null;
}

type StatusActor = 'requester' | 'staff' | 'system';

/**
 * Deja constancia de que el caso quedó en `status`. Idempotente: no agrega nada
 * si la última entrada ya es ese estado o si el caso ya no está en él. Va
 * después de cada transición en lugar de dentro de ellas porque los pasos de
 * estado viven en varios filtros atómicos y un historial incompleto no debe
 * tumbar uno que ya ocurrió.
 */
export async function recordStatus(pqrsId: unknown, status: IPqrs['status'], actor: StatusActor, resolved = false): Promise<void> {
  try {
    await Pqrs.updateOne(
      { _id: pqrsId, status, $expr: { $ne: [{ $arrayElemAt: ['$statusHistory.status', -1] }, status] } },
      { $push: { statusHistory: { status, at: new Date(), actor, ...(resolved ? { resolved: true } : {}) } } },
      { timestamps: false }
    );
  } catch (error) {
    console.error('[PQRS] No se pudo registrar el cambio de estado', { pqrsId: String(pqrsId), status, error });
  }
}

/** Casos abiertos a la vez por persona. */
export const MAX_OPEN_PQRS_PER_USER = 10;

export interface CreatePqrsInput {
  userId: string;
  /** Obligatorio salvo que venga `reason`, que lo decide. */
  type?: IPqrs['type'];
  /** Solo comercios. Si viene, manda sobre `type`. */
  reason?: PqrsReason | null;
  subject: string;
  detail: string;
  orderId?: string | null;
  /** Rol de la cuenta (`req.user.role`). Si falta, se trata como cliente. */
  role?: UserRole;
  /** Solo comercios: cuál de sus negocios abre el caso. */
  businessId?: string | null;
  /** Solo comercios, casos financieros: la liquidación de la que se habla. Debe ser del mismo negocio. */
  settlementId?: string | null;
  /** Solo casos financieros sin pedido; con pedido manda el del pedido. */
  paymentMethod?: PaymentMethod | null;
}

const idStr = (v: unknown) => (v == null ? null : String(v));

/**
 * Decide quién es cada parte del caso y comprueba que quien lo abre tiene
 * algo que ver con lo que dice. Antes cualquiera podía colgar su queja de un
 * pedido ajeno y de paso ver al comercio y al domiciliario de ese pedido en la
 * ficha. Aquí el cliente solo cuelga pedidos suyos, el comercio pedidos de su
 * negocio y el domiciliario pedidos que entregó él.
 */
async function resolveParties(input: CreatePqrsInput): Promise<{
  requesterRole: IPqrs['requesterRole']; businessId: string | null; driverId: string | null; orderActive: boolean; orderPaymentMethod: PaymentMethod | null;
}> {
  const order = input.orderId
    ? await Order.findById(input.orderId).select('clientId businessId driverId status paymentMethod').lean()
    : null;
  const orderPaymentMethod = (order?.paymentMethod as PaymentMethod | undefined) ?? null;
  const orderActive = !!order && order.status !== OrderStatus.DELIVERED && order.status !== OrderStatus.CANCELLED;
  // Mismo mensaje para "no existe" y "no es tuyo": no se revela qué pedidos existen.
  if (input.orderId && !order) throw new AppError('Ese pedido no es tuyo', 403);

  if (input.role === UserRole.BUSINESS) {
    if (!input.businessId) throw new AppError('Indica de qué negocio es el caso', 422);
    const [owned, staff] = await Promise.all([
      Business.exists({ _id: input.businessId, ownerId: input.userId }),
      BusinessStaff.exists({ businessId: input.businessId, userId: input.userId, isActive: true }),
    ]);
    if (!owned && !staff) throw new AppError('Ese negocio no es tuyo', 403);
    if (order && idStr(order.businessId) !== input.businessId) throw new AppError('Ese pedido no es de tu negocio', 403);
    return { requesterRole: 'business', businessId: input.businessId, driverId: idStr(order?.driverId), orderActive, orderPaymentMethod };
  }

  if (input.role === UserRole.DRIVER) {
    const driver = await Driver.findOne({ userId: input.userId }).select('_id').lean();
    if (!driver) throw new AppError('No tienes perfil de domiciliario', 403);
    if (order && idStr(order.driverId) !== idStr(driver._id)) throw new AppError('Ese pedido no lo entregaste tú', 403);
    return { requesterRole: 'driver', businessId: idStr(order?.businessId), driverId: idStr(driver._id), orderActive, orderPaymentMethod };
  }

  if (order && idStr(order.clientId) !== input.userId) throw new AppError('Ese pedido no es tuyo', 403);
  return { requesterRole: 'customer', businessId: idStr(order?.businessId), driverId: idStr(order?.driverId), orderActive, orderPaymentMethod };
}

/**
 * Crea la PQRS con todo lo que hace falta para que soporte vea las partes
 * sin tener que ir a buscar el pedido aparte: comercio y domiciliario se
 * copian del pedido al momento de crear, porque después el pedido puede
 * cambiar de estado o de repartidor y la foto de "quién estaba implicado"
 * se perdería.
 *
 * También fija prioridad y SLA interno al abrir: un caso que nace sin
 * `dueAt` no vence nunca y se hunde al final de la cola.
 */
export async function createPqrs(input: CreatePqrsInput): Promise<IPqrs> {
  const createdAt = new Date();
  const reason = input.reason ?? undefined;
  if (reason) {
    if (input.role !== UserRole.BUSINESS) throw new AppError('Ese motivo es solo para comercios', 422);
    if (ORDER_REQUIRED_REASONS.has(reason) && !input.orderId) throw new AppError('Elige el pedido del que hablas', 422);
  }
  const type = reason ? REASON_TYPE[reason] : input.type;
  if (!type) throw new AppError('Indica el tipo o el motivo del caso', 422);
  const category = reason ? REASON_CATEGORY[reason] : null;
  const financial = category === 'financial';
  if (input.settlementId && !financial) throw new AppError('Solo un caso financiero se asocia a una liquidación', 422);

  const { requesterRole, businessId, driverId, orderActive, orderPaymentMethod } = await resolveParties(input);
  const priority = priorityFor(type, reason, orderActive);

  // Mismo mensaje para "no existe" y "es de otro negocio": no se revela qué liquidaciones hay.
  if (input.settlementId) {
    const owned = await Settlement.exists({ _id: input.settlementId, businessId, beneficiary: PayoutBeneficiary.BUSINESS });
    if (!owned) throw new AppError('Esa liquidación no es de tu negocio', 403);
  }
  // Con pedido, el medio de pago es el del pedido: el comercio no lo reescribe.
  const paymentMethod = orderPaymentMethod ?? (financial ? input.paymentMethod ?? null : null);

  // Tope de casos abiertos por persona: cada alta recalcula las alertas de todo el equipo.
  const open = await Pqrs.countDocuments({ userId: input.userId, status: { $in: ['received', 'in_review'] } });
  if (open >= MAX_OPEN_PQRS_PER_USER) throw new AppError('Ya tienes muchos casos abiertos. Espera a que respondamos alguno.', 429);

  const created = await Pqrs.create({
    userId: input.userId,
    type,
    reason: reason ?? null,
    category,
    ticketNumber: await getNextSequence('pqrs'),
    paymentMethod,
    settlementId: input.settlementId || null,
    statusHistory: [{ status: 'received', at: createdAt, actor: 'requester' }],
    subject: input.subject,
    detail: input.detail,
    orderId: input.orderId || null,
    requesterRole,
    businessId,
    driverId,
    priority,
    dueAt: new Date(createdAt.getTime() + SLA_HOURS[priority] * 60 * 60 * 1000),
    legalDueAt: computePqrsLegalDueAt(type, createdAt),
    createdAt,
  });
  void notifyAlertsChanged('pqrs');
  return created;
}
