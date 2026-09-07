import { Types } from 'mongoose';
import { Payout, Settlement, IOrder, IPayout, ISettlement } from '../models';
import { AppError } from '../middlewares';
import { config } from '../config';
import { PayoutStatus, PayoutBeneficiary, PaymentStatus } from '../types';
import { assertMoney } from '../utils';

/**
 * Una venta vista desde la liquidación del comercio.
 *
 * Es la fila que hace posible recorrer los dos sentidos que pide el
 * negocio: del pedido a la liquidación en la que se cobró, y de una
 * liquidación a los pedidos que la componen. Los importes no se
 * recalculan aquí —salen del `finance` congelado del pedido y del
 * `Payout` que lo acompaña— porque un extracto que vuelve a calcular es
 * un extracto que un día deja de cuadrar con lo que se pagó.
 */
export interface StatementLine {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  paymentMethod: string;
  createdAt: Date;
  deliveredAt: Date | null;
  /** VENTA: lo que costaron los productos. */
  productSubtotal: number;
  /** COMISIÓN ZIPP. */
  merchantCommission: number;
  /** AJUSTE: promoción que asumió el propio comercio. */
  merchantFundedDiscount: number;
  /** AJUSTE: reembolsos y contracargos que revirtieron el pago. */
  reversedAmount: number;
  /** NETO COMERCIO = venta − comisión − descuento propio − reversiones. */
  netAmount: number;
  payoutStatus: PayoutStatus;
  becamePayableAt: Date | null;
  settledAt: Date | null;
  settlementId: string | null;
}

export interface StatementTotals {
  orderCount: number;
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  reversedAmount: number;
  netAmount: number;
}

export interface StatementPeriod extends StatementTotals {
  periodStart: Date;
  periodEnd: Date;
}

const ZERO_TOTALS: StatementTotals = {
  orderCount: 0,
  productSubtotal: 0,
  merchantCommission: 0,
  merchantFundedDiscount: 0,
  reversedAmount: 0,
  netAmount: 0,
};

/**
 * Tracks what the platform owes merchants and drivers, and settles it.
 *
 * The obligation is deliberately separate from the order: an order can be
 * delivered while its payout is still ACCRUED because the payment has not
 * cleared, and a refund can reverse a payout without rewriting order
 * history. Dashboards read this, so "pendiente" and "liquidado" are real
 * states instead of numbers inferred from order status.
 */
