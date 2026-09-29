import { Types } from 'mongoose';
import {
  Order,
  Payout,
  Settlement,
  Refund,
  Payment,
  CashReconciliation,
  LedgerEntry,
} from '../models';
import {
  CashReconciliationStatus,
  LedgerAccount,
  LedgerDirection,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  PayoutBeneficiary,
  PayoutStatus,
  RefundStatus,
  SettlementPaymentStatus,
} from '../types';
import { bogotaDayRange, bogotaDateString } from '../utils/period';
import { ledgerService } from './ledger.service';

/**
 * Lo que el Resumen diario dice de dinero AJENO y de la pasarela.
 *
 * Todo sale de fuentes que ya existen (libro mayor, Payout, Settlement,
 * Refund, CashReconciliation, Payment); aquí no se define ninguna métrica
 * nueva. Cada cifra dice de cuándo es: un saldo "al cierre" del día
 * consultado (libro) o "a hoy" (estados que no guardan historial).
 */

const F = (field: string) => ({ $ifNull: [`$finance.${field}`, 0] });

// ── Dinero de terceros ──────────────────────────────────────────────

export interface PayableSide {
  /** Saldo del libro (`*_PAYABLE`) al cierre del día consultado; incluye pedidos en curso y lotes sin pagar. */
  ledgerBalance: number;
  /** Solo si el día consultado es hoy. Payout devengado que aún no es exigible. */
  accrued: number | null;
  /** Solo hoy. Exigible (`payable`) sin liquidar. */
  payable: number | null;
  /** Solo hoy. Lotes reclamados (`Settlement`) cuya transferencia aún no se paga. */
  claimedUnpaid: number | null;
}

export interface PendingMoney {
  asOf: 'close_of_day' | 'now';
  merchants: PayableSide;
  drivers: PayableSide;
  /** Solo hoy: propinas dentro de pagos a domiciliarios aún sin pagar. `null` = no calculable para una fecha pasada. */
  tipsPending: number | null;
  /** Reembolsos que fallaron o llevan más de 15 min en curso (definición `attention` de refund.service). */
  refundsPending: { count: number; amount: number };
  /** Efectivo cobrado por domiciliarios y aún no conciliado (todo lo que no está `settled`). */
  cashToReconcile: { count: number; amount: number };
}

async function payableSide(
  beneficiary: PayoutBeneficiary,
  account: LedgerAccount,
  end: Date,
  isToday: boolean
): Promise<PayableSide> {
  const { balance } = await ledgerService.accountBalance(account, { createdAt: { $lte: end } });
  const side: PayableSide = { ledgerBalance: -balance, accrued: null, payable: null, claimedUnpaid: null };
  if (!isToday) return side;

  const [payouts, claimed] = await Promise.all([
    Payout.aggregate([
      { $match: { beneficiary, status: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] } } },
      {
        $group: {
          _id: '$status',
          net: {
            $sum: {
              $cond: [
                '$isClawback',
                { $subtract: ['$reversedAmount', '$amount'] },
                { $subtract: ['$amount', '$reversedAmount'] },
              ],
            },
          },
        },
      },
    ]),
    Settlement.aggregate([
      { $match: { beneficiary, paymentStatus: SettlementPaymentStatus.PENDING } },
      { $group: { _id: null, net: { $sum: '$netAmount' } } },
    ]),
  ]);
  const pick = (status: PayoutStatus) => payouts.find((p) => p._id === status)?.net ?? 0;
  side.accrued = pick(PayoutStatus.ACCRUED);
  side.payable = pick(PayoutStatus.PAYABLE);
  side.claimedUnpaid = claimed[0]?.net ?? 0;
  return side;
}

/**
 * Propinas dentro de pagos a domiciliarios sin pagar. Solo se cuentan los
 * payouts sin reversión: un reembolso parcial nunca toca al domiciliario, así
 * que `reversedAmount` vale 0 o el total y la propina va entera o no va.
 */
async function pendingTips(): Promise<number> {
  const rows = await Payout.aggregate([
    {
      $match: {
        beneficiary: PayoutBeneficiary.DRIVER,
        status: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] },
        isClawback: { $ne: true },
        reversedAmount: 0,
      },
    },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
    { $unwind: '$order' },
    { $group: { _id: null, tips: { $sum: { $ifNull: ['$order.finance.tip', 0] } } } },
  ]);
  return rows[0]?.tips ?? 0;
}

