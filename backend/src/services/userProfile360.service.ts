import { Types } from 'mongoose';
import {
  User,
  Order,
  Review,
  Pqrs,
  Payment,
  Address,
  SavedCard,
  ProSubscription,
  LegalAcceptance,
  DataRequest,
  Refund,
  CouponRedemption,
} from '../models';
import { internalNoteService, NoteActor } from './internalNote.service';
import { OrderStatus } from '../types';
import { FraudAlert, UserRiskProfile, AuditLog, AuditAction, Session, Permission } from '../security';
import { SESSION_PUBLIC_FIELDS } from '../security/sessions';
import { AppError } from '../middlewares/errorHandler';
import {
  CUSTOMER_FINANCE_FIELDS,
  MASKED_EVIDENCE_FIELDS,
  MASKED_ACTION_METADATA_FIELDS,
  pick,
} from './profileMasking';

/**
 * Todo lo que se sabe de una persona, en una sola consulta.
 *
 * Existe para soporte. Hoy, atender un reclamo significa abrir cinco
 * pantallas —pedidos, pagos, reseñas, seguridad, PQRS— y reconstruir a mano
 * la historia del cliente mientras él espera al teléfono. La mitad de las
 * veces la respuesta está en la pantalla que no se miró.
 *
 * No devuelve todo el historial: devuelve lo reciente y los totales. Quien
 * atiende necesita entender el caso en veinte segundos, no auditar tres
 * años de pedidos.
 */

export interface UserProfile360 {
  user: unknown;
  totals: {
    orders: number;
    delivered: number;
    cancelled: number;
    spent: number;
    /** Cuánto de lo que pidió acabó cancelándose. Señal de fricción o abuso. */
    cancellationRate: number;
  };
  recentOrders: unknown[];
  payments: unknown[];
  reviews: unknown[];
  complaints: unknown[];
  risk: { profile: unknown; openAlerts: unknown[] };
  sessions: unknown[];
  recentActions: unknown[];
  view: 'masked' | 'full';
  addresses: unknown[];
  savedCards: unknown[];
  pro: unknown | null;
  consents: unknown;
  /** null sin `legal:view`. */
  dataRequests: unknown[] | null;
  actionsOnUser: unknown[];
  /** null sin `refunds:view`. */
  refunds: unknown[] | null;
  couponRedemptions: unknown[];
  /** null si quien consulta no tiene `users:view`. */
  notes: unknown[] | null;
}

export interface Profile360Options {
  /**
   * `true` solo si quien consulta tiene `users:view_sensitive` (el llamador
   * decide con `can(req, Permission.USERS_VIEW_SENSITIVE)`). Por defecto la
   * ficha sale ENMASCARADA: cédula a 4 dígitos, nacimiento como +18, sin
   * IP/geolocalización, sin identificadores de OAuth ni metadata de pasarela.
   */
  sensitive?: boolean;
  /**
   * `true` solo si quien consulta tiene `commissions:view` (el llamador decide
   * con `can(req, Permission.COMMISSIONS_VIEW)`). Sin él, `recentOrders[].finance`
   * se reduce a lo que ya vio el cliente: nada de comisión, pagos a comercio o
   * repartidor, margen ni tasa aplicada. Por defecto se omite.
   */
  commissions?: boolean;
  /** `refunds:view`: sin él `refunds` es null. */
  refunds?: boolean;
  /** `legal:view`: sin él `dataRequests` es null. */
  legal?: boolean;
  /** Actor para las notas internas (`noteActorFromRequest`). Sin él, `notes` es null. */
  noteActor?: NoteActor;
}

const SECTION_LIMIT = 15;
const ACTION_METADATA_FIELDS = [...MASKED_ACTION_METADATA_FIELDS, 'reason'] as const;

const ADULT_YEARS = 18;
const isAdult = (birthDate?: Date | null): boolean | null => {
  if (!birthDate) return null;
  const limit = new Date(birthDate);
  limit.setUTCFullYear(limit.getUTCFullYear() + ADULT_YEARS);
  return limit.getTime() <= Date.now();
};

function maskUser(user: Record<string, any>): Record<string, unknown> {
  const { documentNumber, birthDate, googleId, appleId, facebookId, ...rest } = user;
  return {
    ...rest,
    documentNumberLast4: documentNumber ? String(documentNumber).slice(-4) : null,
    isAdult: isAdult(birthDate),
    hasOAuth: Boolean(googleId || appleId || facebookId),
  };
}

const MASKED_SESSION_FIELDS = SESSION_PUBLIC_FIELDS.split(' ')
  .filter((f) => f !== 'ip' && f !== 'location')
  .join(' ');

