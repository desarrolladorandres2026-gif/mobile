import { Types } from 'mongoose';
import { Order } from '../models';
import { OrderKind, OrderStatus, PaymentMethod, RefundStatus } from '../types';

/**
 * Efectivo que el comercio debe tener en el cajón por los pedidos contra
 * entrega.
 *
 * ── Por qué no es `productSubtotal` ──
 *
 * En un pedido contra entrega el domiciliario paga al comercio
 * `finance.businessPayout` al recoger (sale del fondo rotatorio), no el valor
 * del producto: a este último ya se le restó la comisión de ZIPP y el
 * descuento que financió el comercio. El cierre de caja que comparaba el
 * efectivo contado contra el subtotal acusaba un faltante falso por pedido.
 *
 * ── Qué cuenta ──
 *
 * Contra entrega (o sin `paymentMethod`, pedidos viejos que eran todos contra
 * entrega), que no sea mandado, ya recogido (`PICKED_UP`, `ON_WAY`,
 * `DELIVERED`) y cuyo momento de recogida cae en la ventana. El momento es
 * `pickedUpAt`, y si falta `deliveredAt`, y si falta `createdAt`. Un
 * programado creado ayer y recogido hoy cuenta hoy.
 *
 * Reembolsos parciales: se resta lo que el reembolso quitó al pago del comercio
 * (`allocation.fromMerchantPayout`) SOLO si se completó antes de la recogida:
 * el domiciliario pagó entonces el neto (`finance.businessPayout − Σ allocation`,
 * ver `refundService.netOf`). Un reembolso posterior a la recogida no saca
 * billetes del cajón —el domiciliario ya había pagado el bruto—, se descuenta
 * como arrastre en la liquidación. Sin reembolsos el valor es el de siempre.
 *
 * Un cancelado después de recoger no cuenta: el sistema le repone el fondo al
 * domiciliario. Se informa aparte para que quien cierra sepa que hubo uno.
 *
 * Todo entero en COP. Los nombres de las claves son neutros a propósito:
 * esta forma llega a la portada del empleado y no puede nombrar comisión,
 * neto ni descuentos.
 */

export interface CashHandover {
  /** Pesos que debe haber en el cajón por lo que los domiciliarios pagaron en la ventana. */
  expectedCash: number;
  /** Pedidos contra entrega que suman a `expectedCash`. */
  cashOrders: number;
  /** De lo anterior, lo que aún no se entrega al cliente (el domiciliario ya pagó al recoger). */
  inTransit: { count: number; amount: number };
  /** Cancelados después de recoger: no suman a `expectedCash`. */
  cancelledAfterPickup: { count: number; amount: number };
}

const CASH_ON_DELIVERY_MATCH = {
  $or: [{ paymentMethod: PaymentMethod.CASH_ON_DELIVERY }, { paymentMethod: null }],
};

/**
 * Lo que el domiciliario pagó al comercio por este pedido: el pago del
 * snapshot menos lo reembolsado antes de la recogida (`refundedBeforePickup`,
 * que añade el `$lookup` de abajo; 0 si no hubo).
 */
const handedOver = {
  $max: [
    0,
    {
      $subtract: [
        { $ifNull: ['$finance.businessPayout', '$businessPayout'] },
        { $ifNull: ['$refundedBeforePickup', 0] },
      ],
    },
  ],
};

/** Suma de `fromMerchantPayout` de reembolsos completados antes del momento de recogida. */
const refundedBeforePickupStages = (handoverAtField: string) => [
  {
    $lookup: {
      from: 'refunds',
      let: { oid: '$_id', at: handoverAtField },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$orderId', '$$oid'] },
                { $eq: ['$status', RefundStatus.COMPLETED] },
                { $lte: [{ $ifNull: ['$processedAt', '$createdAt'] }, '$$at'] },
              ],
            },
          },
        },
        { $group: { _id: null, total: { $sum: '$allocation.fromMerchantPayout' } } },
      ],
      as: '_refunded',
    },
  },
  { $addFields: { refundedBeforePickup: { $ifNull: [{ $first: '$_refunded.total' }, 0] } } },
];

/** Momento de recogida; `$ifNull` anidado porque el de varios argumentos no existe. */
const pickupMoment = { $ifNull: ['$pickedUpAt', { $ifNull: ['$deliveredAt', '$createdAt'] }] };

const IN_TRANSIT: OrderStatus[] = [OrderStatus.PICKED_UP, OrderStatus.ON_WAY];

export async function cashHandover(businessId: Types.ObjectId, from: Date, to: Date): Promise<CashHandover> {
  const rows: Array<{ _id: OrderStatus; count: number; amount: number }> = await Order.aggregate([
    {
      $match: {
        businessId,
        kind: { $ne: OrderKind.ERRAND },
        $and: [
          CASH_ON_DELIVERY_MATCH,
          {
            $or: [
              { status: { $in: [OrderStatus.PICKED_UP, OrderStatus.ON_WAY, OrderStatus.DELIVERED] } },
              // Cancelado solo cuenta si ya había salido del local.
              { status: OrderStatus.CANCELLED, pickedUpAt: { $ne: null } },
            ],
          },
        ],
      },
    },
    { $addFields: { handoverAt: pickupMoment } },
    { $match: { handoverAt: { $gte: from, $lte: to } } },
    ...refundedBeforePickupStages('$handoverAt'),
    { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: handedOver } } },
  ]);

  const sum = (pick: (status: OrderStatus) => boolean) => {
    const mine = rows.filter((row) => pick(row._id));
    return {
      count: mine.reduce((n, row) => n + row.count, 0),
      amount: Math.round(mine.reduce((n, row) => n + (row.amount ?? 0), 0)),
    };
  };

  const collected = sum((status) => status !== OrderStatus.CANCELLED);
  return {
    expectedCash: collected.amount,
    cashOrders: collected.count,
    inTransit: sum((status) => IN_TRANSIT.includes(status)),
    cancelledAfterPickup: sum((status) => status === OrderStatus.CANCELLED),
  };
}
