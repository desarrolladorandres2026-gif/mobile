import { Types } from 'mongoose';
import { Order } from '../models';
import { CancellationReason, CancelledBy, OrderStatus } from '../types';
import { UNPAID_ONLINE_MATCH } from '../utils/merchantVisibility';
import { config } from '../config';

/** Las horas y los días del comercio son los de Colombia, no los del servidor. */
const TZ = () => config.settlement.timezone;

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
  /** Pedidos por hora del día (hora de Colombia). Sirve para decidir turnos y promociones. */
  byHour: Array<{ hour: number; orders: number }>;
  /** Lo más vendido del periodo, por unidades. */
  topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
  /** Minutos promedio entre aceptar el pedido y dejarlo listo. `null` si no hay datos. */
  avgPrepMinutes: number | null;
  /**
   * Clientes que compraron en el periodo: nuevos son los que nunca habían
   * recibido un pedido de este comercio antes de que empezara.
   */
  customers: { total: number; new: number; returning: number };
  /**
   * Pedidos que el comercio no atendió: los rechazó o dejó vencer sin
   * aceptarlos. Es lo que más cuesta, porque el cliente ya había pagado o
   * esperado.
   */
  lostByBusiness: { orders: number; rate: number };
}

const DELIVERED_MATCH = { status: OrderStatus.DELIVERED };

async function totalsFor(businessId: Types.ObjectId, from: Date, to: Date) {
  const [row] = await Order.aggregate([
    // Los pedidos en línea sin pagar no cuentan: el comercio nunca los vio.
    { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to } } },
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

  const [current, previous, byDay, byHour, topProducts, prepRow, clientIds, lost] = await Promise.all([
    totalsFor(businessId, from, to),
    totalsFor(businessId, previousFrom, previousTo),

    Order.aggregate([
      { $match: { businessId, createdAt: { $gte: from, $lte: to }, ...DELIVERED_MATCH } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ() } },
          orders: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$finance.productSubtotal', '$subtotal'] } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', orders: 1, revenue: 1 } },
    ]),

    Order.aggregate([
      { $match: { businessId, createdAt: { $gte: from, $lte: to }, ...DELIVERED_MATCH } },
      { $group: { _id: { $hour: { date: '$createdAt', timezone: TZ() } }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', orders: 1 } },
    ]),

    Order.aggregate([
      { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to }, ...DELIVERED_MATCH } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $last: '$items.productName' },
          quantity: { $sum: '$items.quantity' },
          sales: { $sum: '$items.totalPrice' },
        },
      },
      { $sort: { quantity: -1, sales: -1 } },
      { $limit: 8 },
      { $project: { _id: 0, productId: { $toString: '$_id' }, name: 1, quantity: 1, sales: 1 } },
    ]),

    Order.aggregate([
      {
        $match: {
          businessId,
          $nor: [UNPAID_ONLINE_MATCH],
          createdAt: { $gte: from, $lte: to },
          acceptedAt: { $ne: null },
          preparedAt: { $ne: null },
        },
      },
      { $group: { _id: null, minutes: { $avg: { $divide: [{ $subtract: ['$preparedAt', '$acceptedAt'] }, 60000] } } } },
    ]),

    Order.distinct('clientId', { businessId, ...DELIVERED_MATCH, createdAt: { $gte: from, $lte: to } }),

    Order.countDocuments({
      businessId,
      $nor: [UNPAID_ONLINE_MATCH],
      createdAt: { $gte: from, $lte: to },
      status: OrderStatus.CANCELLED,
      $or: [
        { cancelledBy: CancelledBy.BUSINESS },
        { cancellationCode: CancellationReason.BUSINESS_NO_RESPONSE },
      ],
    }),
  ]);

  // Los que ya habían recibido un pedido de este comercio antes del periodo.
  const returningCount = clientIds.length
    ? (
        await Order.distinct('clientId', {
          businessId,
          ...DELIVERED_MATCH,
          createdAt: { $lt: from },
          clientId: { $in: clientIds },
        })
      ).length
    : 0;

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
    topProducts,
    avgPrepMinutes: prepRow[0]?.minutes != null ? Math.round(prepRow[0].minutes) : null,
    customers: {
      total: clientIds.length,
      new: clientIds.length - returningCount,
      returning: returningCount,
    },
    lostByBusiness: {
      orders: lost,
      rate: current.orders ? Math.round((lost / current.orders) * 100) : 0,
    },
  };
}

export const businessAnalyticsService = { analyticsFor };
