import { Types } from 'mongoose';
import {
  Order,
  IOrder,
  IOrderFinance,
  Payment,
  Refund,
  IRefund,
} from '../models';
import { AppError } from '../middlewares';
import {
  RefundKind,
  RefundStatus,
  PaymentStatus,
  PaymentMethod,
  LedgerEventType,
  OrderKind,
} from '../types';
import { ledgerService } from './ledger.service';
import { payoutService } from './payout.service';
import { couponService } from './coupon.service';
import { cashReconciliationService } from './cashReconciliation.service';
import { getPaymentProvider } from './payments';
import { assertMoney } from '../utils';

export interface RefundAllocation {
  fromMerchantPayout: number;
  fromDriverPayout: number;
  fromCommission: number;
  /** Signed: negative means the platform's subsidy is being given back. */
  fromDeliveryMargin: number;
  fromServiceFee: number;
  fromTax: number;
  fromPlatform: number;
}

/**
 * Splits a refund across the parties that were credited at placement.
 *
 * Two distinct policies, because the situations are not alike:
 *
 *  - A **full** refund unwinds the order exactly: every account returns to
 *    where it started, including the driver's payout and the promotional
 *    expense. The identity that made the placement batch balance makes the
 *    reversal balance too.
 *
 *  - A **partial** refund (a missing item, a quality complaint) is charged
 *    to the merchant and the platform, pro rata. The driver is deliberately
 *    excluded: they completed the trip, and clawing back their guaranteed
 *    fee for someone else's mistake is exactly the failure mode this
 *    redesign exists to remove.
 *
 * Integer allocation uses largest-remainder so the parts sum to the refund
 * exactly — no stray peso that would unbalance the ledger.
 */
export function allocateRefund(
  finance: IOrderFinance,
  amount: number,
  kind: RefundKind
): RefundAllocation {
  assertMoney(amount, 'reembolso');

  const isFull = kind !== RefundKind.PARTIAL || amount >= finance.customerTotal;

  if (isFull) {
    return {
      fromMerchantPayout: finance.businessPayout,
      fromDriverPayout: finance.driverPayout,
      fromCommission: finance.merchantCommission,
      fromServiceFee: finance.customerServiceFee,
      fromDeliveryMargin: finance.deliveryMargin,
      fromTax: finance.taxPayable,
      fromPlatform: finance.platformPromotionExpense,
    };
  }

  // Buckets a partial refund may draw from. The driver's payout is not one.
  const buckets: Array<[keyof RefundAllocation, number]> = [
    ['fromMerchantPayout', finance.businessPayout],
    ['fromCommission', finance.merchantCommission],
    ['fromServiceFee', finance.customerServiceFee],
    ['fromDeliveryMargin', Math.max(0, finance.deliveryMargin)],
    ['fromTax', finance.taxPayable],
  ];

  const pool = buckets.reduce((sum, [, value]) => sum + value, 0);

  if (amount > pool) {
    throw new AppError(
      `Un reembolso parcial no puede superar $${pool.toLocaleString('es-CO')} ` +
        'sin afectar el pago garantizado del repartidor. Usa un reembolso total.',
      422
    );
  }

  const allocation: RefundAllocation = {
    fromMerchantPayout: 0,
    fromDriverPayout: 0,
    fromCommission: 0,
    fromServiceFee: 0,
    fromDeliveryMargin: 0,
    fromTax: 0,
    fromPlatform: 0,
  };

  if (pool === 0) return allocation;

  // Floor each share, then hand the remaining pesos to the largest
  // fractional remainders. Guarantees the parts sum to `amount`.
  const shares = buckets.map(([key, value]) => {
    const exact = (value * amount) / pool;
    const floored = Math.floor(exact);
    return { key, floored, remainder: exact - floored, cap: value };
  });

  const assigned = shares.reduce((sum, s) => sum + s.floored, 0);
  const leftover = amount - assigned;

  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < leftover; i += 1) {
    const target = shares[i % shares.length];
    if (target.floored < target.cap) target.floored += 1;
    else i -= 1; // skip a saturated bucket without consuming the peso
  }

  for (const share of shares) {
    allocation[share.key] = share.floored;
  }

  return allocation;
}

