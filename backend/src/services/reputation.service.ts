import { Types } from 'mongoose';
import { Review, Order, Business, Driver } from '../models';
import { OrderStatus } from '../types';
import { UNPAID_ONLINE_MATCH } from '../utils/merchantVisibility';

/**
 * Puntaje de reputación interno: nunca se muestra al usuario, nunca decide
 * nada solo. Es la señal que usa Admin para investigar antes de que un
 * problema se vuelva visible en el `rating` público.
 *
 * A diferencia de `rating` (promedio simple de todas las reseñas, para
 * siempre), este score pondera:
 *
 *   - lo reciente (últimos 90 días) por encima de lo histórico — un negocio
 *     que mejoró no debería seguir pagando reseñas de hace un año;
 *   - la voz operativa (domiciliario↔comercio) además de la del cliente;
 *   - la tasa de cumplimiento (entregado vs. cancelado);
 *   - cuántas calificaciones bajas (1-2 ⭐) hubo recientemente.
 *
 * Ninguna mala calificación aislada lo hunde: cada factor pesa una fracción
 * del total y la ventana de 90 días diluye un mal día entre docenas de
 * pedidos buenos.
 */
const RECENT_WINDOW_DAYS = 90;
const MAX_INCIDENT_PENALTY = 10;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

async function recentSince() {
  return new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Reputación interna del comercio.
 *
 * Combina el rating reciente del cliente (lo que de verdad importa: cómo se
 * siente comprar ahí AHORA), la voz operativa del domiciliario al recoger,
 * el cumplimiento de pedidos y las incidencias recientes.
 */
export async function recalculateBusinessReputation(businessId: string): Promise<number> {
  const since = await recentSince();
  const businessObjectId = new Types.ObjectId(businessId);

  const [recentClientStats, operationalStats, orderStats, incidentStats] = await Promise.all([
    Review.aggregate([
      { $match: { businessId: businessObjectId, isHidden: { $ne: true }, businessRating: { $ne: null }, createdAt: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: '$businessRating' }, count: { $sum: 1 } } },
    ]),
    Review.aggregate([
      { $match: { businessId: businessObjectId, isHidden: { $ne: true }, driverRatingOfBusiness: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$driverRatingOfBusiness' }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      // Un checkout abandonado no es una cancelación del comercio.
      { $match: { businessId: businessObjectId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: since }, status: { $in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Review.countDocuments({
      businessId: businessObjectId, isHidden: { $ne: true }, businessRating: { $lte: 2 }, createdAt: { $gte: since },
    }),
  ]);

  const recentAvg = recentClientStats[0]?.avg ?? null;
  const operationalAvg = operationalStats[0]?.avg ?? null;

  const delivered = orderStats.find((o) => o._id === OrderStatus.DELIVERED)?.count ?? 0;
  const cancelled = orderStats.find((o) => o._id === OrderStatus.CANCELLED)?.count ?? 0;
  const totalOrders = delivered + cancelled;
  const completionRate = totalOrders > 0 ? delivered / totalOrders : 1;

  const incidentPenalty = Math.min(MAX_INCIDENT_PENALTY, incidentStats);

  // Sin reseñas recientes de cliente todavía: no hay suficiente información
  // para un score interno con sentido, se deja en 0 en vez de inventar uno.
  if (recentAvg === null) return 0;

  const clientComponent = (recentAvg / 5) * 50;
  const operationalComponent = operationalAvg !== null ? (operationalAvg / 5) * 20 : 15; // neutral si no hay dato
  const completionComponent = completionRate * 20;
  const incidentComponent = MAX_INCIDENT_PENALTY - incidentPenalty;

  const score = clampScore(clientComponent + operationalComponent + completionComponent + incidentComponent);

  await Business.findByIdAndUpdate(businessId, { reputationScore: score, reputationUpdatedAt: new Date() });
  return score;
}

/** Reputación interna del domiciliario. Mismo principio que la del comercio. */
export async function recalculateDriverReputation(driverId: string): Promise<number> {
  const since = await recentSince();
  const driverObjectId = new Types.ObjectId(driverId);

  const [recentClientStats, operationalStats, orderStats, incidentStats] = await Promise.all([
    Review.aggregate([
      { $match: { driverId: driverObjectId, isHidden: { $ne: true }, driverRating: { $ne: null }, createdAt: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: '$driverRating' }, count: { $sum: 1 } } },
    ]),
    Review.aggregate([
      { $match: { driverId: driverObjectId, isHidden: { $ne: true }, businessRatingOfDriver: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$businessRatingOfDriver' }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { driverId: driverObjectId, createdAt: { $gte: since }, status: { $in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Review.countDocuments({
      driverId: driverObjectId, isHidden: { $ne: true }, driverRating: { $lte: 2 }, createdAt: { $gte: since },
    }),
  ]);

  const recentAvg = recentClientStats[0]?.avg ?? null;
  const operationalAvg = operationalStats[0]?.avg ?? null;

  const delivered = orderStats.find((o) => o._id === OrderStatus.DELIVERED)?.count ?? 0;
  const cancelled = orderStats.find((o) => o._id === OrderStatus.CANCELLED)?.count ?? 0;
  const totalOrders = delivered + cancelled;
  const completionRate = totalOrders > 0 ? delivered / totalOrders : 1;

  const incidentPenalty = Math.min(MAX_INCIDENT_PENALTY, incidentStats);

  if (recentAvg === null) return 0;

  const clientComponent = (recentAvg / 5) * 50;
  const operationalComponent = operationalAvg !== null ? (operationalAvg / 5) * 20 : 15;
  const completionComponent = completionRate * 20;
  const incidentComponent = MAX_INCIDENT_PENALTY - incidentPenalty;

  const score = clampScore(clientComponent + operationalComponent + completionComponent + incidentComponent);

  await Driver.findByIdAndUpdate(driverId, { reputationScore: score, reputationUpdatedAt: new Date() });
  return score;
}
