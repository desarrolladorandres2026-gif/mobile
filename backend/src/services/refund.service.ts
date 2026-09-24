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
/** Lo ya devuelto por cada cuenta en reembolsos previos completados del mismo pedido. */
export type PriorAllocation = RefundAllocation;

const ZERO_ALLOCATION: PriorAllocation = {
  fromMerchantPayout: 0,
  fromDriverPayout: 0,
  fromCommission: 0,
  fromDeliveryMargin: 0,
  fromServiceFee: 0,
  fromTax: 0,
  fromPlatform: 0,
};

export function allocateRefund(
  finance: IOrderFinance,
  amount: number,
  kind: RefundKind,
  prior: PriorAllocation = ZERO_ALLOCATION
): RefundAllocation {
  assertMoney(amount, 'reembolso');

  // Kind ya no fuerza "total" por sí solo: un CHARGEBACK parcial (la
  // pasarela solo revirtió una parte) tiene que repartirse igual que un
  // reembolso parcial, o cada contracargo parcial explota en
  // `LedgerImbalanceError` al intentar devolver cuentas enteras por menos
  // dinero del que en verdad se revirtió.
  const isFull = kind === RefundKind.FULL || amount >= finance.customerTotal;

  // Lo que queda vivo en cada cuenta después de reembolsos previos. Sin
  // esto, un segundo reembolso parcial vuelve a usar los montos originales
  // del pedido como techo y puede devolver más de lo que esa cuenta
  // realmente tiene.
  const remaining = {
    merchantPayout: Math.max(0, finance.businessPayout - prior.fromMerchantPayout),
    driverPayout: Math.max(0, finance.driverPayout - prior.fromDriverPayout),
    commission: Math.max(0, finance.merchantCommission - prior.fromCommission),
    serviceFee: Math.max(0, finance.customerServiceFee - prior.fromServiceFee),
    deliveryMargin: Math.max(0, finance.deliveryMargin - prior.fromDeliveryMargin),
    tax: Math.max(0, finance.taxPayable - prior.fromTax),
    platform: Math.max(0, finance.platformPromotionExpense - prior.fromPlatform),
  };

  // Un margen negativo (ZIPP subsidió el envío) es legítimo y hay que
  // conservar su signo en el reembolso total; solo se acota a 0 cuando se
  // usa como techo de un reembolso parcial, igual que hacía el código
  // original.
  const deliveryMarginSigned = finance.deliveryMargin - prior.fromDeliveryMargin;
  const deliveryMarginCap = Math.max(0, deliveryMarginSigned);

  if (isFull) {
    return {
      fromMerchantPayout: remaining.merchantPayout,
      fromDriverPayout: remaining.driverPayout,
      fromCommission: remaining.commission,
      fromServiceFee: remaining.serviceFee,
      fromDeliveryMargin: deliveryMarginSigned,
      fromTax: remaining.tax,
      fromPlatform: remaining.platform,
    };
  }

  // Buckets a partial refund may draw from. The driver's payout is not one.
  const buckets: Array<[keyof RefundAllocation, number]> = [
    ['fromMerchantPayout', remaining.merchantPayout],
    ['fromCommission', remaining.commission],
    ['fromServiceFee', remaining.serviceFee],
    ['fromDeliveryMargin', deliveryMarginCap],
    ['fromTax', remaining.tax],
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
      if (existing) {
        // Un reintento con la misma clave que encuentra el reembolso todavía
        // PENDING no es un éxito: el primer intento sigue en curso (o se
        // cayó a mitad de camino). Devolverlo como si hubiera terminado le
        // mentía al llamador; ahora se distingue el estado terminal
        // (COMPLETED/FAILED, se devuelve tal cual) del no terminal (409).
        if (existing.status === RefundStatus.PENDING) {
          throw new AppError(
            'Ya hay un reembolso en curso con esta referencia. Espera a que termine antes de reintentar.',
            409,
            'REFUND_IN_FLIGHT'
          );
        }
        return existing;
      }
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

    const prior = await this.allocatedSoFar(order._id);
    const allocation = allocateRefund(finance, amount, kind, prior);

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

    await payoutService.reverse(
      order._id,
      {
        business: allocation.fromMerchantPayout,
        driver: allocation.fromDriverPayout,
      },
      reference
    );

    // Acumulado, no solo este reembolso: un parcial que agota justo lo que
    // quedaba ("el resto") tiene que cerrar el pedido igual que uno total.
    // `refundedTotal` solo cuenta reembolsos ya COMPLETED, y este todavía no
    // lo está en el momento en que se llama aquí — así que sumarle
    // `customerAmount` da exactamente el acumulado tras este reembolso.
    const priorRefunded = await this.refundedTotal(order._id);
    const isFull = priorRefunded + customerAmount >= finance.customerTotal;

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

  /** Suma, cuenta por cuenta, lo que ya salió de cada bolsillo en reembolsos completados. */
  async allocatedSoFar(orderId: string | Types.ObjectId): Promise<PriorAllocation> {
    const [row] = await Refund.aggregate([
      { $match: { orderId: new Types.ObjectId(String(orderId)), status: RefundStatus.COMPLETED } },
      {
        $group: {
          _id: null,
          fromMerchantPayout: { $sum: '$allocation.fromMerchantPayout' },
          fromDriverPayout: { $sum: '$allocation.fromDriverPayout' },
          fromCommission: { $sum: '$allocation.fromCommission' },
          fromServiceFee: { $sum: '$allocation.fromServiceFee' },
          fromDeliveryMargin: { $sum: '$allocation.fromDeliveryMargin' },
          fromTax: { $sum: '$allocation.fromTax' },
          fromPlatform: { $sum: '$allocation.fromPlatform' },
        },
      },
    ]);
    if (!row) return { ...ZERO_ALLOCATION };
    return {
      fromMerchantPayout: row.fromMerchantPayout ?? 0,
      fromDriverPayout: row.fromDriverPayout ?? 0,
      fromCommission: row.fromCommission ?? 0,
      fromServiceFee: row.fromServiceFee ?? 0,
      fromDeliveryMargin: row.fromDeliveryMargin ?? 0,
      fromTax: row.fromTax ?? 0,
      fromPlatform: row.fromPlatform ?? 0,
    };
  }

  /**
   * Reembolso ya ejecutado por fuera de ZIPP — típicamente desde el
   * dashboard de Wompi, porque su API no admite reembolsos parciales
   * (`wompi.provider.ts`). No llama a la pasarela: solo reparte
   * contablemente exactamente igual que `issue()` y deja la referencia
   * externa como evidencia de auditoría. Restringido a `requireFinanceAdmin`
   * en la ruta porque, a diferencia de `issue()`, no hay confirmación del
   * proveedor que lo respalde — es la palabra del administrador.
   */
  async issueExternal(params: {
    orderId: string;
    amount: number;
    reason: string;
    externalReference: string;
    requestedBy: string;
  }): Promise<IRefund> {
    if (!params.externalReference?.trim()) {
      throw new AppError('La referencia externa es obligatoria', 422);
    }

    // Normalizada (espacios fuera, mayúsculas): "T-123" y "t-123 " son la
    // misma consignación para efectos de no cobrarla/registrarla dos veces.
    const normalizedReference = params.externalReference.trim().toUpperCase();
    if (!normalizedReference) {
      throw new AppError('La referencia externa es obligatoria', 422);
    }

    // Clave de idempotencia por REFERENCIA, no por pedido: la reconciliación
    // real es "esta consignación de Wompi ya se usó", sin importar con qué
    // pedido se intentó asociar. Antes la clave incluía `orderId`, así que la
    // misma referencia externa podía respaldar dos pedidos distintos sin que
    // nada lo notara.
    const idempotencyKey = `external:${normalizedReference}`;
    const existing = await Refund.findOne({ idempotencyKey });
    if (existing) {
      if (existing.status === RefundStatus.PENDING) {
        throw new AppError(
          'Ya hay un reembolso externo en curso con esta referencia.',
          409,
          'REFUND_IN_FLIGHT'
        );
      }
      // Reintento honesto: mismo pedido y mismo monto. Cualquier otra
      // combinación es la misma referencia intentando respaldar un pedido o
      // un monto distinto — un 409 explícito en vez de devolver el reembolso
      // equivocado.
      if (String(existing.orderId) === String(params.orderId) && existing.amount === params.amount) {
        return existing;
      }
      throw new AppError(
        'Esta referencia externa ya respalda otro pedido o un monto distinto.',
        409,
        'REFUND_REFERENCE_REUSED'
      );
    }

    const order = await Order.findById(params.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    const finance = order.finance;
    if (!finance || !finance.customerTotal) {
      throw new AppError('Este pedido no tiene un snapshot financiero para reversar', 409);
    }

    const payment = await Payment.findOne({ orderId: order._id, status: PaymentStatus.PAID });
    if (!payment) {
      // Un reembolso externo solo tiene sentido cuando de verdad se cobró
      // por pasarela: es la reconciliación de un reembolso que Wompi ya
      // ejecutó. Un pedido en efectivo o sin captura no tiene nada que
      // reconciliar por esta vía.
      throw new AppError(
        'Este pedido no tiene un pago en línea cobrado para reembolsar externamente',
        409
      );
    }
    const captured = true;

    const alreadyRefunded = await this.refundedTotal(order._id);
    const refundable = finance.customerTotal - alreadyRefunded;
    if (refundable <= 0) {
      throw new AppError('Este pedido ya fue reembolsado en su totalidad', 409);
    }

    assertMoney(params.amount, 'reembolso');
    if (params.amount > refundable) {
      throw new AppError(
        `El reembolso máximo disponible es $${refundable.toLocaleString('es-CO')}`,
        422
      );
    }

    const kind = RefundKind.EXTERNAL;
    const prior = await this.allocatedSoFar(order._id);
    const allocation = allocateRefund(finance, params.amount, kind, prior);

    let refund: IRefund;
    try {
      refund = await Refund.create({
        orderId: order._id,
        paymentId: payment._id,
        kind,
        status: RefundStatus.PENDING,
        amount: params.amount,
        currency: finance.currency,
        reason: `${params.reason} (externo, ref. ${normalizedReference})`,
        allocation: {
          fromMerchantPayout: allocation.fromMerchantPayout,
          fromDriverPayout: allocation.fromDriverPayout,
          fromCommission: allocation.fromCommission,
          fromServiceFee: allocation.fromServiceFee,
          fromDeliveryMargin: Math.max(0, allocation.fromDeliveryMargin),
          fromTax: allocation.fromTax,
          fromPlatform: allocation.fromPlatform,
        },
        idempotencyKey,
        requestedBy: params.requestedBy,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const twin = await Refund.findOne({ idempotencyKey });
        if (twin) return twin;
        throw new AppError('Ya hay un reembolso en curso para este pedido.', 409, 'REFUND_IN_FLIGHT');
      }
      throw error;
    }

    await this.applyReversal(order, allocation, params.amount, kind, captured, String(refund._id));

    refund.status = RefundStatus.COMPLETED;
    refund.transactionId = `external:${normalizedReference}`;
    refund.processedAt = new Date();
    await refund.save();

    return refund;
  }

  async listForOrder(orderId: string) {
    return Refund.find({ orderId }).sort({ createdAt: -1 });
  }
}

export const refundService = new RefundService();
