import { Types } from 'mongoose';
import {
  Order,
  IOrder,
  IOrderFinance,
  IPayment,
  Payment,
  Refund,
  IRefund,
  LedgerEntry,
  Payout,
} from '../models';
import { LedgerAccount, LedgerDirection } from '../types';
import { AppError } from '../middlewares';
import {
  RefundKind,
  RefundStatus,
  PaymentStatus,
  PaymentMethod,
  LedgerEventType,
  OrderKind,
  OrderStatus,
  ItemShortageStatus,
  RefundCause,
  PayoutBeneficiary,
  PayoutStatus,
  CancelledBy,
} from '../types';
import { ledgerService } from './ledger.service';
import { payoutService } from './payout.service';
import { couponService } from './coupon.service';
import { cashReconciliationService } from './cashReconciliation.service';
import { getPaymentProvider, paymentService } from './payments';
import { assertMoney } from '../utils';
import { gatewayFeeReturned, gatewayOperationFee, gatewayFeeSnapshot } from '../utils/gatewayFee';
import { pricingConfigService } from './pricingConfig.service';
import { notifyAlertsChanged } from './alerts.service';

export interface RefundAllocation {
  fromMerchantPayout: number;
  fromDriverPayout: number;
  fromCommission: number;
  /** Signed: negative means the platform's subsidy is being given back. */
  fromDeliveryMargin: number;
  fromServiceFee: number;
  fromTax: number;
  fromPlatform: number;
  /**
   * M-013: pago del domiciliario que el reembolso NO le quita. Sigue siendo suyo
   * y ZIPP lo asume. `fromDriverPayout + driverRetained` = lo que se llevaba de
   * su pago. Opcional: los reembolsos anteriores no lo tienen (= 0).
   */
  driverRetained?: number;
}

/** Cuánto del pago del domiciliario se conserva: `'all'` = todo lo que le quede. */
export type DriverRetention = number | 'all';

