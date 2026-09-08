import { Types } from 'mongoose';
import { Order } from '../models';
import { OrderStatus } from '../types';

/**
 * Analíticas de un comercio.
 *
 * El panel las calculaba en el navegador sobre los últimos cien pedidos.
 * Ese número no es una muestra: es "lo que cupo en la primera página", así
 * que un negocio con tráfico veía como "ventas del mes" las de sus últimos
 * dos días, y uno con poco tráfico veía las de medio año. Ninguno de los
 * dos podía saberlo mirando la pantalla.
 *
 * Todo lo de aquí sale de una agregación en la base, sobre un rango de
 * fechas explícito.
 */

export interface BusinessAnalytics {
  range: { from: Date; to: Date; days: number };
  totals: {
    orders: number;
    delivered: number;
    cancelled: number;
    revenue: number;
    averageTicket: number;
    /** Cuánto de lo vendido se perdió en cancelaciones, en porcentaje. */
    cancellationRate: number;
  };
  /** Comparación con el periodo inmediatamente anterior, del mismo tamaño. */
  previous: { orders: number; revenue: number };
  byDay: Array<{ date: string; orders: number; revenue: number }>;
  /** Pedidos por hora del día. Sirve para decidir turnos y promociones. */
  byHour: Array<{ hour: number; orders: number }>;
}

const DELIVERED_MATCH = { status: OrderStatus.DELIVERED };

async function totalsFor(businessId: Types.ObjectId, from: Date, to: Date) {
  const [row] = await Order.aggregate([
    { $match: { businessId, createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        delivered: {
          $sum: { $cond: [{ $eq: ['$status', OrderStatus.DELIVERED] }, 1, 0] },
        },
        cancelled: {
          $sum: { $cond: [{ $eq: ['$status', OrderStatus.CANCELLED] }, 1, 0] },
        },
        // Solo lo entregado es venta. Contar lo cancelado infla el número
        // justo cuando algo va mal, que es cuando más se mira.
        revenue: {
          $sum: {
            $cond: [
              { $eq: ['$status', OrderStatus.DELIVERED] },
              { $ifNull: ['$finance.productSubtotal', '$subtotal'] },
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    orders: row?.orders ?? 0,
    delivered: row?.delivered ?? 0,
    cancelled: row?.cancelled ?? 0,
    revenue: row?.revenue ?? 0,
  };
}

export async function analyticsFor(
  businessIdRaw: string,
  options: { days?: number } = {}
): Promise<BusinessAnalytics> {
  const businessId = new Types.ObjectId(businessIdRaw);
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  // El periodo anterior tiene exactamente el mismo tamaño: comparar treinta
  // días con un mes natural daría subidas y bajadas que solo existen en el
  // calendario.
  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

  const [current, previous, byDay, byHour] = await Promise.all([
    totalsFor(businessId, from, to),
    totalsFor(businessId, previousFrom, previousTo),

    Order.aggregate([
      { $match: { businessId, createdAt: { $gte: from, $lte: to }, ...DELIVERED_MATCH } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$finance.productSubtotal', '$subtotal'] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', orders: 1, revenue: 1 } },
    ]),

    Order.aggregate([
      { $match: { businessId, createdAt: { $gte: from, $lte: to }, ...DELIVERED_MATCH } },
      { $group: { _id: { $hour: '$createdAt' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', orders: 1 } },
    ]),
  ]);

  return {
    range: { from, to, days },
    totals: {
      ...current,
      averageTicket: current.delivered ? Math.round(current.revenue / current.delivered) : 0,
      cancellationRate: current.orders
        ? Math.round((current.cancelled / current.orders) * 100)
        : 0,
    },
    previous: { orders: previous.orders, revenue: previous.revenue },
    byDay,
    byHour,
  };
}

export const businessAnalyticsService = { analyticsFor };
