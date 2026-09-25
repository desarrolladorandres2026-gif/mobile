import {
  Order,
  Business,
  Driver,
  User,
  DriverOffer,
  Payment,
  Refund,
  Payout,
  Review,
  Pqrs,
  CashPaymentIncident,
  SosAlert,
  OrderMessage,
  OrderCall,
  OrderEvidence,
} from '../models';
import { AppError } from '../middlewares';
import { OrderStatus, OrderKind, PaymentStatus, UserRole } from '../types';
import { Permission } from '../security/rbac';
import { resolveOrderAccess } from './orderAccess.service';
import { orderTimelineService } from './orderTimeline.service';
import { orderSecurityService } from './orderSecurity.service';
import { internalNoteService, NoteActor } from './internalNote.service';
import { customerFinanceView, maskPhoneOrNull } from './profileMasking';
import { notificationService } from './notification.service';

/**
 * Ficha 360 de un pedido para el panel admin.
 *
 * Todo el enmascarado ocurre aquí, en el servidor. Reglas de oro:
 *  - Nunca `orderSecurityService.viewFor` (emite códigos si faltan): solo
 *    `getState`, y de él sale únicamente el ESTADO de cada código.
 *  - La respuesta jamás contiene `secret`, `hash`, `pickupCode` ni
 *    `deliveryCode` (un test recorre el JSON).
 *  - Listas acotadas; ~15 consultas indexadas en paralelo.
 */

const ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_WAY,
];
const CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.ON_WAY,
];
const ASSIGNABLE_STATUSES: OrderStatus[] = [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY];
const REFUND_GATED_STATUSES: OrderStatus[] = [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.ON_WAY];

export type Has = (permission: Permission) => boolean;

const CODE_FIELDS = ['status', 'attempts', 'issuedAt', 'expiresAt', 'usedAt', 'verifiedBy', 'verifiedRole', 'lockedUntil', 'arrivedAt'] as const;

function codeStatusView(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of CODE_FIELDS) {
    const v = s[f];
    out[f] = v === undefined ? null : v && typeof v === 'object' && 'toString' in v && !(v instanceof Date) ? String(v) : v;
  }
  return out;
}

const iso = (d: unknown): string | null => (d ? new Date(d as Date).toISOString() : null);

export interface Profile360Input {
  orderId: string;
  user: { _id: unknown; role: string };
  has: Has;
  noteActor: NoteActor;
}