export class PayoutService {
  /**
   * Creates (or returns) the two payouts an order generates.
   *
   * Idempotent through the unique (orderId, beneficiary) index, so a
   * retried delivery webhook cannot double-accrue.
   *
   * A payout starts PAYABLE when the order's money is already in, and
   * ACCRUED otherwise. That distinction has to be read from the order's
   * payment status rather than assumed from call order: `release()` only
   * moves the payouts that exist when the capture lands, and the driver's
   * payout does not exist until a courier is assigned — which for an online
   * order now happens *after* the customer has paid. Deriving the state from
   * the fact rather than the sequence is what keeps a driver from being
   * stranded in ACCRUED forever.
   */
  async accrueForOrder(order: IOrder): Promise<IPayout[]> {
    const finance = order.finance;
    const alreadyCaptured = order.paymentStatus === PaymentStatus.PAID;
    const initialStatus = alreadyCaptured ? PayoutStatus.PAYABLE : PayoutStatus.ACCRUED;
    const results: IPayout[] = [];

    const specs: Array<{
      beneficiary: PayoutBeneficiary;
      amount: number;
      businessId?: Types.ObjectId | null;
      driverId?: Types.ObjectId | null;
    }> = [
      {
        beneficiary: PayoutBeneficiary.BUSINESS,
        amount: finance.businessPayout,
        businessId: order.businessId,
      },
    ];

    if (order.driverId) {
      specs.push({
        beneficiary: PayoutBeneficiary.DRIVER,
        amount: finance.driverPayout,
        driverId: order.driverId,
      });
    }

    for (const spec of specs) {
      assertMoney(spec.amount, `payout ${spec.beneficiary}`);

      const existing = await Payout.findOne({
        orderId: order._id,
        beneficiary: spec.beneficiary,
      });
      if (existing) {
        results.push(existing);
        continue;
      }

      try {
        const created = await Payout.create({
          orderId: order._id,
          beneficiary: spec.beneficiary,
          businessId: spec.businessId ?? null,
          driverId: spec.driverId ?? null,
          amount: spec.amount,
          status: initialStatus,
          becamePayableAt: alreadyCaptured ? new Date() : null,
          currency: finance.currency,
          pricingConfigVersion: finance.pricingConfigVersion,
        });
        results.push(created);
      } catch (error: any) {
        if (error?.code === 11000) {
          const raced = await Payout.findOne({
            orderId: order._id,
            beneficiary: spec.beneficiary,
          });
          if (raced) results.push(raced);
        } else {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Marks an order's payouts as eligible for the next settlement run.
   *
   * Only called once the money is actually ours: a captured digital payment
   * or a verified cash remittance. Accruing and releasing are separate on
   * purpose — paying a merchant for an order we never collected is how a
   * marketplace bleeds money.
   */
  async release(orderId: string | Types.ObjectId): Promise<number> {
    const result = await Payout.updateMany(
      { orderId, status: PayoutStatus.ACCRUED },
      { $set: { status: PayoutStatus.PAYABLE, becamePayableAt: new Date() } }
    );
    return result.modifiedCount ?? 0;
  }

  /**
   * Closes an order's payouts that were discharged in cash at the door.
   *
   * Distinct from `settle`: no transfer batch exists, because ZIPP never
   * moved the money — the driver did, from their own fund. Marking these
   * PAYABLE instead would put them in the next settlement run and pay the
   * merchant a second time.
   */
  async dischargeInCash(orderId: string | Types.ObjectId): Promise<number> {
    const now = new Date();
    const result = await Payout.updateMany(
      { orderId, status: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] } },
      { $set: { status: PayoutStatus.SETTLED, becamePayableAt: now, settledAt: now } }
    );
    return result.modifiedCount ?? 0;
  }

  /** Reverses part or all of an order's payouts after a refund. */
  async reverse(
    orderId: string | Types.ObjectId,
    amounts: { business?: number; driver?: number }
  ): Promise<void> {
    const entries: Array<[PayoutBeneficiary, number]> = [
      [PayoutBeneficiary.BUSINESS, amounts.business ?? 0],
      [PayoutBeneficiary.DRIVER, amounts.driver ?? 0],
    ];

    for (const [beneficiary, amount] of entries) {
      if (amount <= 0) continue;

      const payout = await Payout.findOne({ orderId, beneficiary });
      if (!payout) continue;

      if (payout.status === PayoutStatus.SETTLED) {
        // Already paid out. Reversing it here would misstate the balance:
        // it becomes a receivable against the beneficiary, handled by the
        // next settlement run rather than silently deleted.
        payout.reversedAmount = Math.min(payout.amount, payout.reversedAmount + amount);
        await payout.save();
        continue;
      }

      payout.reversedAmount = Math.min(payout.amount, payout.reversedAmount + amount);
      if (payout.reversedAmount >= payout.amount) {
        payout.status = PayoutStatus.REVERSED;
      }
      await payout.save();
    }
  }

  /** Everything owed to one beneficiary, grouped by state. */
  async summaryFor(params: {
    beneficiary: PayoutBeneficiary;
    businessId?: string;
    driverId?: string;
  }) {
    const match: Record<string, unknown> = { beneficiary: params.beneficiary };
    if (params.businessId) match.businessId = new Types.ObjectId(params.businessId);
    if (params.driverId) match.driverId = new Types.ObjectId(params.driverId);

    const rows = await Payout.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$status',
          gross: { $sum: '$amount' },
          reversed: { $sum: '$reversedAmount' },
          count: { $sum: 1 },
        },
      },
    ]);

    const byStatus: Record<string, { gross: number; reversed: number; net: number; count: number }> = {};
    for (const row of rows) {
      byStatus[row._id] = {
        gross: row.gross,
        reversed: row.reversed,
        net: row.gross - row.reversed,
        count: row.count,
      };
    }

    const pick = (status: PayoutStatus) => byStatus[status]?.net ?? 0;

    return {
      byStatus,
      accrued: pick(PayoutStatus.ACCRUED),
      payable: pick(PayoutStatus.PAYABLE),
      settled: pick(PayoutStatus.SETTLED),
      /** What we still owe: accrued + payable. */
      outstanding: pick(PayoutStatus.ACCRUED) + pick(PayoutStatus.PAYABLE),
    };
  }

  /**
   * Settles every PAYABLE payout for one beneficiary into a batch.
   *
   * The batch is written first and the payouts point at it, so a crash
   * mid-run leaves payouts unsettled (safe to retry) rather than settled
   * with no record of the transfer.
   */
  async settle(params: {
    beneficiary: PayoutBeneficiary;
    businessId?: string;
    driverId?: string;
    reference?: string;
    createdBy: string;
  }): Promise<{ settlement: ISettlement | null; count: number; netAmount: number }> {
    const match: Record<string, unknown> = {
      beneficiary: params.beneficiary,
      status: PayoutStatus.PAYABLE,
    };
    if (params.businessId) match.businessId = new Types.ObjectId(params.businessId);
    if (params.driverId) match.driverId = new Types.ObjectId(params.driverId);

    const payouts = await Payout.find(match).sort({ becamePayableAt: 1 });
    if (payouts.length === 0) {
      return { settlement: null, count: 0, netAmount: 0 };
    }

    const grossAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
    const reversedAmount = payouts.reduce((sum, p) => sum + p.reversedAmount, 0);
    const netAmount = grossAmount - reversedAmount;

    if (netAmount < 0) {
      throw new AppError(
        'La liquidación resultaría negativa: revisa las reversiones antes de liquidar',
        409
      );
    }

    const dates = payouts.map((p) => p.becamePayableAt ?? p.createdAt);

    const settlement = await Settlement.create({
      beneficiary: params.beneficiary,
      businessId: params.businessId ?? null,
      driverId: params.driverId ?? null,
      periodStart: new Date(Math.min(...dates.map((d) => d.getTime()))),
      periodEnd: new Date(Math.max(...dates.map((d) => d.getTime()))),
      payoutCount: payouts.length,
      grossAmount,
      reversedAmount,
      netAmount,
      reference: params.reference ?? '',
      createdBy: params.createdBy,
    });

    await Payout.updateMany(
      { _id: { $in: payouts.map((p) => p._id) } },
      {
        $set: {
          status: PayoutStatus.SETTLED,
          settledAt: new Date(),
          settlementId: settlement._id,
        },
      }
    );

    return { settlement, count: payouts.length, netAmount };
  }

  // ── Extracto del comercio ──────────────────────────────────────────

  /**
   * Une cada payout con el `finance` del pedido que lo originó.
   *
   * El `$lookup` es lo que permite que el comercio vea la fórmula completa
   * —venta, comisión, ajustes, neto— en vez de un único número sin
   * explicación. Los pipelines de resumen y de detalle comparten esta
   * etapa a propósito: si divergieran, el total del encabezado dejaría de
   * cuadrar con la suma de las filas y nadie sabría cuál de los dos
   * miente.
   */
  private statementPipeline(businessId: string, from?: Date, to?: Date) {
    const match: Record<string, unknown> = {
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: new Types.ObjectId(businessId),
    };

    // Una reversión total deja el payout en REVERSED: sigue formando parte
    // del extracto —hay que poder explicar por qué ese pedido no se pagó—
    // así que no se filtra por estado aquí.
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = from;
      if (to) range.$lte = to;
      match.createdAt = range;
    }

    return [
      { $match: match },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
        },
      },
      { $unwind: '$order' },
      {
        $project: {
          orderId: '$order._id',
          orderNumber: '$order.orderNumber',
          orderStatus: '$order.status',
          paymentMethod: '$order.paymentMethod',
          createdAt: '$order.createdAt',
          deliveredAt: { $ifNull: ['$order.deliveredAt', null] },
          productSubtotal: { $ifNull: ['$order.finance.productSubtotal', '$order.subtotal'] },
          merchantCommission: {
            $ifNull: ['$order.finance.merchantCommission', '$order.platformCommission'],
          },
          merchantFundedDiscount: { $ifNull: ['$order.finance.merchantFundedDiscount', 0] },
          reversedAmount: '$reversedAmount',
          netAmount: { $subtract: ['$amount', '$reversedAmount'] },
          payoutStatus: '$status',
          becamePayableAt: 1,
          settledAt: 1,
          settlementId: 1,
        },
      },
    ];
  }

  /** Suma un pipeline de extracto en una sola fila de totales. */
  private static totalsStage() {
    return {
      $group: {
        _id: null,
        orderCount: { $sum: 1 },
        productSubtotal: { $sum: '$productSubtotal' },
        merchantCommission: { $sum: '$merchantCommission' },
        merchantFundedDiscount: { $sum: '$merchantFundedDiscount' },
        reversedAmount: { $sum: '$reversedAmount' },
        netAmount: { $sum: '$netAmount' },
      },
    };
  }

  /**
   * El extracto que ve un comercio: qué se le debe, de qué semana viene y
   * qué se le ha liquidado ya.
   *
   * Todos los importes salen de aquí y ninguno del navegador. El panel
   * antes sumaba los pedidos del día en JavaScript para enseñar "tu
   * ganancia neta"; bastaba con que la página no hubiera cargado un pedido
   * —el listado viene paginado— para que el comercio viera menos dinero
   * del que se le debe.
   */
  async merchantStatement(params: { businessId: string; weeks?: number }) {
    const weeks = Math.min(52, Math.max(1, params.weeks ?? config.settlement.historyWeeks));
    const since = new Date(Date.now() - weeks * 7 * 24 * 3600_000);
    const { timezone, startOfWeek } = config.settlement;

    const [summary, weekRows, currentRows, settlements] = await Promise.all([
      this.summaryFor({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: params.businessId,
      }),

      // Histórico por semana. `$dateTrunc` corta en la zona horaria del
      // negocio: agrupar en UTC movería la frontera cinco horas y los
      // pedidos del domingo por la noche caerían en la semana siguiente.
      Payout.aggregate([
        ...this.statementPipeline(params.businessId, since),
        {
          $group: {
            _id: {
              $dateTrunc: { date: '$createdAt', unit: 'week', startOfWeek, timezone },
            },
            orderCount: { $sum: 1 },
            productSubtotal: { $sum: '$productSubtotal' },
            merchantCommission: { $sum: '$merchantCommission' },
            merchantFundedDiscount: { $sum: '$merchantFundedDiscount' },
            reversedAmount: { $sum: '$reversedAmount' },
            netAmount: { $sum: '$netAmount' },
          },
        },
        { $sort: { _id: -1 } },
      ]),

      // Lo que todavía no se ha liquidado: la próxima consignación.
      Payout.aggregate([
        ...this.statementPipeline(params.businessId),
        {
          $match: {
            payoutStatus: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] },
          },
        },
        PayoutService.totalsStage(),
      ]),

      this.listSettlements({
        beneficiary: PayoutBeneficiary.BUSINESS,
        businessId: params.businessId,
        limit: 20,
      }),
    ]);

    const toPeriod = (row: any): StatementPeriod => ({
      periodStart: row._id,
      periodEnd: new Date(new Date(row._id).getTime() + 7 * 24 * 3600_000 - 1),
      orderCount: row.orderCount,
      productSubtotal: row.productSubtotal,
      merchantCommission: row.merchantCommission,
      merchantFundedDiscount: row.merchantFundedDiscount,
      reversedAmount: row.reversedAmount,
      netAmount: row.netAmount,
    });

    const currentTotals = { ...ZERO_TOTALS, ...(currentRows[0] ?? {}) } as any;
    delete currentTotals._id;

    return {
      /** Deuda viva total, sin importar de qué semana venga. */
      outstanding: summary.outstanding,
      accrued: summary.accrued,
      payable: summary.payable,
      settled: summary.settled,
      /** Lo que entrará en la próxima liquidación. */
      nextSettlement: currentTotals as StatementTotals,
      weeks: weekRows.map(toPeriod),
      settlements,
    };
  }

  /**
   * Las ventas que componen una parte del extracto.
   *
   * Con `settlementId` responde "qué pedidos pagó esta liquidación"; sin
   * él y con `statuses`, "qué pedidos entrarán en la próxima". Es el mismo
   * pipeline en los dos sentidos, que es lo que garantiza que las dos
   * lecturas cuadren.
   */
  async merchantStatementLines(params: {
    businessId: string;
    orderId?: string;
    settlementId?: string;
    statuses?: PayoutStatus[];
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ lines: StatementLine[]; totals: StatementTotals; meta: any }> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));

    const filters: Record<string, unknown> = {};
    // Un solo pedido: es el camino Venta → Liquidación que necesita la
    // ficha del pedido para decir en qué consignación se cobró.
    if (params.orderId) {
      if (!Types.ObjectId.isValid(params.orderId)) {
        throw new AppError('Pedido no encontrado', 404);
      }
      filters.orderId = new Types.ObjectId(params.orderId);
    }
    if (params.settlementId) {
      if (!Types.ObjectId.isValid(params.settlementId)) {
        throw new AppError('Liquidación no encontrada', 404);
      }
      filters.settlementId = new Types.ObjectId(params.settlementId);
    }
    if (params.statuses?.length) filters.payoutStatus = { $in: params.statuses };

    const base: any[] = [
      ...this.statementPipeline(params.businessId, params.from, params.to),
      ...(Object.keys(filters).length ? [{ $match: filters }] : []),
    ];

    const [rows, totalsRows, countRows] = await Promise.all([
      Payout.aggregate([
        ...base,
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]),
      Payout.aggregate([...base, PayoutService.totalsStage()]),
      Payout.aggregate([...base, { $count: 'total' }]),
    ]);

    const totals = { ...ZERO_TOTALS, ...(totalsRows[0] ?? {}) } as any;
    delete totals._id;
    const total = countRows[0]?.total ?? 0;

    return {
      lines: rows.map((row) => ({
        ...row,
        orderId: row.orderId.toString(),
        settlementId: row.settlementId ? row.settlementId.toString() : null,
      })) as StatementLine[],
      totals: totals as StatementTotals,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async listSettlements(params: {
    beneficiary?: PayoutBeneficiary;
    businessId?: string;
    driverId?: string;
    limit?: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (params.beneficiary) filter.beneficiary = params.beneficiary;
    if (params.businessId) filter.businessId = params.businessId;
    if (params.driverId) filter.driverId = params.driverId;

    return Settlement.find(filter).sort({ createdAt: -1 }).limit(params.limit ?? 50);
  }
}

export const payoutService = new PayoutService();