/**
 * Splits a refund across the parties that were credited at placement.
 *
 * Two distinct policies, because the situations are not alike:
 *
 *  - A **full** refund unwinds the order exactly: every account returns to
 *    where it started, including the promotional expense. The identity that
 *    made the placement batch balance makes the reversal balance too. The
 *    driver's payout is the exception (M-013): refunding the customer is not
 *    the same as un-doing the work the courier already did, so when the
 *    caller says the courier keeps their pay (`driverRetain`), that slice is
 *    not reversed — `driverRetained` records it and ZIPP absorbs it.
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
  prior: PriorAllocation = ZERO_ALLOCATION,
  driverRetain: DriverRetention = 0,
  /**
   * Lo que todavía se podía devolver ANTES de este reembolso (`customerTotal −
   * Σ reembolsos completados`). Cuando se conoce, manda sobre el nombre de la
   * operación: un reembolso que agota ese saldo CIERRA el pedido y se reparte
   * como total —sobre lo que queda vivo en cada cuenta—, se haya llamado
   * «parcial» o «total», y uno que no lo agota es parcial aunque se le haya
   * llamado «total». Antes, el «resto» tras un parcial se trataba como otro
   * parcial: nunca alcanzaba `customerTotal`, no podía tocar el pago del
   * domiciliario ni el gasto promocional y fallaba con «usa un reembolso total».
   */
  refundable?: number
): RefundAllocation {
  assertMoney(amount, 'reembolso');

  // Kind ya no fuerza "total" por sí solo: un CHARGEBACK parcial (la
  // pasarela solo revirtió una parte) tiene que repartirse igual que un
  // reembolso parcial, o cada contracargo parcial explota en
  // `LedgerImbalanceError` al intentar devolver cuentas enteras por menos
  // dinero del que en verdad se revirtió.
  const isFull = refundable !== undefined
    ? amount >= refundable
    : kind === RefundKind.FULL || amount >= finance.customerTotal;

  // Lo que queda vivo en cada cuenta después de reembolsos previos. Sin
  // esto, un segundo reembolso parcial vuelve a usar los montos originales
  // del pedido como techo y puede devolver más de lo que esa cuenta
  // realmente tiene.
  const remaining = {
    merchantPayout: Math.max(0, finance.businessPayout - prior.fromMerchantPayout),
    driverPayout: Math.max(0, finance.driverPayout - prior.fromDriverPayout - (prior.driverRetained ?? 0)),
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
    const retained = driverRetain === 'all'
      ? remaining.driverPayout
      : Math.min(remaining.driverPayout, Math.max(0, Math.trunc(driverRetain)));
    return {
      fromMerchantPayout: remaining.merchantPayout,
      fromDriverPayout: remaining.driverPayout - retained,
      driverRetained: retained,
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
    driverRetained: 0,
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

/**
 * Cifras de un pedido DESPUÉS de los reembolsos ya completados.
 *
 * `order.finance` es un snapshot inmutable: es el techo contra el que se
 * reparte cada reembolso, así que nunca se reescribe. Lo que de verdad queda
 * vivo en cada cuenta es `finance − Σ allocation` de los `Refund` completados,
 * y eso es lo que tienen que usar todos los caminos del efectivo (cobro en la
 * puerta, asiento de entrega, efectivo por rendir): leer `finance` en bruto
 * después de un reembolso parcial cobra, asienta y concilia de más.
 */
export interface NetFinance {
  customerTotal: number;
  businessPayout: number;
  driverPayout: number;
  merchantCommission: number;
  customerServiceFee: number;
  /** Con signo: negativo = ZIPP subsidió el envío. */
  deliveryMargin: number;
  taxPayable: number;
  platformPromotionExpense: number;
  /** `customerTotal − businessPayout − driverPayout`: lo que queda en CASH_IN_TRANSIT. */
  cashToRemit: number;
  /** Ingreso bruto de ZIPP: comisión + fee de servicio + margen. */
  platformGrossRevenue: number;
}

/** Pura: sin acceso a base de datos, para poder probarla con cifras sueltas. */
export function netFinance(
  finance: IOrderFinance,
  prior: PriorAllocation,
  refundedTotal: number
): NetFinance {
  const nonNeg = (n: number) => Math.max(0, n);
  const customerTotal = nonNeg(finance.customerTotal - refundedTotal);
  const businessPayout = nonNeg(finance.businessPayout - prior.fromMerchantPayout);
  // Lo que el domiciliario conserva ya no es parte viva del pedido: se le paga
  // aparte (lo asume ZIPP), así que tampoco entra en el efectivo por rendir.
  const driverPayout = nonNeg(finance.driverPayout - prior.fromDriverPayout - (prior.driverRetained ?? 0));
  const merchantCommission = nonNeg(finance.merchantCommission - prior.fromCommission);
  const customerServiceFee = nonNeg(finance.customerServiceFee - prior.fromServiceFee);
  const deliveryMargin = finance.deliveryMargin - prior.fromDeliveryMargin;
  return {
    customerTotal,
    businessPayout,
    driverPayout,
    merchantCommission,
    customerServiceFee,
    deliveryMargin,
    taxPayable: nonNeg(finance.taxPayable - prior.fromTax),
    platformPromotionExpense: nonNeg(finance.platformPromotionExpense - prior.fromPlatform),
    cashToRemit: customerTotal - businessPayout - driverPayout,
    platformGrossRevenue: merchantCommission + customerServiceFee + deliveryMargin,
  };
}

/**
 * Cómo trata un reembolso el pago del domiciliario (M-013).
 *
 * Separa dos preguntas que antes se contestaban con la misma cuenta:
 *  1. ¿Cuánto se le devuelve al cliente? — el reembolso.
 *  2. ¿Cuánto cobra el domiciliario? — su remuneración por el trabajo hecho.
 *
 *  · **Pedido entregado** y reembolso total: el domiciliario completó la entrega.
 *    Conserva TODO su pago —tarifa y propina—, sea cual sea la causa, y lo asume
 *    ZIPP. Si la causa es suya (`DRIVER`) tampoco se le retira solo: el pago se
 *    conserva y el caso queda en revisión con un humano.
 *  · **Reembolso parcial**: nunca toca al domiciliario (ya era así).
 *  · **Pedido no entregado** (reembolso a mitad de camino): sin cambios; las
 *    cancelaciones tienen su propia regla (`driverCancellationPay`).
 *
 * El comercio no se carga con el pago del domiciliario: sería una regla comercial
 * nueva que nadie ha decidido. Queda registrado quién lo asume (`costBearer`).
 */
export function driverRetentionFor(order: Pick<IOrder, 'status'>): DriverRetention {
  return order.status === OrderStatus.DELIVERED ? 'all' : 0;
}

/** Lo que queda anotado en el `Refund` sobre el pago del domiciliario. */
export function driverPayDescriptor(
  allocation: RefundAllocation,
  cause: RefundCause,
  hadDriverPay: boolean
): NonNullable<IRefund['driverPay']> {
  const retained = allocation.driverRetained ?? 0;
  if (!hadDriverPay) return { policy: 'none', retained: 0, costBearer: 'none' };
  if (retained <= 0) {
    return { policy: allocation.fromDriverPayout > 0 ? 'reversed' : 'none', retained: 0, costBearer: 'none' };
  }
  return {
    policy: allocation.fromDriverPayout > 0 ? 'partial' : 'kept',
    retained,
    costBearer: 'platform',
    // Posible responsabilidad del domiciliario: no se le retira automáticamente
    // lo ya reconocido; un humano decide y queda constancia.
    review: cause === RefundCause.DRIVER ? { status: 'pending' } : null,
  };
}

/**
 * Cuánto de su tarifa conserva el domiciliario si el pedido se cancela ANTES de
 * entregarlo (M-013). Puro; la política vive en la configuración de precios:
 *
 *  · `driverCancelPayAssignedBps`: con domiciliario asignado y el pedido todavía
 *    sin recoger.
 *  · `driverCancelPayPickedUpBps`: ya recogido o en camino (hizo el viaje al local).
 *
 * Porcentaje sobre la tarifa de domicilio del domiciliario (la propina no cuenta:
 * se da al entregar). No aplica si canceló el propio domiciliario, ni sin
 * domiciliario. Ambos nacen en 0 —la regla actual (nada)— hasta que el negocio
 * decida cifras.
 */
export function driverCancellationPay(
  order: Pick<IOrder, 'driverId' | 'finance' | 'cancelledBy'>,
  previousStatus: OrderStatus,
  cfg: { driverCancelPayAssignedBps?: number; driverCancelPayPickedUpBps?: number }
): { amount: number; tier: 'assigned' | 'picked_up'; bps: number } | null {
  if (!order.driverId) return null;
  if (order.cancelledBy === CancelledBy.DRIVER) return null;
  const pickedUp = previousStatus === OrderStatus.PICKED_UP || previousStatus === OrderStatus.ON_WAY;
  const tier = pickedUp ? 'picked_up' : 'assigned';
  const bps = (pickedUp ? cfg.driverCancelPayPickedUpBps : cfg.driverCancelPayAssignedBps) ?? 0;
  if (bps <= 0) return null;
  const amount = Math.min(
    order.finance?.driverDeliveryPayout ?? 0,
    Math.floor(((order.finance?.driverDeliveryPayout ?? 0) * bps) / 10_000)
  );
  return amount > 0 ? { amount, tier, bps } : null;
}

export class RefundService {
  /** Cifras netas del pedido: `finance` menos lo ya reembolsado. Ver `NetFinance`. */
  async netOf(order: IOrder): Promise<NetFinance> {
    const [prior, refunded] = await Promise.all([
      this.allocatedSoFar(order._id),
      this.refundedTotal(order._id),
    ]);
    return netFinance(order.finance, prior, refunded);
  }

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
    /** De quién fue el problema (M-013). Sin indicar: no atribuible al domiciliario. */
    cause?: RefundCause;
    /** Solo cancelaciones: parte del pago del domiciliario que se conserva (ver `driverCancellationPay`). */
    driverRetain?: number;
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

    // M-001: la cancelación sin cobro ya deshizo el libro de este pedido.
    if (await this.booksUnwoundByCancellation(order)) {
      return this.returnLateCapture(order, { ...params, external: null });
    }

    const plan = await this.planRefund(order, params);
    const { amount, kind } = plan;
    let { allocation } = plan;
    const cause = params.cause ?? RefundCause.UNSPECIFIED;

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
          driverRetained: allocation.driverRetained ?? 0,
        },
        cause,
        driverPay: driverPayDescriptor(allocation, cause, finance.driverPayout > 0),
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

    // Bajo el cerrojo se vuelve a leer el saldo: entre el primer cálculo y la
    // fila PENDING cabía otro reembolso entero (el cerrojo solo estorba mientras
    // el otro sigue PENDING, no cuando ya terminó). Sin esto, dos solicitudes
    // simultáneas podían devolver el mismo dinero dos veces.
    try {
      const replanned = await this.planRefund(await Order.findById(order._id) ?? order, params);
      if (replanned.amount !== amount || replanned.kind !== kind || JSON.stringify(replanned.allocation) !== JSON.stringify(allocation)) {
        refund.kind = replanned.kind;
        refund.amount = replanned.amount;
        refund.allocation = {
          ...replanned.allocation,
          fromDeliveryMargin: Math.max(0, replanned.allocation.fromDeliveryMargin),
          driverRetained: replanned.allocation.driverRetained ?? 0,
        } as IRefund['allocation'];
        refund.driverPay = driverPayDescriptor(replanned.allocation, cause, finance.driverPayout > 0);
        await refund.save();
        allocation = replanned.allocation;
      }
    } catch (error) {
      await Refund.deleteOne({ _id: refund._id, status: RefundStatus.PENDING });
      throw error;
    }

    // Ask the gateway for the money back before touching the books.
    if (captured && payment?.transactionId && refund.kind !== RefundKind.CHARGEBACK) {
      try {
        const provider = getPaymentProvider();
        const intent = await provider.refund(payment.transactionId, refund.amount);
        refund.transactionId = intent.id;
      } catch (error) {
        refund.status = RefundStatus.FAILED;
        refund.reason = `${params.reason} — falló en la pasarela: ${(error as Error).message}`;
        await refund.save();
        void notifyAlertsChanged('refund_failed');
        throw new AppError(
          'El proveedor de pagos rechazó el reembolso. No se modificó ningún saldo.',
          502
        );
      }
    }

    await this.applyReversal(order, allocation, refund.amount, refund.kind, captured, String(refund._id));

    refund.status = RefundStatus.COMPLETED;
    refund.processedAt = new Date();
    await refund.save();

    return refund;
  }

  /**
   * Qué se devuelve y de dónde sale, a partir de los IMPORTES: lo ya
   * reembolsado (filas `COMPLETED`), lo que queda vivo en cada cuenta y la
   * política del pago del domiciliario. Nunca del nombre de la operación
   * anterior ni del que trae la petición (ver `allocateRefund`).
   *
   *  · El importe que se devuelve al cliente es `amount` (≤ `refundable`).
   *  · Si agota `refundable`, cierra el pedido: reparto total sobre el saldo
   *    vivo, y el pago del domiciliario sigue `driverRetentionFor` (entregado:
   *    lo conserva y lo asume ZIPP; no entregado: se revierte lo que queda).
   *  · Si no lo agota, es parcial y nunca toca al domiciliario.
   *  · Contracargo y reembolso externo conservan su etiqueta (cambian el asiento
   *    y la pasarela), pero se reparten con la misma regla de cierre.
   */
  private async planRefund(
    order: IOrder,
    params: { amount?: number; kind?: RefundKind; driverRetain?: number }
  ): Promise<{ amount: number; kind: RefundKind; refundable: number; allocation: RefundAllocation }> {
    const finance = order.finance;
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
      params.kind === RefundKind.CHARGEBACK || params.kind === RefundKind.EXTERNAL
        ? params.kind
        : amount >= refundable ? RefundKind.FULL : RefundKind.PARTIAL;

    const prior = await this.allocatedSoFar(order._id);
    const driverRetain: DriverRetention = params.driverRetain ?? driverRetentionFor(order);
    const allocation = allocateRefund(finance, amount, kind, prior, driverRetain, refundable);
    return { amount, kind, refundable, allocation };
  }

  /**
   * Ejecuta el descuento de un producto que falta, ya aceptado por el cliente.
   *
   * No lo llama el comercio ni el administrador: lo dispara el servidor
   * cuando el CLIENTE acepta (`orderService.respondShortage`) o el barrido
   * reintenta una aceptación a medio ejecutar. Por eso el permiso de
   * reembolsos (`refunds:create`) no se abre a nadie nuevo.
   *
   * Ni el monto ni el reparto vienen del llamador: se leen de
   * `order.itemShortage`, que `repriceShortage` fijó al avisar y que solo
   * cambia con una escritura condicionada. Es un `Refund` PARTIAL como
   * cualquier otro —reutiliza el cerrojo PENDING y `applyReversal`—, pero con
   * ese reparto en vez de `allocateRefund`, que cobraría margen de domicilio.
   *
   * Solo efectivo sin cobrar: `captured = false`, así que se revierte contra la
   * cuenta por cobrar y `applyReversal` re-fija el cobro a la puerta al neto.
   * Idempotente por `shortage:<pedido>:<consulta>`.
   */
  async issueItemShortage(params: {
    orderId: string;
    shortageId: string;
    acceptedBy?: string;
  }): Promise<IRefund> {
    const idempotencyKey = `shortage:${params.orderId}:${params.shortageId}`;

    const existing = await Refund.findOne({ idempotencyKey });
    if (existing) {
      if (existing.status === RefundStatus.PENDING) {
        throw new AppError(
          'El descuento por el producto que falta sigue en curso. Espera a que termine antes de reintentar.',
          409,
          'REFUND_IN_FLIGHT'
        );
      }
      return existing;
    }

    const order = await Order.findById(params.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    const shortage = order.itemShortage;
    if (
      !shortage ||
      String(shortage._id) !== params.shortageId ||
      shortage.status !== ItemShortageStatus.ACCEPTED
    ) {
      throw new AppError('Este pedido no tiene un descuento por producto faltante aceptado', 409, 'SHORTAGE_NOT_ACCEPTED');
    }
    // Un pedido cancelado entretanto ya se reversó entero: aplicar ahora el
    // parcial devolvería dos veces la misma tajada.
    if (![OrderStatus.ACCEPTED, OrderStatus.PREPARING].includes(order.status)) {
      throw new AppError('El pedido ya no admite el descuento por el producto que falta', 409, 'SHORTAGE_ORDER_MOVED');
    }
    if (order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
      throw new AppError('El descuento por producto faltante es solo para pedidos en efectivo', 409);
    }
    if (await Payment.exists({ orderId: order._id, status: PaymentStatus.PAID })) {
      throw new AppError('El pedido ya tiene un cobro registrado', 409);
    }

    const finance = order.finance;
    const amount = shortage.refundAmount;
    assertMoney(amount, 'reembolso');
    if (finance.customerTotal - amount !== shortage.after.customerTotal) {
      throw new AppError('El descuento guardado ya no corresponde al pedido', 409, 'SHORTAGE_STALE');
    }

    // Lo guardado se calculó sobre un pedido íntegro: con un reembolso previo
    // el reparto ya no es válido (`repriceShortage` lo vuelve a rechazar al
    // avisar; aquí cubre el que entró entre el aviso y la aceptación).
    const prior = await this.allocatedSoFar(order._id);
    if (Object.values(prior).some((v) => v !== 0)) {
      throw new AppError(
        'El pedido recibió un reembolso después del aviso: el descuento por faltante ya no aplica.',
        409,
        'ITEM_SHORTAGE_PRIOR_REFUND'
      );
    }

    const allocation: RefundAllocation = {
      fromMerchantPayout: shortage.allocation.fromMerchantPayout,
      fromDriverPayout: shortage.allocation.fromDriverPayout,
      fromCommission: shortage.allocation.fromCommission,
      fromDeliveryMargin: shortage.allocation.fromDeliveryMargin,
      fromServiceFee: shortage.allocation.fromServiceFee,
      fromTax: shortage.allocation.fromTax,
      fromPlatform: shortage.allocation.fromPlatform,
    };

    let refund: IRefund;
    try {
      refund = await Refund.create({
        orderId: order._id,
        paymentId: null,
        kind: RefundKind.PARTIAL,
        status: RefundStatus.PENDING,
        amount,
        currency: finance.currency,
        reason: 'Producto faltante aceptado por el cliente',
        allocation,
        idempotencyKey,
        requestedBy: params.acceptedBy ?? null,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const twin = await Refund.findOne({ idempotencyKey });
        if (twin) {
          if (twin.status === RefundStatus.PENDING) {
            throw new AppError(
              'El descuento por el producto que falta sigue en curso.',
              409,
              'REFUND_IN_FLIGHT'
            );
          }
          return twin;
        }
        throw new AppError(
          'Ya hay un reembolso en curso para este pedido. Espera a que termine antes de emitir otro.',
          409,
          'REFUND_IN_FLIGHT'
        );
      }
      throw error;
    }

    await this.applyReversal(order, allocation, amount, RefundKind.PARTIAL, false, String(refund._id));

    refund.status = RefundStatus.COMPLETED;
    refund.processedAt = new Date();
    await refund.save();

    return refund;
  }

  /** ¿Hay un reembolso a medias en este pedido? (el cerrojo PENDING). */
  async hasInFlight(orderId: string | Types.ObjectId): Promise<boolean> {
    return Boolean(await Refund.exists({ orderId, status: RefundStatus.PENDING }));
  }

  /** Records an involuntary reversal forced by the gateway. */
  async recordChargeback(params: {
    orderId: string;
    amount?: number;
    reference: string;
    cause?: RefundCause;
  }): Promise<IRefund> {
    return this.issue({
      orderId: params.orderId,
      amount: params.amount,
      reason: `Contracargo de la pasarela (${params.reference})`,
      kind: RefundKind.CHARGEBACK,
      idempotencyKey: `chargeback:${params.reference}`,
      cause: params.cause ?? RefundCause.GATEWAY,
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
        driverRetained: allocation.driverRetained ?? 0,
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

    // M-005: el costo de la pasarela también se mueve cuando se devuelve plata.
    if (captured) {
      await this.recordGatewayFeeAdjustment(order, customerAmount, kind === RefundKind.CHARGEBACK ? 'chargeback' : 'refund', reference);
    }

    // Lo que el domiciliario conserva es dinero que ZIPP le debe y va a pagar:
    // si el pedido lo había retenido (cancelación con cobro, `hold`), vuelve a
    // poder liquidarse. Solo su fila normal; nunca un arrastre.
    if ((allocation.driverRetained ?? 0) > 0) {
      await Payout.updateOne(
        { orderId: order._id, beneficiary: PayoutBeneficiary.DRIVER, status: PayoutStatus.ACCRUED, isClawback: { $ne: true } },
        { $set: { status: PayoutStatus.PAYABLE, becamePayableAt: new Date() } }
      );
    }

    // Acumulado, no solo este reembolso: un parcial que agota justo lo que
    // quedaba ("el resto") tiene que cerrar el pedido igual que uno total.
    // `refundedTotal` solo cuenta reembolsos ya COMPLETED, y este todavía no
    // lo está en el momento en que se llama aquí — así que sumarle
    // `customerAmount` da exactamente el acumulado tras este reembolso.
    const priorRefunded = await this.refundedTotal(order._id);
    const isFull = priorRefunded + customerAmount >= finance.customerTotal;

    // En efectivo sin cobrar, la puerta tiene que cobrar el NETO: el cobro
    // se abrió al crear el pedido con el total completo. Condicionado a
    // PENDING_CASH dentro del filtro (un cobro cerrado o anulado no se toca),
    // así que en la cancelación —que anula el cobro antes— no hace nada.
    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY && !captured) {
      await paymentService.repriceCashPayment(
        order._id.toString(),
        Math.max(0, finance.customerTotal - priorRefunded - customerAmount)
      );
    }

    if (isFull) {
      // The promotion was never consumed, so give the use and budget back.
      // Incondicional: `release()` ya resuelve todas las filas de este
      // pedido —cupón de código, promociones automáticas, o ninguna—, así
      // que no hace falta que `order.couponId` esté puesto para intentarlo.
      await couponService.release(order._id.toString());

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

  /**
   * Ajusta el costo de la pasarela por un reembolso, una anulación o un contracargo
   * (M-005). Dos movimientos, ambos con la tarifa vigente al momento de la
   * operación y ambos sobre la comisión que el libro YA asentó al cobrar —no una
   * recalculada con tarifas nuevas—:
   *
   *  · lo que Wompi devuelve de su comisión (`gatewayFeeRefundBps`), proporcional a
   *    lo reembolsado y acotado a lo que no se haya devuelto antes;
   *  · el costo de la operación (`gatewayRefundFixed` / `gatewayChargebackFixed`,
   *    con IVA).
   *
   * Solo pedidos pagados por la pasarela (los que tienen su comisión asentada o
   * un cobro en línea): un pedido en efectivo no pasa por Wompi. Con todo sin
   * configurar no escribe nada: nada se inventa. Idempotente por referencia.
   */
  async recordGatewayFeeAdjustment(
    order: IOrder,
    refundedAmount: number,
    operation: 'refund' | 'chargeback',
    reference: string
  ): Promise<void> {
    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) return;
    const cfg = await pricingConfigService.getCurrent();

    const rows: Array<{ _id: { event: string; direction: LedgerDirection }; amount: number }> = await LedgerEntry.aggregate([
      { $match: { orderId: order._id, account: LedgerAccount.PAYMENT_PROCESSING_EXPENSE } },
      { $group: { _id: { event: '$event', direction: '$direction' }, amount: { $sum: '$amount' } } },
    ]);
    const sum = (event: LedgerEventType, direction: LedgerDirection) =>
      rows.filter((r) => r._id.event === event && r._id.direction === direction).reduce((s, r) => s + r.amount, 0);
    const originalFee = sum(LedgerEventType.PAYMENT_CAPTURED, LedgerDirection.DEBIT);
    const alreadyReturned = sum(LedgerEventType.GATEWAY_FEE_ADJUSTED, LedgerDirection.CREDIT);

    const payment = await Payment.findOne({ orderId: order._id, status: { $in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] } })
      .select('amount')
      .lean();
    if (!payment && originalFee === 0) return;

    const returned = gatewayFeeReturned(cfg, originalFee, refundedAmount, payment?.amount ?? order.finance?.customerTotal ?? 0, alreadyReturned);
    const operationCost = gatewayOperationFee(cfg, operation).total;
    if (returned === 0 && operationCost === 0) return;

    await ledgerService.recordGatewayFeeAdjustment({
      orderId: order._id,
      pricingConfigVersion: cfg.version,
      reference: `gateway-fee:${reference}`,
      currency: order.finance?.currency,
      returned,
      operationCost,
    });
  }

  /**
   * ¿La cancelación sin cobro ya deshizo el libro de este pedido?
   *
   * `onCancelled` revierte el reconocimiento contra la cuenta por cobrar con
   * la referencia `cancel:<pedido>` y SIN fila `Refund` (no se devolvió dinero:
   * no se había cobrado). `refundedTotal` y `allocatedSoFar` solo leen `Refund`,
   * así que un reembolso posterior veía el pedido entero como reembolsable y
   * revertía el libro otra vez (M-001: comisión negativa, comercio deudor).
   * El asiento es la prueba: se mira el libro, no un estado que pudo cambiar.
   */
  private async booksUnwoundByCancellation(order: IOrder): Promise<boolean> {
    if (order.status !== OrderStatus.CANCELLED) return false;
    return Boolean(await LedgerEntry.exists({ orderId: order._id, reference: `cancel:${order._id}` }));
  }

  /**
   * Devuelve un cobro que llegó DESPUÉS de cancelar sin cobro (`onCaptured`
   * lo dejó PAID y retenido para revisión).
   *
   * Ese dinero nunca entró al libro (M-004) y el pedido ya se deshizo entero,
   * así que devolverlo no reparte nada: es el mismo dinero saliendo por donde
   * entró. Se devuelve completo —no hay «parte» de un pedido que ya no existe—
   * y queda una fila `Refund` con reparto en cero para que se vea, se cuente
   * una sola vez y bloquee el segundo intento.
   */
  private async returnLateCapture(
    order: IOrder,
    params: { orderId: string; amount?: number; reason: string; requestedBy?: string; idempotencyKey?: string; external: string | null }
  ): Promise<IRefund> {
    const payment = await Payment.findOne({
      orderId: order._id,
      status: PaymentStatus.PAID,
      'metadata.requiresReview': true,
    });
    if (!payment) {
      throw new AppError(
        'Este pedido se canceló sin cobro y su contabilidad ya se deshizo: no hay nada que reembolsar.',
        409,
        'ORDER_ALREADY_UNWOUND'
      );
    }
    if (await Refund.exists({ paymentId: payment._id, status: { $in: [RefundStatus.COMPLETED, RefundStatus.PENDING] } })) {
      throw new AppError('Ese cobro tardío ya se devolvió o se está devolviendo.', 409, 'REFUND_IN_FLIGHT');
    }
    const amount = payment.amount;
    if (params.amount !== undefined && params.amount !== amount) {
      throw new AppError(
        `Un cobro que llegó después de cancelar se devuelve completo: $${amount.toLocaleString('es-CO')}.`,
        422,
        'LATE_CAPTURE_FULL_ONLY'
      );
    }

    let refund: IRefund;
    try {
      refund = await Refund.create({
        orderId: order._id,
        paymentId: payment._id,
        kind: params.external ? RefundKind.EXTERNAL : RefundKind.FULL,
        status: RefundStatus.PENDING,
        amount,
        currency: order.finance?.currency ?? 'COP',
        reason: params.external
          ? `${params.reason} (cobro tardío sobre pedido cancelado; externo, ref. ${params.external})`
          : `${params.reason} (cobro tardío sobre pedido cancelado)`,
        allocation: { ...ZERO_ALLOCATION },
        idempotencyKey: params.idempotencyKey,
        requestedBy: params.requestedBy ?? null,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new AppError('Ya hay un reembolso en curso para este pedido.', 409, 'REFUND_IN_FLIGHT');
      }
      throw error;
    }

    if (params.external) {
      refund.transactionId = `external:${params.external}`;
    } else if (payment.transactionId) {
      try {
        const intent = await getPaymentProvider().refund(payment.transactionId, amount);
        refund.transactionId = intent.id;
      } catch (error) {
        refund.status = RefundStatus.FAILED;
        refund.reason = `${refund.reason} — falló en la pasarela: ${(error as Error).message}`;
        await refund.save();
        // El importe sigue pendiente y queda dicho por qué: Wompi solo anula
        // transacciones completas y a veces ya están liquidadas; en ese caso lo
        // devuelve una persona desde el dashboard y lo registra como reembolso externo.
        await Payment.updateOne(
          { _id: payment._id },
          {
            $set: {
              'metadata.lateCapture.state': 'refund_failed',
              'metadata.lateCapture.pendingAmount': amount,
              'metadata.lateCapture.lastError': (error as Error).message.slice(0, 300),
              'metadata.lateCapture.lastAttemptAt': new Date().toISOString(),
              'metadata.lateCapture.reconciliation': 'pending_manual',
            },
          }
        );
        void notifyAlertsChanged('refund_failed');
        throw new AppError('El proveedor de pagos rechazó el reembolso. No se modificó ningún saldo.', 502);
      }
    }

    refund.status = RefundStatus.COMPLETED;
    refund.processedAt = new Date();
    await refund.save();

    // Sin libro que tocar: el pedido pasa a reembolsado y el cobro deja de
    // pedir revisión, con la fecha en que se devolvió.
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: PaymentStatus.REFUNDED } });
    const now = new Date().toISOString();
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          'metadata.lateCaptureRefundedAt': now,
          'metadata.lateCaptureRefundId': String(refund._id),
          // El dinero ya volvió al cliente: la revisión de ese cobro está resuelta y sale de la
          // bandeja. Lo que queda abierto es la conciliación del costo de la pasarela.
          'metadata.reviewResolvedAt': now,
          'metadata.reviewResolvedBy': params.requestedBy ?? 'system',
          'metadata.reviewResolution': `Devuelto al cliente (reembolso ${String(refund._id)})`,
        },
      }
    );
    await this.recordLateCaptureOutcome(order, payment, refund, params.external);
    void notifyAlertsChanged('payment_review');
    return refund;
  }

  /**
   * Cierra la cuenta de un cobro tardío ya devuelto: qué costó la pasarela y en
   * qué estado de conciliación queda.
   *
   *  · Se asienta como gasto de ZIPP lo que Wompi se queda: su comisión sobre el
   *    cobro (la guardada al detectarlo, o la estimación vigente) menos lo que
   *    devuelva SEGÚN la política configurada (`gatewayFeeRefundBps`; sin definir,
   *    no se asume que devuelva nada), más el costo de la anulación.
   *  · Mientras las tarifas no estén configuradas el importe es 0 y no se asienta
   *    nada —no se inventa un costo—; queda `unconfigured`.
   *  · Siempre es una estimación hasta cotejarla con el extracto de Wompi:
   *    `reconciliation` lo dice y Finanzas lo cierra.
   *  · Si el asiento falla, el reembolso ya hecho NO se deshace: el costo queda
   *    como `pending_manual` con el error, visible en el cobro.
   */
  private async recordLateCaptureOutcome(
    order: IOrder,
    payment: IPayment,
    refund: IRefund,
    external: string | null
  ): Promise<void> {
    const state = external ? 'refunded_external' : 'refunded';
    try {
      const cfg = await pricingConfigService.getCurrent();
      const stored = (payment.metadata as Record<string, any> | undefined)?.gatewayFee;
      const feeTotal = typeof stored?.total === 'number'
        ? stored.total
        : gatewayFeeSnapshot(cfg, payment.paymentMethodType, payment.amount).total;
      const returned = gatewayFeeReturned(cfg, feeTotal, payment.amount, payment.amount, 0);
      const operationCost = gatewayOperationFee(cfg, 'refund').total;
      const expense = feeTotal - returned + operationCost;

      if (expense > 0) {
        await ledgerService.recordLateCaptureGatewayCost({
          orderId: order._id,
          pricingConfigVersion: cfg.version,
          reference: `gateway-fee:late:${payment._id}`,
          currency: order.finance?.currency,
          amount: expense,
        });
      }
      await Payment.updateOne(
        { _id: payment._id },
        {
          $set: {
            'metadata.lateCapture.state': state,
            'metadata.lateCapture.pendingAmount': 0,
            'metadata.lateCapture.refundId': String(refund._id),
            'metadata.lateCapture.refundedAt': new Date().toISOString(),
            'metadata.lateCapture.gatewayCost': {
              fee: feeTotal,
              feeReturned: returned,
              operationCost,
              booked: expense,
              feeRefundPolicyDefined: cfg.gatewayFeeRefundBps != null,
              contractVerified: !!cfg.gatewayContractRef?.trim(),
            },
            'metadata.lateCapture.reconciliation': expense > 0 ? 'estimated' : 'unconfigured',
          },
        }
      );
    } catch (error) {
      console.error('[REFUND] No se pudo asentar el costo de la pasarela de un cobro tardío', {
        paymentId: String(payment._id), error,
      });
      await Payment.updateOne(
        { _id: payment._id },
        {
          $set: {
            'metadata.lateCapture.state': state,
            'metadata.lateCapture.pendingAmount': 0,
            'metadata.lateCapture.refundId': String(refund._id),
            'metadata.lateCapture.reconciliation': 'pending_manual',
            'metadata.lateCapture.gatewayCostError': (error as Error).message.slice(0, 300),
          },
        }
      );
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
          driverRetained: { $sum: '$allocation.driverRetained' },
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
      driverRetained: row.driverRetained ?? 0,
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
    cause?: RefundCause;
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

    // M-001: igual que en `issue`.
    if (await this.booksUnwoundByCancellation(order)) {
      return this.returnLateCapture(order, {
        orderId: params.orderId,
        amount: params.amount,
        reason: params.reason,
        requestedBy: params.requestedBy,
        idempotencyKey,
        external: normalizedReference,
      });
    }

    assertMoney(params.amount, 'reembolso');
    const { kind, allocation: firstAllocation } = await this.planRefund(order, { amount: params.amount, kind: RefundKind.EXTERNAL });
    let allocation = firstAllocation;
    const cause = params.cause ?? RefundCause.UNSPECIFIED;

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
          driverRetained: allocation.driverRetained ?? 0,
        },
        cause,
        driverPay: driverPayDescriptor(allocation, cause, finance.driverPayout > 0),
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

    // Igual que en `issue`: el saldo se vuelve a leer bajo el cerrojo.
    try {
      const replanned = await this.planRefund(await Order.findById(order._id) ?? order, { amount: params.amount, kind: RefundKind.EXTERNAL });
      if (JSON.stringify(replanned.allocation) !== JSON.stringify(allocation)) {
        refund.allocation = {
          ...replanned.allocation,
          fromDeliveryMargin: Math.max(0, replanned.allocation.fromDeliveryMargin),
          driverRetained: replanned.allocation.driverRetained ?? 0,
        } as IRefund['allocation'];
        refund.driverPay = driverPayDescriptor(replanned.allocation, cause, finance.driverPayout > 0);
        await refund.save();
        allocation = replanned.allocation;
      }
    } catch (error) {
      await Refund.deleteOne({ _id: refund._id, status: RefundStatus.PENDING });
      throw error;
    }

    await this.applyReversal(order, allocation, params.amount, kind, captured, String(refund._id));

    refund.status = RefundStatus.COMPLETED;
    refund.transactionId = `external:${normalizedReference}`;
    refund.processedAt = new Date();
    await refund.save();

    return refund;
  }

  /**
   * Cierra la revisión del pago de un domiciliario con posible responsabilidad
   * (M-013). Atómica: solo pasa de `pending` a una decisión, una vez.
   *
   *  · `keep`: se confirma que conserva su pago.
   *  · `escalate`: se manda a operaciones/legal para una medida que NO es un
   *    descuento automático. ZIPP no le arrastra deuda al domiciliario por una
   *    tarifa ya ganada (decisión de negocio vigente); cualquier descuento sería
   *    una decisión humana fuera de este flujo, y aquí queda la constancia.
   *
   * Esta decisión no mueve dinero.
   */
  async resolveDriverPayReview(
    refundId: string,
    staffId: string,
    decision: 'keep' | 'escalate',
    note: string
  ): Promise<IRefund> {
    const text = note.trim();
    if (text.length < 10) throw new AppError('Explica la decisión (mínimo 10 caracteres): queda en la auditoría.', 422);
    if (!Types.ObjectId.isValid(refundId)) throw new AppError('Reembolso no encontrado', 404);

    const updated = await Refund.findOneAndUpdate(
      { _id: refundId, 'driverPay.review.status': 'pending' },
      {
        $set: {
          'driverPay.review.status': decision === 'keep' ? 'kept' : 'escalated',
          'driverPay.review.decidedBy': new Types.ObjectId(staffId),
          'driverPay.review.decidedAt': new Date(),
          'driverPay.review.note': text.slice(0, 500),
        },
      },
      { new: true }
    );
    if (updated) return updated;
    if (await Refund.exists({ _id: refundId, 'driverPay.review.status': { $in: ['kept', 'escalated'] } })) {
      throw new AppError('Esa revisión ya fue resuelta.', 409);
    }
    throw new AppError('Este reembolso no tiene un pago de domiciliario en revisión.', 404);
  }

  async listForOrder(orderId: string) {
    return Refund.find({ orderId }).sort({ createdAt: -1 });
  }

  /**
   * Bandeja de reembolsos y contracargos de todos los pedidos, para finanzas.
   *
   * `attention` reúne lo que pide una decisión: fallidos (hay que reintentar o
   * hacerlo por fuera) y pendientes de más de 15 minutos (un cerrojo que no
   * se liberó). Los contracargos van siempre marcados aparte porque la
   * pasarela fija un plazo para disputarlos.
   */
  async listAll(params: {
    status?: RefundStatus;
    kind?: RefundKind;
    attention?: boolean;
    /** Solo los que dejaron un pago del domiciliario en revisión. */
    driverReview?: 'pending';
    page?: number;
    limit?: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (params.status) filter.status = params.status;
    if (params.kind) filter.kind = params.kind;
    if (params.driverReview) filter['driverPay.review.status'] = 'pending';
    if (params.attention) {
      filter.$or = [
        { status: RefundStatus.FAILED },
        { status: RefundStatus.PENDING, createdAt: { $lt: new Date(Date.now() - 15 * 60_000) } },
      ];
    }
    const limit = params.limit ?? 25;
    const page = Math.max(1, params.page ?? 1);
    const [rows, total, summaryRows] = await Promise.all([
      Refund.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: 'orderId', select: 'orderNumber total businessId', populate: { path: 'businessId', select: 'name' } })
        .lean(),
      Refund.countDocuments(filter),
      Refund.aggregate([
        { $group: { _id: { status: '$status', kind: '$kind' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
    ]);

    const items = rows.map((r: any) => ({
      _id: String(r._id),
      orderId: r.orderId ? String(r.orderId._id ?? r.orderId) : null,
      orderNumber: r.orderId?.orderNumber ?? null,
      orderTotal: r.orderId?.total ?? null,
      businessName: r.orderId?.businessId?.name ?? null,
      kind: r.kind,
      status: r.status,
      amount: r.amount,
      reason: r.reason,
      transactionId: r.transactionId ?? null,
      allocation: r.allocation,
      cause: r.cause ?? 'unspecified',
      driverPay: r.driverPay ?? null,
      processedAt: r.processedAt ?? null,
      createdAt: r.createdAt,
    }));

    const totals = { chargebacks: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, completed: { count: 0, amount: 0 } };
    for (const row of summaryRows) {
      const bucket = totals[row._id.status as 'failed' | 'pending' | 'completed'];
      if (bucket) { bucket.count += row.count; bucket.amount += row.amount; }
      if (row._id.kind === RefundKind.CHARGEBACK && row._id.status !== 'failed') {
        totals.chargebacks.count += row.count;
        totals.chargebacks.amount += row.amount;
      }
    }
    return { items, totals, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }
}

export const refundService = new RefundService();
