import { Payment, LedgerEntry } from '../models';
import { PaymentMethod, PaymentStatus, LedgerAccount, LedgerDirection } from '../types';
import { AppError } from '../middlewares';
import { pricingConfigService } from './pricingConfig.service';
import { estimateGatewayFee, gatewayFeeMethod } from '../utils/gatewayFee';
import { bogotaDateString, customRange, type DateRange } from '../utils/period';

/**
 * Lectura de los cobros en línea para finanzas: el listado por estado y
 * método, y la conciliación diaria contra los desembolsos de Wompi.
 *
 * Solo lee. La comisión que se enseña por fila es la **estimada con la tarifa
 * vigente**; la que de verdad está en el libro es la del día de cada cobro
 * (`PAYMENT_PROCESSING_EXPENSE`), y por eso la conciliación las muestra
 * separadas: si el dueño cambia su tarifa, el pasado no se reescribe.
 */

const MAX_DAILY_ROWS = 20_000;

export interface PaymentListParams {
  status?: PaymentStatus;
  methodType?: string;
  range?: DateRange;
  page?: number;
  limit?: number;
}

export const paymentReportService = {
  async list(params: PaymentListParams) {
    const filter: Record<string, unknown> = { method: PaymentMethod.ONLINE };
    if (params.status) filter.status = params.status;
    if (params.methodType) filter.paymentMethodType = params.methodType.toUpperCase();
    if (params.range) filter.createdAt = { $gte: params.range.from, $lte: params.range.to };

    const limit = params.limit ?? 25;
    const page = Math.max(1, params.page ?? 1);
    const config = await pricingConfigService.getCurrent();

    const [rows, total, byStatus] = await Promise.all([
      Payment.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('orderId', 'orderNumber')
        .select('-metadata -statusHistory')
        .lean(),
      Payment.countDocuments(filter),
      Payment.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
    ]);

    const items = rows.map((p: any) => ({
      _id: String(p._id),
      orderId: p.orderId ? String(p.orderId._id ?? p.orderId) : null,
      orderNumber: p.orderId?.orderNumber ?? null,
      type: p.type,
      status: p.status,
      gatewayStatus: p.gatewayStatus ?? null,
      methodType: p.paymentMethodType ?? null,
      amount: p.amount,
      reference: p.reference ?? null,
      transactionId: p.transactionId ?? null,
      estimatedFee: p.status === PaymentStatus.PAID || p.status === PaymentStatus.REFUNDED
        ? estimateGatewayFee(config, p.paymentMethodType, p.amount)
        : 0,
      createdAt: p.createdAt,
      processedAt: p.processedAt ?? null,
    }));

    const totals: Record<string, { count: number; amount: number }> = {};
    for (const row of byStatus) totals[row._id as string] = { count: row.count, amount: row.amount };

    return { items, totals, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  },

  /**
   * Cobros aprobados por día de Bogotá y método, con lo que debería llegar
   * a la cuenta bancaria (cobrado − comisión asentada). Se compara con el
   * reporte de desembolsos de Wompi; una diferencia es una comisión mal
   * estimada o un cobro que Wompi no liquidó.
   */
  async daily(range: DateRange) {
    const rows = await Payment.find({
      method: PaymentMethod.ONLINE,
      status: { $in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
      // `processedAt` es cuándo se aprobó; los cobros viejos sin él usan la creación.
      $or: [
        { processedAt: { $gte: range.from, $lte: range.to } },
        { processedAt: null, createdAt: { $gte: range.from, $lte: range.to } },
      ],
    })
      .select('amount paymentMethodType processedAt createdAt orderId')
      .limit(MAX_DAILY_ROWS + 1)
      .lean();
    if (rows.length > MAX_DAILY_ROWS) {
      throw new AppError('El rango tiene demasiados cobros para conciliar de una vez. Usa un rango más corto.', 422);
    }

    const config = await pricingConfigService.getCurrent();
    const days = new Map<string, { date: string; count: number; gross: number; estimatedFee: number; byMethod: Record<string, { count: number; amount: number }> }>();
    for (const p of rows as any[]) {
      const date = bogotaDateString(new Date(p.processedAt ?? p.createdAt));
      const day = days.get(date) ?? { date, count: 0, gross: 0, estimatedFee: 0, byMethod: {} };
      const method = gatewayFeeMethod(p.paymentMethodType);
      day.count += 1;
      day.gross += p.amount;
      day.estimatedFee += estimateGatewayFee(config, p.paymentMethodType, p.amount);
      const bucket = day.byMethod[method] ?? { count: 0, amount: 0 };
      bucket.count += 1;
      bucket.amount += p.amount;
      day.byMethod[method] = bucket;
      days.set(date, day);
    }

    // Lo asentado en el libro por día: es la comisión que ya cuenta en el resultado.
    const booked: Array<{ _id: string; balance: number }> = await LedgerEntry.aggregate([
      {
        $match: {
          account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE,
          createdAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '-05:00' } },
          balance: {
            $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', { $multiply: ['$amount', -1] }] },
          },
        },
      },
    ]);
    const bookedByDay = new Map(booked.map((b) => [b._id, b.balance]));

    const items = [...days.values()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((d) => {
        const bookedFee = bookedByDay.get(d.date) ?? 0;
        return { ...d, bookedFee, expectedDeposit: d.gross - bookedFee };
      });

    return {
      items,
      totals: items.reduce(
        (acc, d) => ({
          count: acc.count + d.count,
          gross: acc.gross + d.gross,
          bookedFee: acc.bookedFee + d.bookedFee,
          expectedDeposit: acc.expectedDeposit + d.expectedDeposit,
        }),
        { count: 0, gross: 0, bookedFee: 0, expectedDeposit: 0 }
      ),
      feeConfigured: [
        config.gatewayCardBps, config.gatewayCardFixed, config.gatewayPseBps, config.gatewayPseFixed,
        config.gatewayNequiBps, config.gatewayNequiFixed, config.gatewayOtherBps, config.gatewayOtherFixed,
      ].some((v) => (v ?? 0) > 0),
    };
  },

  /** Rango `YYYY-MM-DD` de la petición; por defecto, los últimos `defaultDays` días. */
  parseRange(from?: string, to?: string, defaultDays = 14): DateRange {
    const today = bogotaDateString();
    if (!from && !to) {
      const start = bogotaDateString(new Date(Date.now() - (defaultDays - 1) * 86_400_000));
      return customRange(start, today) as DateRange;
    }
    const range = customRange(from || to || '', to || from || '');
    if (!range) throw new AppError('Rango de fechas inválido (usa AAAA-MM-DD, desde ≤ hasta)', 400);
    return range;
  },
};