export class RefundService {
  /**
   * Issues a refund and reverses every financial consequence of the order.
   *
   * Order of operations matters: the gateway call happens first, because a
   * ledger that says we refunded money we never sent is worse than a failed
   * refund we can retry. `idempotencyKey` makes that retry safe.
   */
  async issue(params: {
    orderId: string;
    amount?: number;
    reason: string;
    kind?: RefundKind;
    requestedBy?: string;
    idempotencyKey?: string;
  }): Promise<IRefund> {
    if (params.idempotencyKey) {
      const existing = await Refund.findOne({ idempotencyKey: params.idempotencyKey });
      if (existing) return existing;
    }

    const order = await Order.findById(params.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    const finance = order.finance;
    if (!finance || !finance.customerTotal) {
      throw new AppError('Este pedido no tiene un snapshot financiero para reversar', 409);
    }

    const alreadyRefunded = await this.refundedTotal(order._id);
    const refundable = finance.customerTotal - alreadyRefunded;
    if (refundable <= 0) {
      throw new AppError('Este pedido ya fue reembolsado en su totalidad', 409);
    }

    const amount = params.amount ?? refundable;
    assertMoney(amount, 'reembolso');
    if (amount > refundable) {
      throw new AppError(
        `El reembolso máximo disponible es $${refundable.toLocaleString('es-CO')}`,
        422
      );
    }

    const kind =
      params.kind ??
      (amount >= refundable && alreadyRefunded === 0 ? RefundKind.FULL : RefundKind.PARTIAL);

    const allocation = allocateRefund(finance, amount, kind);

    const payment = await Payment.findOne({
      orderId: order._id,
      status: PaymentStatus.PAID,
    });
    const captured = Boolean(payment);

    /**
     * La fila PENDING es el cerrojo.
     *
     * Cuánto queda por devolver se calcula sumando los reembolsos ya
     * completados, y entre esa lectura y esta escritura caben otra
     * petición idéntica —un doble clic en el panel sin clave de
     * idempotencia, un reintento de red—. Las dos leían el mismo saldo y
     * las dos pasaban; en un pedido en efectivo, sin pasarela que se niegue
     * a anular dos veces, las dos revertían libros y liquidaciones.
     *
     * El índice único parcial `one_refund_in_flight_per_order` deja pasar
     * solo a una. La otra recibe un 409 explicativo en vez de un error de
     * clave duplicada disfrazado de fallo del servidor.
     */
    let refund: IRefund;
    try {
      refund = await Refund.create({
        orderId: order._id,
        paymentId: payment?._id ?? null,
        kind,
        status: RefundStatus.PENDING,
        amount,
        currency: finance.currency,
        reason: params.reason,
        allocation: {
          fromMerchantPayout: allocation.fromMerchantPayout,
          fromDriverPayout: allocation.fromDriverPayout,
          fromCommission: allocation.fromCommission,
          fromServiceFee: allocation.fromServiceFee,
          fromDeliveryMargin: Math.max(0, allocation.fromDeliveryMargin),
          fromTax: allocation.fromTax,
          fromPlatform: allocation.fromPlatform,
        },
        idempotencyKey: params.idempotencyKey,
        requestedBy: params.requestedBy ?? null,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        // Puede ser la misma clave de idempotencia (el reintento honesto) o
        // el cerrojo por pedido. Se distingue para no contar como carrera
        // lo que solo es un reintento.
        if (params.idempotencyKey) {
          const twin = await Refund.findOne({ idempotencyKey: params.idempotencyKey });
          if (twin) return twin;
        }
        throw new AppError(
          'Ya hay un reembolso en curso para este pedido. Espera a que termine antes de emitir otro.',
          409,
          'REFUND_IN_FLIGHT'
        );
      }
      throw error;
    }

    // Ask the gateway for the money back before touching the books.
    if (captured && payment?.transactionId && kind !== RefundKind.CHARGEBACK) {
      try {
        const provider = getPaymentProvider();
        const intent = await provider.refund(payment.transactionId, amount);
        refund.transactionId = intent.id;
      } catch (error) {
        refund.status = RefundStatus.FAILED;
        refund.reason = `${params.reason} — falló en la pasarela: ${(error as Error).message}`;
        await refund.save();
        throw new AppError(
          'El proveedor de pagos rechazó el reembolso. No se modificó ningún saldo.',
          502
        );
      }
    }

    await this.applyReversal(order, allocation, amount, kind, captured, String(refund._id));

    refund.status = RefundStatus.COMPLETED;
    refund.processedAt = new Date();
    await refund.save();

    return refund;
  }

  /** Records an involuntary reversal forced by the gateway. */
  async recordChargeback(params: {
    orderId: string;
    amount?: number;
    reference: string;
  }): Promise<IRefund> {
    return this.issue({
      orderId: params.orderId,
      amount: params.amount,
      reason: `Contracargo de la pasarela (${params.reference})`,
      kind: RefundKind.CHARGEBACK,
      idempotencyKey: `chargeback:${params.reference}`,
    });
  }

  /**
   * Posts the ledger reversal and unwinds payouts, coupon and cash.
   *
   * Shared by refunds, chargebacks and cancellations so all three can never
   * drift apart in how they treat the books.
   */
  async applyReversal(
    order: IOrder,
    allocation: RefundAllocation,
    customerAmount: number,
    kind: RefundKind,
    captured: boolean,
    reference: string
  ): Promise<void> {
    const finance = order.finance;

    const event =
      kind === RefundKind.CHARGEBACK
        ? LedgerEventType.CHARGEBACK_RECEIVED
        : LedgerEventType.REFUND_ISSUED;

    await ledgerService.recordReversal({
      orderId: order._id,
      event,
      pricingConfigVersion: finance.pricingConfigVersion,
      reference,
      businessId: order.businessId,
      driverId: order.driverId ?? null,
      currency: finance.currency,
      customerAmount,
      againstReceivable: !captured,
      allocation: {
        fromMerchantPayout: allocation.fromMerchantPayout,
        fromDriverPayout: allocation.fromDriverPayout,
        fromCommission: allocation.fromCommission,
        fromServiceFee: allocation.fromServiceFee,
        // A negative margin was booked as a debit at placement, so its
        // reversal is a credit; the ledger method handles the sign.
        fromDeliveryMargin: allocation.fromDeliveryMargin,
        fromTax: allocation.fromTax,
        fromPlatform: allocation.fromPlatform,
        // En un mandado, el grueso de lo que el cliente pagó vive en el
        // pasivo del adelanto. Solo se deshace entero: un reembolso parcial
        // no puede tocarlo porque el domiciliario ya compró con ese dinero
        // y a él se le devuelve igual —`allocateRefund` empuja esos casos a
        // reembolso total, que es donde se pueden resolver de verdad.
        fromErrandAdvance:
          order.kind === OrderKind.ERRAND && customerAmount >= finance.customerTotal
            ? finance.productSubtotal
            : 0,
      },
    });

    await payoutService.reverse(order._id, {
      business: allocation.fromMerchantPayout,
      driver: allocation.fromDriverPayout,
    });

    const isFull = customerAmount >= finance.customerTotal;

    if (isFull) {
      // The promotion was never consumed, so give the use and budget back.
      if (order.couponId) await couponService.release(order._id.toString());

      if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
        await cashReconciliationService.void(order._id);
      }
    }

    if (isFull) {
      // Escritura acotada al campo, no `order.save()`. El documento llega
      // aquí leído por el llamador —a veces muchos `await` antes: la
      // llamada a la pasarela, el asiento contable, la reversión de
      // liquidaciones— y guardarlo entero reescribía el pedido con esa
      // copia vieja, borrando cualquier cambio hecho entretanto: un
      // domiciliario recién asignado, un cambio de estado, una captura.
      await Order.updateOne(
        { _id: order._id },
        { $set: { paymentStatus: PaymentStatus.REFUNDED } }
      );
      order.paymentStatus = PaymentStatus.REFUNDED;
    }
  }

  async refundedTotal(orderId: string | Types.ObjectId): Promise<number> {
    const [row] = await Refund.aggregate([
      { $match: { orderId: new Types.ObjectId(String(orderId)), status: RefundStatus.COMPLETED } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return row?.total ?? 0;
  }

  async listForOrder(orderId: string) {
    return Refund.find({ orderId }).sort({ createdAt: -1 });
  }
}

export const refundService = new RefundService();