export async function profile360(input: Profile360Input) {
  const { has } = input;
  const access = await resolveOrderAccess(input.orderId, { _id: String(input.user._id), role: input.user.role });
  const order = access.order;
  const oid = order._id;

  const canCommissions = has(Permission.COMMISSIONS_VIEW);
  const canFinance = has(Permission.FINANCE_VIEW);
  const canRefundsView = has(Permission.REFUNDS_VIEW);
  const canEvidences = has(Permission.EVIDENCES_VIEW);
  const canSos = has(Permission.SOS_VIEW);
  const canSensitive = has(Permission.USERS_VIEW_SENSITIVE);
  const canSupport = has(Permission.SUPPORT_VIEW);
  const isActive = ACTIVE_STATUSES.includes(order.status);
  const exactAddress = isActive || canSensitive;

  const empty = Promise.resolve([] as any[]);

  const [
    timelineRaw,
    security,
    offers,
    client,
    business,
    driver,
    messages,
    calls,
    evidences,
    payments,
    refunds,
    payouts,
    review,
    pqrs,
    cashIncidents,
    sos,
    notes,
  ] = await Promise.all([
    orderTimelineService.forOrder(access),
    canEvidences ? orderSecurityService.getState(oid.toString()) : Promise.resolve(null),
    DriverOffer.find({ orderId: oid }).sort({ round: 1, offeredAt: 1 }).limit(50).lean(),
    User.findById(order.clientId).select('name phone').lean(),
    order.businessId ? Business.findById(order.businessId).select('name').lean() : Promise.resolve(null),
    order.driverId ? Driver.findById(order.driverId).select('userId').populate('userId', 'name').lean() : Promise.resolve(null),
    OrderMessage.countDocuments({ orderId: oid }),
    OrderCall.countDocuments({ orderId: oid }),
    canEvidences ? OrderEvidence.countDocuments({ orderId: oid }) : Promise.resolve(0),
    canFinance ? Payment.find({ orderId: oid }).sort({ createdAt: -1 }).limit(20).select('amount status method createdAt').lean() : empty,
    canFinance && canRefundsView ? Refund.find({ orderId: oid }).sort({ createdAt: -1 }).limit(20).select('amount status kind reason createdAt').lean() : empty,
    canFinance ? Payout.find({ orderId: oid }).limit(10).select('beneficiary amount reversedAmount status createdAt').lean() : empty,
    Review.findOne({ orderId: oid }).select('businessRating driverRating comment createdAt').lean(),
    canSupport ? Pqrs.find({ orderId: oid }).sort({ createdAt: -1 }).limit(10).select('subject status createdAt').lean() : empty,
    canFinance ? CashPaymentIncident.find({ orderId: oid }).limit(10).select('status amount createdAt').lean() : empty,
    canSos ? SosAlert.find({ orderId: oid }).sort({ createdAt: -1 }).limit(10).select('status note createdAt').lean() : empty,
    internalNoteService.listFor({ entityType: 'order', entityId: oid.toString(), limit: 20, actor: input.noteActor }),
  ]);

  // Nombres de los domiciliarios de las ofertas (una consulta).
  const offerDriverIds = [...new Set(offers.map((o) => String(o.driverId)))];
  const offerDrivers = offerDriverIds.length
    ? await Driver.find({ _id: { $in: offerDriverIds } }).select('userId').populate('userId', 'name').lean()
    : [];
  const driverNames = new Map(offerDrivers.map((d) => [String(d._id), (d.userId as any)?.name as string | undefined]));

  const finance = order.finance as unknown as Record<string, unknown> | undefined;
  const financeView: Record<string, unknown> = { ...(customerFinanceView(finance) ?? {}) };
  if (canCommissions && finance) {
    financeView.merchantCommission = finance.merchantCommission;
    financeView.platformNetRevenue = finance.platformNetRevenueBeforeOperatingCosts;
    financeView.appliedCommissionBps = finance.appliedCommissionBps;
  }

  const errand = order.errand
    ? {
        description: order.errand.description,
        pickupAddress: exactAddress ? order.errand.pickupAddress : undefined,
        estimatedCost: order.errand.estimatedCost,
        maxCost: order.errand.maxCost,
        actualCost: order.errand.actualCost ?? undefined,
      }
    : null;

  // La telemetría (IP, dispositivo, coordenadas) es dato personal del actor.
  const timeline = timelineRaw.map((entry) => {
    const { forensics, ...rest } = entry as typeof entry & { forensics?: unknown };
    return canSensitive && forensics ? { ...rest, forensics } : rest;
  });

  const errandPurchased = order.kind === OrderKind.ERRAND && order.errand?.actualCost != null;
  const paid = order.paymentStatus === PaymentStatus.PAID;
  const canCancelNow =
    has(Permission.ORDERS_CANCEL) &&
    CANCELLABLE_STATUSES.includes(order.status) &&
    !errandPurchased &&
    !(paid && REFUND_GATED_STATUSES.includes(order.status) && !has(Permission.REFUNDS_CREATE));

  const allowedActions = {
    assign: has(Permission.ORDERS_ASSIGN_DRIVER) && !order.driverId && ASSIGNABLE_STATUSES.includes(order.status),
    unassign:
      has(Permission.ORDERS_ASSIGN_DRIVER) && !!order.driverId && ASSIGNABLE_STATUSES.includes(order.status) && !errandPurchased,
    cancel: canCancelNow,
    refund: has(Permission.REFUNDS_CREATE) && paid,
    notify: has(Permission.ORDERS_UPDATE) && isActive,
    note: has(Permission.ORDERS_VIEW_ALL),
  };

  const driverUser = driver?.userId as any;

  return {
    order: {
      _id: String(oid),
      orderNumber: order.orderNumber,
      kind: order.kind,
      status: order.status,
      createdAt: iso(order.createdAt),
      scheduledFor: iso(order.scheduledFor),
      acceptedAt: iso(order.acceptedAt),
      deliveredAt: iso(order.deliveredAt),
      cancellationCode: order.cancellationCode ?? null,
      cancellationReason: order.cancellationReason ?? null,
      cancelledBy: order.cancelledBy ?? null,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      items: order.items.map((i) => ({ name: i.productName, quantity: i.quantity, price: i.unitPrice })),
      errand,
      city: order.city,
      zoneId: order.zoneId ? String(order.zoneId) : null,
      // Sin permiso ni pedido activo: solo la ciudad (el pedido no guarda barrio aparte).
      deliveryAddress: exactAddress
        ? { address: order.deliveryAddress, notes: order.deliveryDetails || undefined }
        : order.city,
      finance: financeView,
    },
    parties: {
      client: client ? { _id: String(client._id), name: client.name, phoneMasked: maskPhoneOrNull(client.phone) ?? undefined } : null,
      business: business ? { _id: String(business._id), name: business.name } : null,
      driver: driver ? { _id: String(driver._id), userId: driverUser?._id ? String(driverUser._id) : undefined, name: driverUser?.name ?? '' } : null,
    },
    timeline,
    dispatch: {
      round: order.dispatch?.round ?? 0,
      cycle: order.dispatch?.cycle ?? 0,
      expiresAt: iso(order.dispatch?.expiresAt),
      offers: offers.map((o) => ({
        driverId: String(o.driverId),
        driverName: driverNames.get(String(o.driverId)),
        round: o.round,
        outcome: o.outcome,
        reason: o.declineReason ?? null,
        offeredAt: iso(o.offeredAt) ?? undefined,
        respondedAt: iso(o.respondedAt),
      })),
    },
    conversation: { messages, calls },
    handoff: canEvidences
      ? {
          pickup: codeStatusView((security as any)?.pickup),
          delivery: codeStatusView((security as any)?.delivery),
          evidences,
        }
      : null,
    money: canFinance
      ? {
          payments: payments.map((p: any) => ({
            _id: String(p._id),
            amount: p.amount,
            status: p.status,
            method: p.method,
            createdAt: iso(p.createdAt),
          })),
          ...(canRefundsView
            ? {
                refunds: refunds.map((r: any) => ({
                  _id: String(r._id),
                  amount: r.amount,
                  status: r.status,
                  kind: r.kind,
                  reason: r.reason,
                  createdAt: iso(r.createdAt),
                })),
              }
            : {}),
          // El payout del comercio, junto al total del cliente, deja deducir la
          // comisión: sin `commissions:view` solo se ve el del domiciliario.
          payouts: payouts
            .filter((p: any) => canCommissions || p.beneficiary === 'driver')
            .map((p: any) => ({
            _id: String(p._id),
            beneficiary: p.beneficiary,
            amount: p.amount,
            netAmount: Math.max(0, p.amount - (p.reversedAmount ?? 0)),
            status: p.status,
            createdAt: iso(p.createdAt),
          })),
          ledgerHref: `/financials?orderId=${String(oid)}`,
        }
      : null,
    after: {
      review: review
        ? {
            _id: String(review._id),
            rating: (review as any).businessRating ?? (review as any).driverRating ?? 0,
            comment: review.comment || undefined,
            createdAt: iso((review as any).createdAt) ?? undefined,
          }
        : null,
      pqrs: pqrs.map((p: any) => ({ _id: String(p._id), subject: p.subject, status: p.status, createdAt: iso(p.createdAt) })),
      ...(canFinance
        ? {
            cashIncidents: cashIncidents.map((c: any) => ({ _id: String(c._id), status: c.status, amount: c.amount, createdAt: iso(c.createdAt) })),
          }
        : {}),
      ...(canSos
        ? { sos: sos.map((s: any) => ({ _id: String(s._id), status: s.status, note: s.note, createdAt: iso(s.createdAt) })) }
        : {}),
    },
    notes: notes.items,
    allowedActions,
    masked: {
      commissions: !canCommissions,
      finance: !canFinance,
      evidences: !canEvidences,
      sensitive: !exactAddress || !canSensitive,
    },
  };
}

