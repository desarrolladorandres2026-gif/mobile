import { Types } from 'mongoose';
import { UNPAID_ONLINE_MATCH } from '../utils/merchantVisibility';
import { Order, Review } from '../models';
import { OrderStatus, PaymentMethod, RefundStatus } from '../types';
import { bogotaDayRange, bogotaDateString, shiftDateString } from '../utils/period';
import { cashHandover } from './cashHandover.service';

/**
 * Cierre del día de UN comercio.
 *
 * Es el hermano de `dailySummary.service.ts` (el del admin) visto desde la
 * caja del negocio: nada de ingreso de ZIPP ni de domiciliarios, solo lo que
 * el comercio vendió, lo que se le descontó y lo que se le debe. El dinero
 * sale del snapshot inmutable `order.finance` —el mismo que usa la
 * liquidación—, así que este número y el de Liquidaciones no pueden
 * discrepar. El día se corta en hora de Bogotá.
 *
 * Neto de reembolsos: comisión, pago al comercio y lo cobrado (efectivo y
 * digital) restan los reembolsos COMPLETADOS del pedido entregado (`$lookup` a
 * `refunds`; el mismo `finance − Σ allocation` de `refundService.netOf`).
 * Limitación: `sales` (subtotal de producto) y `merchantFundedDiscount` quedan
 * en bruto, porque el reembolso parcial reparte por cuenta, no por ítem.
 */

export interface BusinessDaySnapshot {
  date: string;
  ordersCreated: number;
  ordersDelivered: number;
  ordersCancelled: number;
  /** Ventas de producto de lo entregado (sin domicilio ni propina). */
  sales: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  /** Lo que ZIPP le debe al comercio por lo entregado ese día. */
  businessPayout: number;
  avgTicket: number;
  /** Minutos entre aceptar y dejar listo, sobre lo que llegó a prepararse. */
  avgPrepMinutes: number;
  payDigitalCount: number;
  payDigitalAmount: number;
  payCashCount: number;
  /** Lo cobrado al cliente en efectivo, domicilio incluido. NO es lo que queda en caja. */
  payCashAmount: number;
  /** Lo que los domiciliarios pagaron al comercio en efectivo ese día: lo que debe haber en caja. */
  cashHandedOver: number;
  reviewsCount: number;
  avgRating: number;
  lowRatingsCount: number;
}

export interface BusinessComparisonRow {
  metric: keyof BusinessDaySnapshot;
  label: string;
  today: number;
  baseline: number;
  deltaAbs: number;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
  goodWhenUp: boolean;
}

export interface BusinessDailySummary {
  date: string;
  generatedAt: string;
  today: BusinessDaySnapshot;
  /** Mismo día de la semana anterior. */
  baseline: BusinessDaySnapshot;
  comparison: BusinessComparisonRow[];
  topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
  cancelReasons: Array<{ reason: string; count: number }>;
  byHour: Array<{ hour: number; orders: number }>;
  /** Pedidos abiertos ahora mismo. Solo si la fecha es hoy. */
  ordersInProgressNow: number | null;
}

const OPEN_STATUSES = [
  OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY,
  OrderStatus.PICKED_UP, OrderStatus.ON_WAY,
];

const round = (n: number) => Math.round(n ?? 0);

