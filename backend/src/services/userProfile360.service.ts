import { Types } from 'mongoose';
import {
  User,
  Order,
  Review,
  Pqrs,
  Payment,
} from '../models';
import { OrderStatus } from '../types';
import { FraudAlert, UserRiskProfile, AuditLog, Session } from '../security';
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
}

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
      .sort({ createdAt: -1 })
      .limit(20)
      .select(sensitive ? '' : '-ip -userAgent')
      .lean(),
  ]);

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
    recentActions: sensitive
      ? recentActions
      : recentActions.map((a: Record<string, any>) => ({ ...a, metadata: pick(a.metadata, MASKED_ACTION_METADATA_FIELDS) })),
  };
}

export const userProfile360Service = { profile360 };