// ── Reenviar aviso: plantillas FIJAS, sin texto libre ───────────────────

export type NotifyAudience = 'client' | 'business' | 'driver';
export type NotifyTemplate = 'status' | 'driver_assigned' | 'delayed';

const STATUS_LABEL: Record<string, string> = {
  pending: 'pendiente',
  accepted: 'aceptado',
  preparing: 'en preparación',
  ready: 'listo para recoger',
  picked_up: 'recogido',
  on_way: 'en camino',
  delivered: 'entregado',
  cancelled: 'cancelado',
};

export async function resendNotification(orderId: string, audience: NotifyAudience, template: NotifyTemplate) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Pedido no encontrado', 404);
  if (!ACTIVE_STATUSES.includes(order.status)) {
    throw new AppError('El pedido ya terminó: no se reenvían avisos', 409);
  }

  let userId: string | null = null;
  if (audience === 'client') userId = String(order.clientId);
  else if (audience === 'business') {
    const b = order.businessId ? await Business.findById(order.businessId).select('ownerId').lean() : null;
    userId = b?.ownerId ? String(b.ownerId) : null;
  } else {
    const d = order.driverId ? await Driver.findById(order.driverId).select('userId').lean() : null;
    userId = d?.userId ? String(d.userId) : null;
  }
  if (!userId) throw new AppError('Ese destinatario no existe en este pedido', 409);
  if (template === 'driver_assigned' && !order.driverId) {
    throw new AppError('El pedido aún no tiene domiciliario asignado', 409);
  }

  const n = order.orderNumber;
  const texts: Record<NotifyTemplate, { title: string; body: string }> = {
    status: { title: `Estado del pedido ${n}`, body: `Tu pedido ${n} está ${STATUS_LABEL[order.status] ?? order.status}.` },
    driver_assigned: { title: `Domiciliario asignado`, body: `El pedido ${n} ya tiene un domiciliario asignado.` },
    delayed: { title: `Pedido ${n} con demora`, body: `Estamos atendiendo la demora del pedido ${n}. Gracias por la paciencia.` },
  };
  const t = texts[template];
  await notificationService.notifySystem(userId, t.title, t.body, { orderId: String(order._id), orderNumber: n });
  return { sent: true, audience, template };
}

export const orderProfile360Service = { profile360, resendNotification };
