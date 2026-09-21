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
import { AppError } from '../middlewares/errorHandler';

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

export async function profile360(userId: string): Promise<UserProfile360> {
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

    Payment.find({ userId: objectId }).sort({ createdAt: -1 }).limit(10).lean(),

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

    Session.find({ userId }).sort({ lastUsedAt: -1 }).limit(5).lean(),

    AuditLog.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const totals = totalsRow[0] ?? { orders: 0, delivered: 0, cancelled: 0, spent: 0 };

  return {
    user,
    totals: {
      orders: totals.orders,
      delivered: totals.delivered,
      cancelled: totals.cancelled,
      spent: totals.spent,
      cancellationRate: totals.orders
        ? Math.round((totals.cancelled / totals.orders) * 100)
        : 0,
    },
    recentOrders,
    payments,
    reviews,
    complaints,
    risk: { profile: riskProfile, openAlerts },
    sessions,
    recentActions,
  };
}

export const userProfile360Service = { profile360 };