async function refundsNeedingAttention(end: Date) {
  const stalePending = new Date(Math.min(Date.now(), end.getTime()) - 15 * 60_000);
  const rows = await Refund.find({
    createdAt: { $lte: end },
    $or: [{ status: RefundStatus.FAILED }, { status: RefundStatus.PENDING, createdAt: { $lt: stalePending } }],
  })
    .select('amount status orderId')
    .lean();
  if (rows.length === 0) return { count: 0, amount: 0 };

  // Un fallido cuyo pedido ya se reembolsó con éxito (el reintento) no es pendiente.
  const failedOrderIds = rows.filter((r) => r.status === RefundStatus.FAILED).map((r) => r.orderId);
  const done = failedOrderIds.length
    ? await Refund.find({ orderId: { $in: failedOrderIds }, status: RefundStatus.COMPLETED }).select('orderId').lean()
    : [];
  const doneSet = new Set(done.map((d) => String(d.orderId)));
  const open = rows.filter((r) => !(r.status === RefundStatus.FAILED && doneSet.has(String(r.orderId))));
  return { count: open.length, amount: open.reduce((sum, r) => sum + (r.amount ?? 0), 0) };
}

async function cashOutstanding(end: Date) {
  const rows = await CashReconciliation.aggregate([
    { $match: { createdAt: { $lte: end }, status: { $ne: CashReconciliationStatus.SETTLED } } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]);
  return { count: rows[0]?.count ?? 0, amount: rows[0]?.amount ?? 0 };
}

// ── Pasarela (Wompi) ────────────────────────────────────────────────

export type GatewayState = 'no_charges' | 'not_configured' | 'incomplete' | 'ok';

export interface GatewayStatus {
  state: GatewayState;
  /** Comisión asentada en el libro para los cobros del día (COP). */
  booked: number;
  /** Cobros en línea del día. */
  charges: number;
  /** Cobros sin asiento de comisión. */
  missing: number;
}

/**
 * ¿La comisión de la pasarela está completa este día? Se mide por cobro
 * —no por tarifa configurada— porque una tarifa a medias (tarjeta sí, Nequi
 * no) pasa como "configurada" y aun así deja cobros sin comisión.
 */
async function gatewayStatus(start: Date, end: Date): Promise<GatewayStatus> {
  const charged = await Payment.find({
    type: PaymentType.ORDER_PAYMENT,
    method: PaymentMethod.ONLINE,
    status: { $in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
    orderId: { $ne: null },
    $or: [
      { processedAt: { $gte: start, $lte: end } },
      { processedAt: null, createdAt: { $gte: start, $lte: end } },
    ],
  })
    .select('orderId')
    .lean();
  const orderIds = [...new Set(charged.map((c) => String(c.orderId)))];
  if (orderIds.length === 0) return { state: 'no_charges', booked: 0, charges: 0, missing: 0 };

  const entries = await LedgerEntry.aggregate([
    {
      $match: {
        account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE,
        orderId: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
      },
    },
    {
      $group: {
        _id: '$orderId',
        net: { $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', { $multiply: ['$amount', -1] }] } },
      },
    },
  ]);
  const booked = entries.reduce((sum, e) => sum + e.net, 0);
  const missing = orderIds.length - entries.length;
  const state: GatewayState = entries.length === 0 ? 'not_configured' : missing > 0 ? 'incomplete' : 'ok';
  return { state, booked, charges: orderIds.length, missing };
}

// ── Detalle por pedido ──────────────────────────────────────────────

export interface FinanceDetailRow {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  closedAt: string | null;
  gmv: number;
  commission: number;
  serviceFee: number;
  deliveryMargin: number;
  merchantFundedDiscount: number;
  platformFundedDiscount: number;
  businessPayout: number;
  driverPayout: number;
  tip: number;
  /** Comisión de la pasarela asentada; `null` si el cobro en línea no tiene asiento. */
  gatewayFee: number | null;
  refunded: number;
  paymentStatus: string | null;
  cashStatus: string | null;
  businessPayoutStatus: string | null;
  driverPayoutStatus: string | null;
}

export interface FinanceDetail {
  date: string;
  page: number;
  limit: number;
  total: number;
  rows: FinanceDetailRow[];
}

export const DETAIL_MAX_LIMIT = 200;

export const dailySummaryFinanceService = {
  async pending(date: string): Promise<PendingMoney> {
    const { to: end } = bogotaDayRange(date);
    const isToday = date === bogotaDateString();
    const [merchants, drivers, tipsPending, refundsPending, cashToReconcile] = await Promise.all([
      payableSide(PayoutBeneficiary.BUSINESS, LedgerAccount.MERCHANT_PAYABLE, end, isToday),
      payableSide(PayoutBeneficiary.DRIVER, LedgerAccount.DRIVER_PAYABLE, end, isToday),
      isToday ? pendingTips() : Promise.resolve(null),
      refundsNeedingAttention(end),
      cashOutstanding(end),
    ]);
    return {
      asOf: isToday ? 'now' : 'close_of_day',
      merchants,
      drivers,
      tipsPending,
      refundsPending,
      cashToReconcile,
    };
  },

  gateway(date: string): Promise<GatewayStatus> {
    const { from, to } = bogotaDayRange(date);
    return gatewayStatus(from, to);
  },

  /** Una fila por pedido entregado o cancelado ese día, con lo que se debe y a quién. */
  async detail(date: string, page = 1, limit = 50): Promise<FinanceDetail> {
    const { from, to } = bogotaDayRange(date);
    const safeLimit = Math.min(Math.max(1, limit), DETAIL_MAX_LIMIT);
    const safePage = Math.max(1, page);
    const inDay = { $gte: from, $lte: to };
    const filter = {
      $or: [
        { status: OrderStatus.DELIVERED, deliveredAt: inDay },
        { status: OrderStatus.CANCELLED, cancelledAt: inDay },
      ],
    };

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ deliveredAt: 1, cancelledAt: 1, _id: 1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .select('orderNumber status paymentMethod deliveredAt cancelledAt finance total businessPayout driverPayout tip')
        .lean(),
      Order.countDocuments(filter),
    ]);

    const ids = orders.map((o) => o._id);
    const [fees, refunds, payments, cash, payouts] = ids.length
      ? await Promise.all([
          LedgerEntry.aggregate([
            { $match: { account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE, orderId: { $in: ids } } },
            {
              $group: {
                _id: '$orderId',
                net: { $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', { $multiply: ['$amount', -1] }] } },
              },
            },
          ]),
          Refund.aggregate([
            { $match: { orderId: { $in: ids }, status: RefundStatus.COMPLETED } },
            { $group: { _id: '$orderId', amount: { $sum: '$amount' } } },
          ]),
          Payment.find({ orderId: { $in: ids }, type: PaymentType.ORDER_PAYMENT }).select('orderId status').lean(),
          CashReconciliation.find({ orderId: { $in: ids } }).select('orderId status').lean(),
          Payout.find({ orderId: { $in: ids }, isClawback: { $ne: true } }).select('orderId beneficiary status').lean(),
        ])
      : [[], [], [], [], []];

    const feeBy = new Map(fees.map((f) => [String(f._id), f.net as number]));
    const refundBy = new Map(refunds.map((r) => [String(r._id), r.amount as number]));
    const paymentBy = new Map(payments.map((p) => [String(p.orderId), p.status as string]));
    const cashBy = new Map(cash.map((c) => [String(c.orderId), c.status as string]));
    const payoutStatus = (orderId: string, who: PayoutBeneficiary) =>
      payouts.find((p) => String(p.orderId) === orderId && p.beneficiary === who)?.status ?? null;

    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    const rows: FinanceDetailRow[] = orders.map((o) => {
      const id = String(o._id);
      const f = (o.finance ?? {}) as Record<string, unknown>;
      const online = o.paymentMethod === PaymentMethod.ONLINE;
      const closedAt = o.deliveredAt ?? o.cancelledAt ?? null;
      return {
        orderId: id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentMethod: o.paymentMethod,
        closedAt: closedAt ? new Date(closedAt).toISOString() : null,
        gmv: num(f.customerTotal) || num((o as { total?: number }).total),
        commission: num(f.merchantCommission),
        serviceFee: num(f.customerServiceFee),
        deliveryMargin: num(f.deliveryMargin),
        merchantFundedDiscount: num(f.merchantFundedDiscount),
        platformFundedDiscount: num(f.platformFundedDiscount),
        businessPayout: num(f.businessPayout) || num((o as { businessPayout?: number }).businessPayout),
        driverPayout: num(f.driverPayout) || num((o as { driverPayout?: number }).driverPayout),
        tip: num(f.tip) || num((o as { tip?: number }).tip),
        gatewayFee: online ? feeBy.get(id) ?? null : 0,
        refunded: refundBy.get(id) ?? 0,
        paymentStatus: paymentBy.get(id) ?? null,
        cashStatus: cashBy.get(id) ?? null,
        businessPayoutStatus: payoutStatus(id, PayoutBeneficiary.BUSINESS),
        driverPayoutStatus: payoutStatus(id, PayoutBeneficiary.DRIVER),
      };
    });

    return { date, page: safePage, limit: safeLimit, total, rows };
  },
};