export async function profile360(userId: string, options: Profile360Options = {}): Promise<UserProfile360> {
  const sensitive = options.sensitive === true;
  const commissions = options.commissions === true;
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError('Identificador de usuario inválido', 400);
  }

  const objectId = new Types.ObjectId(userId);

  const user = await User.findById(userId)
    .select('-password -twoFactorSecret -recoveryCodes')
    .lean();
  if (!user) throw new AppError('Usuario no encontrado', 404);

  // Todo en paralelo: son consultas independientes sobre colecciones
  // distintas, y encadenarlas multiplicaría por siete la espera de quien
  // tiene al cliente al teléfono.
  const [
    totalsRow,
    recentOrders,
    payments,
    reviews,
    complaints,
    riskProfile,
    openAlerts,
    sessions,
    recentActions,
    addresses,
    savedCards,
    proSub,
    acceptances,
    dataRequests,
    actionsOnUserRows,
    refunds,
    redemptions,
    notes,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { clientId: objectId } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$status', OrderStatus.DELIVERED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', OrderStatus.CANCELLED] }, 1, 0] } },
          spent: {
            $sum: {
              $cond: [
                { $eq: ['$status', OrderStatus.DELIVERED] },
                { $ifNull: ['$finance.customerTotal', '$total'] },
                0,
              ],
            },
          },
        },
      },
    ]),

    Order.find({ clientId: objectId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('orderNumber status total finance createdAt deliveredAt cancellationCode cancelledBy')
      .populate('businessId', 'name')
      .lean(),

    Payment.find({ userId: objectId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select(sensitive ? '' : '-metadata -transactionId -reference')
      .lean(),

    Review.find({ userId: objectId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('businessId', 'name')
      .lean(),

    Pqrs.find({ userId: objectId }).sort({ createdAt: -1 }).limit(10).lean(),

    UserRiskProfile.findOne({ userId }).lean(),

    FraudAlert.find({ userId, status: { $in: ['open', 'investigating'] } })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),

    // S10: sin `.select()` salía `tokenHash`/`previousTokenHash` — la llave
    // con la que el servidor reconoce el refresh token de la sesión, no el
    // token en sí, pero igual de sensible. `SESSION_PUBLIC_FIELDS` es la
    // misma lista blanca que usa el panel de Seguridad.
    Session.find({ userId }).select(sensitive ? SESSION_PUBLIC_FIELDS : MASKED_SESSION_FIELDS).sort({ lastActivity: -1 }).limit(5).lean(),

    AuditLog.find({ userId })
      .sort({ timestamp: -1 })
      .limit(20)
      .select(sensitive ? '' : '-ip -userAgent')
      .lean(),

    // Dirección exacta y piso solo en la vista completa.
    Address.find({ userId: objectId })
      .sort({ isDefault: -1, createdAt: -1 })
      .limit(SECTION_LIMIT)
      .select(sensitive ? 'label neighborhood city isDefault address apartment' : 'label neighborhood city isDefault')
      .lean(),

    // Lista blanca: jamás `gatewaySourceId` (con él se puede cobrar).
    SavedCard.find({ userId: objectId })
      .sort({ lastUsedAt: -1 })
      .limit(SECTION_LIMIT)
      .select('brand lastFour expMonth expYear lastUsedAt')
      .lean(),

    ProSubscription.findOne({ userId: objectId })
      .select('status planId startedAt currentPeriodEnd cancelledAt autoRenew')
      .lean(),

    // Sin `ipHash`.
    LegalAcceptance.find({ userId: objectId })
      .sort({ acceptedAt: -1 })
      .limit(SECTION_LIMIT)
      .select('documentId version acceptedAt')
      .populate('documentId', 'kind')
      .lean(),

    options.legal
      ? DataRequest.find({ userId: objectId })
          .sort({ createdAt: -1 })
          .limit(SECTION_LIMIT)
          .select('type status createdAt legalDueAt')
          .lean()
      : Promise.resolve(null),

    AuditLog.find({ entity: 'user', entityId: userId, action: { $ne: AuditAction.PROFILE_VIEWED } })
      .sort({ timestamp: -1 })
      .limit(SECTION_LIMIT)
      .select('action description timestamp userId metadata')
      .lean(),

    options.refunds
      ? Order.find({ clientId: objectId })
          .sort({ createdAt: -1 })
          .limit(20)
          .select('_id')
          .lean()
          .then((os) =>
            os.length
              ? Refund.find({ orderId: { $in: os.map((o) => o._id) } })
                  .sort({ createdAt: -1 })
                  .limit(SECTION_LIMIT)
                  .select('orderId amount status kind reason createdAt')
                  .lean()
              : []
          )
      : Promise.resolve(null),

    CouponRedemption.find({ userId: objectId })
      .sort({ createdAt: -1 })
      .limit(SECTION_LIMIT)
      .select('couponId orderId discountAmount createdAt')
      .populate('couponId', 'code')
      .lean(),

    options.noteActor && options.noteActor.permissions.includes(Permission.USERS_VIEW)
      ? internalNoteService.listFor({ entityType: 'user', entityId: userId, limit: 20, actor: options.noteActor }).then((r) => r.items)
      : Promise.resolve(null),
  ]);

  // Quién hizo cada acción sobre la cuenta: una sola consulta de nombres.
  const actorIds = [...new Set(actionsOnUserRows.map((a) => a.userId).filter((u): u is string => !!u && Types.ObjectId.isValid(u)))];
  const actors = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('name').lean() : [];
  const actorName = new Map(actors.map((u) => [u._id.toString(), u.name]));

  const totals = totalsRow[0] ?? { orders: 0, delivered: 0, cancelled: 0, spent: 0 };

  return {
    user: sensitive ? user : maskUser(user),
    totals: {
      orders: totals.orders,
      delivered: totals.delivered,
      cancelled: totals.cancelled,
      spent: totals.spent,
      cancellationRate: totals.orders
        ? Math.round((totals.cancelled / totals.orders) * 100)
        : 0,
    },
    recentOrders: commissions
      ? recentOrders
      : recentOrders.map((o: Record<string, any>) => ({ ...o, finance: pick(o.finance, CUSTOMER_FINANCE_FIELDS) })),
    payments,
    reviews,
    complaints,
    risk: {
      profile: riskProfile,
      openAlerts: sensitive
        ? openAlerts
        : openAlerts.map((a: Record<string, any>) => ({ ...a, evidence: pick(a.evidence, MASKED_EVIDENCE_FIELDS) })),
    },
    sessions,
    view: sensitive ? 'full' : 'masked',
    addresses: addresses.map((a: Record<string, any>) => ({ ...a, _id: String(a._id) })),
    savedCards: savedCards.map((c: Record<string, any>) => ({
      _id: String(c._id),
      brand: c.brand,
      last4: c.lastFour,
      expMonth: c.expMonth,
      expYear: c.expYear,
      lastUsedAt: c.lastUsedAt,
    })),
    pro: proSub
      ? {
          status: proSub.status,
          plan: proSub.planId,
          startedAt: proSub.startedAt,
          currentPeriodEnd: proSub.currentPeriodEnd,
          cancelledAt: proSub.cancelledAt,
          autoRenew: proSub.autoRenew,
        }
      : null,
    consents: {
      marketingConsent: user.marketingConsent ?? false,
      marketingConsentAt: user.marketingConsentAt ?? null,
      legal: acceptances.map((a: Record<string, any>) => ({
        type: a.documentId?.kind,
        version: a.version,
        acceptedAt: a.acceptedAt,
      })),
    },
    dataRequests: dataRequests
      ? dataRequests.map((r: Record<string, any>) => ({
          _id: String(r._id),
          type: r.type,
          status: r.status,
          createdAt: r.createdAt,
          dueAt: r.legalDueAt ?? null,
        }))
      : null,
    actionsOnUser: actionsOnUserRows.map((a: Record<string, any>) => ({
      _id: String(a._id),
      action: a.action,
      description: a.description,
      createdAt: a.timestamp,
      actorName: a.userId ? actorName.get(a.userId) : undefined,
      metadata: pick(a.metadata, ACTION_METADATA_FIELDS),
    })),
    refunds: refunds
      ? refunds.map((r: Record<string, any>) => ({
          _id: String(r._id),
          orderId: String(r.orderId),
          amount: r.amount,
          status: r.status,
          kind: r.kind,
          reason: r.reason,
          createdAt: r.createdAt,
        }))
      : null,
    couponRedemptions: redemptions.map((c: Record<string, any>) => ({
      _id: String(c._id),
      couponId: String(c.couponId?._id ?? c.couponId),
      code: c.couponId?.code,
      discount: c.discountAmount,
      orderId: String(c.orderId),
      createdAt: c.createdAt,
    })),
    notes,
    recentActions: sensitive
      ? recentActions
      : recentActions.map((a: Record<string, any>) => ({ ...a, metadata: pick(a.metadata, MASKED_ACTION_METADATA_FIELDS) })),
  };
}

export const userProfile360Service = { profile360 };