async function snapshot(businessId: Types.ObjectId, date: string): Promise<BusinessDaySnapshot> {
  const { from, to } = bogotaDayRange(date);
  const delivered = { $eq: ['$status', OrderStatus.DELIVERED] };
  const whenDelivered = (expr: unknown) => ({ $cond: [delivered, expr, 0] });
  const isCash = { $eq: ['$paymentMethod', PaymentMethod.CASH_ON_DELIVERY] };

  const [[orders], [reviews], handover] = await Promise.all([
    Order.aggregate([
      { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to } } },
      // `finance` es el techo inmutable; lo vivo es finance − Σ reembolsos
      // completados (ver `refundService.netOf`). Solo se trae lo necesario de
      // los pedidos ENTREGADOS, que son los que suman dinero aquí.
      {
        $lookup: {
          from: 'refunds',
          let: { oid: '$_id', isDelivered: delivered },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$orderId', '$$oid'] },
                    { $eq: ['$status', RefundStatus.COMPLETED] },
                    '$$isDelivered',
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                amount: { $sum: '$amount' },
                merchantPayout: { $sum: '$allocation.fromMerchantPayout' },
                commission: { $sum: '$allocation.fromCommission' },
              },
            },
          ],
          as: '_refunds',
        },
      },
      {
        $addFields: {
          refundedAmount: { $ifNull: [{ $first: '$_refunds.amount' }, 0] },
          refundedPayout: { $ifNull: [{ $first: '$_refunds.merchantPayout' }, 0] },
          refundedCommission: { $ifNull: [{ $first: '$_refunds.commission' }, 0] },
        },
      },
      {
        $group: {
          _id: null,
          created: { $sum: 1 },
          delivered: { $sum: whenDelivered(1) },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', OrderStatus.CANCELLED] }, 1, 0] } },
          sales: { $sum: whenDelivered({ $ifNull: ['$finance.productSubtotal', '$subtotal'] }) },
          commission: { $sum: whenDelivered({ $max: [0, { $subtract: [{ $ifNull: ['$finance.merchantCommission', 0] }, '$refundedCommission'] }] }) },
          merchantDiscount: { $sum: whenDelivered({ $ifNull: ['$finance.merchantFundedDiscount', 0] }) },
          payout: { $sum: whenDelivered({ $max: [0, { $subtract: [{ $ifNull: ['$finance.businessPayout', 0] }, '$refundedPayout'] }] }) },
          prepMinutes: {
            $avg: {
              $cond: [
                { $and: ['$acceptedAt', '$preparedAt'] },
                { $divide: [{ $subtract: ['$preparedAt', '$acceptedAt'] }, 60000] },
                null,
              ],
            },
          },
          cashCount: { $sum: { $cond: [{ $and: [delivered, isCash] }, 1, 0] } },
          cashAmount: { $sum: { $cond: [{ $and: [delivered, isCash] }, { $max: [0, { $subtract: [{ $ifNull: ['$finance.customerTotal', '$total'] }, '$refundedAmount'] }] }, 0] } },
          digitalCount: { $sum: { $cond: [{ $and: [delivered, { $not: [isCash] }] }, 1, 0] } },
          digitalAmount: { $sum: { $cond: [{ $and: [delivered, { $not: [isCash] }] }, { $max: [0, { $subtract: [{ $ifNull: ['$finance.customerTotal', '$total'] }, '$refundedAmount'] }] }, 0] } },
        },
      },
    ]),
    Review.aggregate([
      { $match: { businessId, createdAt: { $gte: from, $lte: to }, businessRating: { $ne: null } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avg: { $avg: '$businessRating' },
          low: { $sum: { $cond: [{ $lte: ['$businessRating', 2] }, 1, 0] } },
        },
      },
    ]),
    cashHandover(businessId, from, to),
  ]);

  const deliveredCount = orders?.delivered ?? 0;
  const sales = round(orders?.sales);
  return {
    date,
    ordersCreated: orders?.created ?? 0,
    ordersDelivered: deliveredCount,
    ordersCancelled: orders?.cancelled ?? 0,
    sales,
    merchantCommission: round(orders?.commission),
    merchantFundedDiscount: round(orders?.merchantDiscount),
    businessPayout: round(orders?.payout),
    avgTicket: deliveredCount ? Math.round(sales / deliveredCount) : 0,
    avgPrepMinutes: round(orders?.prepMinutes),
    payDigitalCount: orders?.digitalCount ?? 0,
    payDigitalAmount: round(orders?.digitalAmount),
    payCashCount: orders?.cashCount ?? 0,
    payCashAmount: round(orders?.cashAmount),
    cashHandedOver: handover.expectedCash,
    reviewsCount: reviews?.count ?? 0,
    avgRating: reviews?.avg ? Math.round(reviews.avg * 10) / 10 : 0,
    lowRatingsCount: reviews?.low ?? 0,
  };
}

const COMPARED: Array<[keyof BusinessDaySnapshot, string, boolean]> = [
  ['ordersCreated', 'Pedidos recibidos', true],
  ['ordersDelivered', 'Pedidos entregados', true],
  ['ordersCancelled', 'Cancelados', false],
  ['sales', 'Ventas', true],
  ['businessPayout', 'Neto para el negocio', true],
  ['avgTicket', 'Ticket promedio', true],
  ['avgPrepMinutes', 'Minutos de preparación', false],
];

function compare(today: BusinessDaySnapshot, baseline: BusinessDaySnapshot): BusinessComparisonRow[] {
  return COMPARED.map(([metric, label, goodWhenUp]) => {
    const t = today[metric] as number;
    const b = baseline[metric] as number;
    const deltaAbs = t - b;
    return {
      metric, label, goodWhenUp, today: t, baseline: b, deltaAbs,
      deltaPct: b === 0 ? null : Math.round((deltaAbs / b) * 100),
      direction: deltaAbs > 0 ? 'up' : deltaAbs < 0 ? 'down' : 'flat',
    };
  });
}

export async function summaryFor(businessIdRaw: string, dateRaw?: string): Promise<BusinessDailySummary> {
  const businessId = new Types.ObjectId(businessIdRaw);
  const todayStr = bogotaDateString();
  const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) && dateRaw <= todayStr ? dateRaw : todayStr;
  const baselineDate = shiftDateString(date, -7);
  const { from, to } = bogotaDayRange(date);

  const [today, baseline, topProducts, cancelReasons, byHour, inProgress] = await Promise.all([
    snapshot(businessId, date),
    snapshot(businessId, baselineDate),
    Order.aggregate([
      { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to }, status: OrderStatus.DELIVERED } },
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
      { $limit: 5 },
      { $project: { _id: 0, productId: { $toString: '$_id' }, name: 1, quantity: 1, sales: 1 } },
    ]),
    Order.aggregate([
      { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to }, status: OrderStatus.CANCELLED } },
      { $group: { _id: { $ifNull: ['$cancellationCode', { $ifNull: ['$cancellationReason', 'Sin motivo'] }] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, reason: '$_id', count: 1 } },
    ]),
    Order.aggregate([
      { $match: { businessId, $nor: [UNPAID_ONLINE_MATCH], createdAt: { $gte: from, $lte: to } } },
      // Hora de Bogotá, no la del servidor ni UTC.
      { $group: { _id: { $hour: { date: '$createdAt', timezone: 'America/Bogota' } }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', orders: 1 } },
    ]),
    date === todayStr
      ? Order.countDocuments({ businessId, status: { $in: OPEN_STATUSES }, $nor: [UNPAID_ONLINE_MATCH], $or: [{ scheduledFor: null }, { scheduledFor: { $exists: false } }, { scheduledActivatedAt: { $ne: null } }] })
      : Promise.resolve(null),
  ]);

  return {
    date,
    generatedAt: new Date().toISOString(),
    today,
    baseline,
    comparison: compare(today, baseline),
    topProducts,
    cancelReasons,
    byHour,
    ordersInProgressNow: inProgress,
  };
}

export const businessDailySummaryService = { summaryFor };
