import { Types } from 'mongoose';
import { Payout, Settlement, IOrder, IPayout, ISettlement, ISettlementPayoutAccount, AdInvoice, LedgerEntry, Business, Commission, Driver } from '../models';
import { AppError } from '../middlewares';
import { config } from '../config';
import {
  PayoutStatus,
  PayoutBeneficiary,
  PaymentStatus,
  SettlementPaymentStatus,
  SettlementPaymentMethod,
  CommissionStatus,
  LedgerAccount,
  LedgerDirection,
  LedgerEventType,
} from '../types';
import { assertMoney } from '../utils';
import { ledgerService } from './ledger.service';
import { businessService, businessAad, openForBusiness } from './business.service';
import { logAudit, AuditAction, AuditSeverity, decrypt } from '../security';
import { maskAccount } from '../utils/nit';
import type { Request } from 'express';

/**
 * Reparte `poolTotal` entre pesos `weights` (que suman `weightTotal`) por
 * mayor residuo: cada parte se redondea hacia abajo y los pesos sobrantes
 * van a las partes con mayor fracción perdida, hasta que la suma cuadra
 * exactamente con `poolTotal`. Nunca asigna más de lo que el propio peso
 * permite (`cap`), así ninguna fila recibe más de lo que le corresponde.
 */
function largestRemainderSplit(weights: number[], weightTotal: number, poolTotal: number): number[] {
  if (poolTotal <= 0 || weightTotal <= 0) return weights.map(() => 0);
  const shares = weights.map((w) => {
    const exact = (w * poolTotal) / weightTotal;
    const floored = Math.floor(exact);
    return { floored, remainder: exact - floored, cap: w };
  });
  const assigned = shares.reduce((sum, s) => sum + s.floored, 0);
  let leftover = poolTotal - assigned;
  const order = shares
    .map((_, i) => i)
    .sort((a, b) => shares[b].remainder - shares[a].remainder);
  for (let k = 0; leftover > 0 && k < order.length * 2; k += 1) {
    const idx = order[k % order.length];
    if (shares[idx].floored < shares[idx].cap) {
      shares[idx].floored += 1;
      leftover -= 1;
    }
  }
  return shares.map((s) => s.floored);
}

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
  /** Fila de arrastre (deuda por un reembolso tardío sobre un payout ya pagado), no una venta nueva. */
  isClawback: boolean;
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
    }> = [];

    // Un mandado no tiene comercio al que pagar. Crear igualmente la fila
    // con `businessId: null` metería en la cola de liquidaciones un cobro
    // de cero pesos a nadie, y el índice `{businessId, status}` los iría
    // acumulando todos bajo la misma clave nula.
    if (order.businessId) {
      specs.push({
        beneficiary: PayoutBeneficiary.BUSINESS,
        amount: finance.businessPayout,
        businessId: order.businessId,
      });
    }

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

  /**
   * Reverses part or all of an order's payouts after a refund.
   *
   * Atomic per beneficiary: the mutation is a single `findOneAndUpdate`
   * with a pipeline update, so two concurrent reversals of the same payout
   * (a refund and a chargeback racing) never overwrite each other's delta —
   * `findById → validate → save()` would.
   *
   * When the payout being reversed is already SETTLED, the money already
   * left in a transfer that cannot be un-sent. Instead of silently
   * inflating `reversedAmount` on a closed payout, the *actually applied*
   * delta (capped at what was still owed) is opened as a new PAYABLE
   * `Payout` row flagged `isClawback: true` for the same beneficiary and
   * order — a debt the next `settle()` for that beneficiary discounts,
   * only up to what fits, exactly like the ad-spend deduction.
   */
  async reverse(
    orderId: string | Types.ObjectId,
    amounts: { business?: number; driver?: number },
    /** Referencia del reembolso/contracargo que originó esta reversión, para que el asiento de absorción del domiciliario sea idempotente. */
    reference?: string
  ): Promise<void> {
    const entries: Array<[PayoutBeneficiary, number]> = [
      [PayoutBeneficiary.BUSINESS, amounts.business ?? 0],
      [PayoutBeneficiary.DRIVER, amounts.driver ?? 0],
    ];

    for (const [beneficiary, amount] of entries) {
      if (amount <= 0) continue;

      // `new: false` (Mongoose's default, made explicit) hands back the
      // document as it was immediately before this atomic update, which is
      // what lets us know — without a second, racy read — how much of the
      // requested amount this call actually consumed.
      //
      // El estado solo pasa a REVERSED si el payout **no** está ya
      // reclamado por una liquidación (`settlementId` nulo). Uno ya
      // reclamado —aunque todavía no esté marcado SETTLED— ya tiene su
      // `reversedAtClaim` congelado y su neto ya fue leído por `settle()`;
      // tocar aquí su `status`/`reversedAmount` como si nada hubiera pasado
      // dejaría esa liquidación con un neto que nunca reflejó la reversión.
      const before = await Payout.findOneAndUpdate(
        { orderId, beneficiary, isClawback: { $ne: true } },
        [
          {
            $set: {
              reversedAmount: {
                $min: ['$amount', { $add: ['$reversedAmount', amount] }],
              },
            },
          },
          {
            $set: {
              status: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$status', PayoutStatus.SETTLED] },
                      { $ne: ['$settlementId', null] },
                    ],
                  },
                  '$status',
                  {
                    $cond: [
                      { $gte: ['$reversedAmount', '$amount'] },
                      PayoutStatus.REVERSED,
                      '$status',
                    ],
                  },
                ],
              },
            },
          },
        ],
        { new: false }
      );

      if (!before) continue;

      // Ya reclamado por una liquidación (en curso o ya pagada): el dinero
      // ya salió, o el neto de esa liquidación ya se calculó y no se puede
      // reabrir. La única forma correcta de reflejar la reversión es no
      // tocar esa liquidación y arreglar la cuenta aparte.
      const alreadyCommitted = before.status === PayoutStatus.SETTLED || before.settlementId != null;
      if (!alreadyCommitted) continue;

      const delta = Math.min(amount, before.amount - before.reversedAmount);
      if (delta <= 0) continue;

      if (beneficiary === PayoutBeneficiary.BUSINESS) {
        // Decisión de negocio: solo al comercio se le arrastra. Se abre como
        // otro `Payout` PAYABLE del mismo beneficiario, que la siguiente
        // `settle()` de ese comercio descuenta —topado a lo que quepa—,
        // igual que la publicidad.
        await Payout.create({
          orderId: before.orderId,
          beneficiary,
          businessId: before.businessId ?? null,
          driverId: null,
          amount: delta,
          status: PayoutStatus.PAYABLE,
          becamePayableAt: new Date(),
          currency: before.currency,
          pricingConfigVersion: before.pricingConfigVersion,
          isClawback: true,
        });
      } else {
        // Decisión de negocio: al domiciliario no se le arrastra su tarifa
        // ganada — ya hizo el viaje. `ledgerService.recordReversal` (llamado
        // por `refund.service`) ya debitó `DRIVER_PAYABLE` por este monto
        // como si el pago aún estuviera pendiente, lo que deja esa cuenta en
        // negativo para un payout que ya se pagó. Este asiento la vuelve a
        // cero y mueve el costo a un gasto de ZIPP.
        await ledgerService.post(
          {
            orderId: before.orderId,
            event: LedgerEventType.DRIVER_FEE_ABSORBED,
            pricingConfigVersion: before.pricingConfigVersion,
            driverId: before.driverId ?? null,
            currency: before.currency,
            reference: reference ? `driver-fee-absorbed:${reference}:${before._id}` : `driver-fee-absorbed:${before._id}`,
          },
          [
            {
              account: LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE,
              direction: LedgerDirection.DEBIT,
              amount: delta,
              memo: 'Tarifa del domiciliario en un payout ya pagado, asumida por ZIPP tras el reembolso',
            },
            {
              account: LedgerAccount.DRIVER_PAYABLE,
              direction: LedgerDirection.CREDIT,
              amount: delta,
              memo: 'Cierra a cero el pasivo que la reversión dejó en negativo',
            },
          ]
        );
      }
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

    // Se agrupa también por `isClawback`: una fila de arrastre no es una
    // venta nueva, es una deuda del beneficiario con ZIPP. Sumarla igual que
    // un payout normal inflaba "lo que se le debe" con dinero que en
    // realidad hay que restarle.
    const rows = await Payout.aggregate([
      { $match: match },
      {
        $group: {
          _id: { status: '$status', isClawback: '$isClawback' },
          gross: { $sum: '$amount' },
          reversed: { $sum: '$reversedAmount' },
          count: { $sum: 1 },
        },
      },
    ]);

    const byStatus: Record<string, { gross: number; reversed: number; net: number; count: number }> = {};
    for (const row of rows) {
      const status = row._id.status as string;
      const isClawback = Boolean(row._id.isClawback);
      const rowNet = row.gross - row.reversed;
      const bucket = byStatus[status] ?? { gross: 0, reversed: 0, net: 0, count: 0 };
      bucket.gross += row.gross;
      bucket.reversed += row.reversed;
      bucket.net += isClawback ? -rowNet : rowNet;
      bucket.count += row.count;
      byStatus[status] = bucket;
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
      settlementId: null,
    };
    if (params.businessId) match.businessId = new Types.ObjectId(params.businessId);
    if (params.driverId) match.driverId = new Types.ObjectId(params.driverId);

    // ── A quién se le va a pagar ──
    //
    // Nadie liquida a una cuenta sin verificar. Se comprueba **antes** de
    // reclamar nada, así un 422 no deja payouts tocados; y se guarda una foto
    // de la cuenta en el `Settlement`: la transferencia se hace a ESA cuenta,
    // no a la que el comercio tenga después (cambiarla entre liquidar y pagar
    // desviaba el dinero).
    //
    // Los domiciliarios aún no tienen una cuenta de pago estructurada
    // (`Driver` no la modela): aquí va el gancho — el día que exista, su
    // `snapshotVerifiedPayoutAccount` se llama en una rama `else`.
    let accountSnapshot: ISettlementPayoutAccount | null = null;
    if (params.beneficiary === PayoutBeneficiary.BUSINESS) {
      if (!params.businessId) {
        throw new AppError('businessId es obligatorio para liquidar a un comercio', 400);
      }
      accountSnapshot = await businessService.snapshotVerifiedPayoutAccount(params.businessId);
    }

    // ── Reclamo atómico ──
    //
    // Dos `settle()` a la vez para el mismo beneficiario leían el mismo
    // `Payout.find(match)` y las dos totalizaban el mismo dinero: dos
    // liquidaciones por el mismo pago. `updateMany` con `settlementId: null`
    // en el filtro es la condición que solo deja a una ganar la fila; la
    // otra la encuentra ya reclamada y sigue de largo. `claimId` hace de
    // `_id` del `Settlement` que se crea más abajo, así que no hace falta un
    // segundo `updateMany` para apuntar los payouts hacia él.
    const claimId = new Types.ObjectId();
    // Reclamo con foto: en el mismo `updateMany` se copia `reversedAmount`
    // vigente a `reversedAtClaim`. Es la única lectura de ese campo que
    // cuenta para esta liquidación — cualquier reversión que llegue después
    // (aunque sea a mitad de esta misma función) ya no puede colarse en el
    // cálculo, porque `settle()` usa la foto y `reverse()` sabe, por
    // `settlementId != null`, que tiene que abrir un arrastre en vez de
    // tocar un neto que ya se congeló.
    const claim = await Payout.updateMany(match, [
      { $set: { settlementId: claimId, reversedAtClaim: '$reversedAmount' } },
    ]);
    if (!claim.modifiedCount) {
      return { settlement: null, count: 0, netAmount: 0 };
    }

    // Si algo revienta antes de que exista el `Settlement`, el reclamo se
    // suelta entero para que la siguiente corrida lo vuelva a intentar —
    // nunca queda un payout con `settlementId` fantasma apuntando a una
    // liquidación que nunca se creó.
    let settlementCreated: ISettlement | null = null;
    const claimedAdInvoiceIds: Types.ObjectId[] = [];
    try {
      const payouts = await Payout.find({
        settlementId: claimId,
        isClawback: { $ne: true },
      }).sort({ becamePayableAt: 1 });
      const clawbacks = await Payout.find({
        settlementId: claimId,
        isClawback: true,
      }).sort({ createdAt: 1 });

      const grossAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
      const reversedAmount = payouts.reduce((sum, p) => sum + p.reversedAtClaim, 0);

      // ── Publicidad que compró el comercio ──
      //
      // Es lo que permite anunciarse sin tarjeta ni pasarela: ya recibe un
      // pago semanal de ZIPP y esto es una resta sobre él. Se cobra aquí y
      // no antes porque hasta que no hay liquidación no hay de dónde restar.
      //
      // Solo se cobra lo que cabe. Un mes flojo no puede dejar al comercio
      // debiendo dinero a ZIPP: lo que no alcance sigue pendiente para la
      // siguiente liquidación, que es lo mismo que hace cualquier proveedor
      // serio y evita convertir una compra de publicidad en una deuda.
      let adSpendAmount = 0;

      if (params.beneficiary === PayoutBeneficiary.BUSINESS && params.businessId) {
        const pendingAdInvoices = await AdInvoice.find({
          businessId: new Types.ObjectId(params.businessId),
          settledAgainstPayout: true,
          settledAt: null,
        }).sort({ createdAt: 1 });

        // Reclamo atómico por factura, condicionado a `settledAt: null`: si
        // otra liquidación concurrente para el mismo comercio ya se
        // adelantó con alguna, `findOneAndUpdate` la encuentra ya reclamada
        // y no la vuelve a contar — sin esto, dos liquidaciones podían leer
        // la misma factura pendiente y descontarla dos veces.
        let affordableForAds = grossAmount - reversedAmount;
        for (const invoice of pendingAdInvoices) {
          if (invoice.amount > affordableForAds) break;
          const claimed = await AdInvoice.findOneAndUpdate(
            { _id: invoice._id, settledAt: null },
            { $set: { settledAt: new Date() } }
          );
          if (!claimed) continue; // otra liquidación se la llevó primero
          claimedAdInvoiceIds.push(invoice._id as Types.ObjectId);
          adSpendAmount += invoice.amount;
          affordableForAds -= invoice.amount;
        }
      }

      if (payouts.length === 0) {
        // Solo se reclamaron arrastres (clawbacks) sin ningún payout normal
        // que los pague: nada que liquidar. Se sueltan para que la próxima
        // corrida —cuando ya haya payouts nuevos del mismo beneficiario—
        // los vuelva a intentar.
        if (clawbacks.length) {
          await Payout.updateMany(
            { _id: { $in: clawbacks.map((c) => c._id) } },
            { $set: { settlementId: null } }
          );
        }
        return { settlement: null, count: 0, netAmount: 0 };
      }

      // ── Arrastre de reembolsos tardíos (plan en memoria) ──
      //
      // Mismo criterio que la publicidad: solo se descuenta lo que cabe. Una
      // liquidación nunca puede quedar en neto negativo, así que lo que no
      // alcance a cubrirse se libera (vuelve `settlementId: null`) para que
      // la siguiente corrida de este mismo beneficiario lo vuelva a
      // intentar. Nada se escribe todavía: si el `Settlement` no llega a
      // crearse, el `catch` de abajo suelta el reclamo entero sin dejar
      // arrastres a medio consumir.
      let clawbackAmount = 0;
      let affordable = grossAmount - reversedAmount - adSpendAmount;
      const settledClawbackIds: Types.ObjectId[] = [];
      const releasedClawbackIds: Types.ObjectId[] = [];
      const partialClawbackUpdates: Array<{ id: Types.ObjectId; consume: number }> = [];
      const clawbackDetail: Array<{
        payoutId: Types.ObjectId;
        orderId: Types.ObjectId;
        amount: number;
        pricingConfigVersion: number;
      }> = [];

      for (const cb of clawbacks) {
        if (affordable <= 0) {
          releasedClawbackIds.push(cb._id as Types.ObjectId);
          continue;
        }
        const consume = Math.min(cb.amount, affordable);
        clawbackAmount += consume;
        affordable -= consume;
        clawbackDetail.push({
          payoutId: cb._id as Types.ObjectId,
          orderId: cb.orderId,
          amount: consume,
          pricingConfigVersion: cb.pricingConfigVersion,
        });
        if (consume === cb.amount) {
          settledClawbackIds.push(cb._id as Types.ObjectId);
        } else {
          partialClawbackUpdates.push({ id: cb._id as Types.ObjectId, consume });
        }
      }

      const netAmount = grossAmount - reversedAmount - adSpendAmount - clawbackAmount;

      if (netAmount < 0) {
        // No debería poder pasar (el arrastre se topa a `affordable`), pero
        // se conserva la comprobación como última línea de defensa.
        throw new AppError(
          'La liquidación resultaría negativa: revisa las reversiones antes de liquidar',
          409
        );
      }

      const dates = payouts.map((p) => p.becamePayableAt ?? p.createdAt);

      // Segunda comprobación, lo más cerca posible de la escritura: entre la
      // foto de arriba y aquí el dueño pudo cambiar la cuenta (que vuelve a
      // pendiente). Si cambió, se aborta y el `catch` suelta el reclamo.
      if (accountSnapshot && params.businessId) {
        await businessService.assertPayoutAccountUnchanged(params.businessId, accountSnapshot.version);
      }

      settlementCreated = await Settlement.create({
        _id: claimId,
        beneficiary: params.beneficiary,
        businessId: params.businessId ?? null,
        driverId: params.driverId ?? null,
        periodStart: new Date(Math.min(...dates.map((d) => d.getTime()))),
        periodEnd: new Date(Math.max(...dates.map((d) => d.getTime()))),
        payoutCount: payouts.length,
        grossAmount,
        reversedAmount,
        adSpendAmount,
        clawbackAmount,
        clawbacks: clawbackDetail,
        adInvoiceIds: claimedAdInvoiceIds,
        netAmount,
        reference: params.reference ?? '',
        createdBy: params.createdBy,
        ...(accountSnapshot ? { payoutAccount: accountSnapshot } : {}),
      });

      // A partir de aquí el `Settlement` ya existe: las facturas de
      // publicidad ya quedaron reclamadas atómicamente arriba (una por una,
      // condicionadas a `settledAt: null`); lo que queda son los arrastres,
      // que se pueden reintentar de forma segura si algo falla desde aquí en
      // adelante (los payouts seguirían con `settlementId` apuntando a este
      // `Settlement` real, no a uno fantasma).
      if (releasedClawbackIds.length) {
        await Payout.updateMany(
          { _id: { $in: releasedClawbackIds } },
          { $set: { settlementId: null } }
        );
      }
      for (const update of partialClawbackUpdates) {
        await Payout.updateOne(
          { _id: update.id },
          { $inc: { amount: -update.consume }, $set: { settlementId: null } }
        );
      }

      const settledIds = [...payouts.map((p) => p._id), ...settledClawbackIds];
      await Payout.updateMany(
        { _id: { $in: settledIds } },
        { $set: { status: PayoutStatus.SETTLED, settledAt: new Date() } }
      );

      return { settlement: settlementCreated, count: payouts.length, netAmount };
    } catch (error) {
      if (!settlementCreated) {
        await Payout.updateMany({ settlementId: claimId }, { $set: { settlementId: null } }).catch(
          () => {}
        );
        if (claimedAdInvoiceIds.length) {
          await AdInvoice.updateMany(
            { _id: { $in: claimedAdInvoiceIds } },
            { $set: { settledAt: null } }
          ).catch(() => {});
        }
      }
      throw error;
    }
  }

  /**
   * Registra el pago manual de una liquidación: transferencia/consignación
   * hecha por fuera y anotada aquí con referencia y comprobante.
   *
   * Es el paso que de verdad cierra la liquidación y el asiento contable —
   * `settle()` solo reclama los payouts, no mueve dinero real. Atómico por
   * la condición `paymentStatus: PENDING` en el filtro: un doble clic no
   * puede pagar la misma liquidación dos veces ni duplicar el asiento
   * (además protegido por la idempotencia de `ledgerService.post`, que
   * usa `reference = settlementId` y descarta reintentos exactos).
   */
  async registerPayment(params: {
    settlementId: string;
    method: SettlementPaymentMethod;
    reference: string;
    paidAt?: Date;
    /** Obligatorio (decisión 7): referencia y comprobante, no uno u otro. */
    receiptUrl: string;
    note?: string;
    paidBy: string;
  }): Promise<ISettlement> {
    if (!Types.ObjectId.isValid(params.settlementId)) {
      throw new AppError('Liquidación no encontrada', 404);
    }

    // Decisión 7: comprobante obligatorio además de la referencia — la
    // referencia dice de qué transferencia se trata, el comprobante prueba
    // que existió.
    if (!params.receiptUrl?.trim()) {
      throw new AppError('Adjunta el comprobante del pago', 422);
    }

    const paidAt = params.paidAt ?? new Date();

    // La cuenta a la que se paga es la de la foto del `Settlement`. Si el
    // comercio la cambió (o dejó de estar verificada) desde que se liquidó, no
    // se registra el pago: finanzas tiene que revisarla y, si procede,
    // refrescar la foto (`refreshPayoutAccountSnapshot`). Solo aplica a una
    // liquidación aún pendiente: una ya pagada sigue por el camino de abajo.
    const pending = await Settlement.findOne({
      _id: params.settlementId,
      paymentStatus: SettlementPaymentStatus.PENDING,
      beneficiary: PayoutBeneficiary.BUSINESS,
    }).select('+payoutAccount businessId');
    let snapshotVersion: number | null = null;
    if (pending) {
      if (!pending.payoutAccount) {
        throw new AppError(
          'Esta liquidación no tiene la cuenta de pago registrada (es anterior al control). Refresca la cuenta desde la liquidación antes de pagar.',
          409,
          'PAYOUT_ACCOUNT_SNAPSHOT_MISSING'
        );
      }
      await businessService.assertPayoutAccountUnchanged(String(pending.businessId), pending.payoutAccount.version);
      snapshotVersion = pending.payoutAccount.version;
    }

    const settlement = await Settlement.findOneAndUpdate(
      {
        _id: params.settlementId,
        paymentStatus: SettlementPaymentStatus.PENDING,
        // Si otro finanzas refrescó la foto entre la lectura y esta escritura,
        // el pago se rechaza en vez de aplicarse a una cuenta que no se miró.
        ...(snapshotVersion !== null ? { 'payoutAccount.version': snapshotVersion } : {}),
      },
      {
        $set: {
          paymentStatus: SettlementPaymentStatus.PAID,
          paymentMethod: params.method,
          reference: params.reference,
          paidAt,
          receiptUrl: params.receiptUrl,
          paymentNote: params.note ?? null,
          paidBy: new Types.ObjectId(params.paidBy),
        },
      },
      { new: true }
    );

    if (!settlement) {
      const exists = await Settlement.findById(params.settlementId);
      if (!exists) throw new AppError('Liquidación no encontrada', 404);
      if (exists.paymentStatus !== SettlementPaymentStatus.PAID) {
        // No debería poder pasar (solo hay PENDING/PAID), pero si aparece un
        // tercer estado en el futuro, sigue siendo un conflicto explícito.
        throw new AppError('Esta liquidación no está lista para pagarse', 409);
      }
      // Ya está PAID. Dos casos posibles, y no son el mismo:
      //  · El asiento nunca se posteó (caída justo entre el `findOneAndUpdate`
      //    de arriba y `postSettlementLedgerEntries`, en un intento anterior).
      //    Aquí sí hay algo que recuperar: se relanza el posteo —idempotente
      //    por `reference`— y se responde 200 con la liquidación ya sana.
      //  · El asiento ya existe: esto es un segundo intento de pago genuino
      //    (otra referencia, quizás otro método), no una recuperación. Sigue
      //    siendo un 409 — pagar dos veces la misma liquidación no es algo
      //    que este endpoint deba absorber en silencio.
      const alreadyPosted = await LedgerEntry.exists({ reference: String(exists._id) });
      if (!alreadyPosted) {
        const payouts = await Payout.find({ settlementId: exists._id });
        await this.postSettlementLedgerEntries(exists, payouts);
        return exists;
      }
      throw new AppError('Esta liquidación ya fue pagada', 409);
    }

    const payouts = await Payout.find({ settlementId: settlement._id });

    await Payout.updateMany(
      { settlementId: settlement._id },
      { $set: { status: PayoutStatus.SETTLED } }
    );

    await this.postSettlementLedgerEntries(settlement, payouts);
    await this.settleCommissions(payouts.filter((p) => !p.isClawback).map((p) => p.orderId));

    return settlement;
  }

  /**
   * La cuenta a la que hay que pagar una liquidación, **tal como se verificó
   * al liquidar**. La pantalla de pago usa esta y no la del comercio
   * (`GET /businesses/:id/payout-account/reveal`), que puede haber cambiado.
   * Cada lectura queda en la auditoría con severidad HIGH; el número no se
   * registra, solo sus 4 últimos.
   */
  async revealSettlementPayoutAccount(settlementId: string, req?: Request) {
    if (!Types.ObjectId.isValid(settlementId)) throw new AppError('Liquidación no encontrada', 404);
    const settlement = await Settlement.findById(settlementId).select('+payoutAccount').lean();
    if (!settlement) throw new AppError('Liquidación no encontrada', 404);
    const account = settlement.payoutAccount;
    if (settlement.beneficiary !== PayoutBeneficiary.BUSINESS || !account || !settlement.businessId) {
      throw new AppError(
        'Esta liquidación no tiene una cuenta de pago registrada',
        404,
        'PAYOUT_ACCOUNT_SNAPSHOT_MISSING'
      );
    }

    const businessId = String(settlement.businessId);
    const accountNumber = decrypt(account.accountNumberEnc, businessAad(businessId));
    if (accountNumber === account.accountNumberEnc) {
      throw new AppError('No se pudo descifrar el número de cuenta', 500, 'PAYOUT_ACCOUNT_UNREADABLE');
    }

    const current = await Business.findById(businessId).select('name +payoutAccount').lean();
    const changedSinceSettlement =
      !current?.payoutAccount ||
      current.payoutAccount.version !== account.version ||
      current.payoutAccount.verificationStatus !== 'verified';

    if (req) {
      await logAudit(req, {
        action: AuditAction.SETTLEMENT_PAYOUT_ACCOUNT_REVEALED,
        entity: 'settlement',
        entityId: settlementId,
        severity: AuditSeverity.HIGH,
        description: `Cuenta de pago de la liquidación de ${current?.name ?? 'un comercio'} consultada completa`,
        metadata: {
          businessId,
          accountLast4: account.accountLast4,
          method: account.method,
          version: account.version,
          changedSinceSettlement,
        },
      });
    }

    return {
      settlementId,
      businessId,
      businessName: current?.name ?? null,
      paymentStatus: settlement.paymentStatus,
      netAmount: settlement.netAmount,
      version: account.version,
      method: account.method,
      bankName: account.bankName ?? null,
      accountType: account.accountType ?? null,
      accountNumber,
      accountLast4: account.accountLast4,
      accountMasked: maskAccount(account.accountLast4),
      holderName: account.holderName,
      holderDocument: openForBusiness(account.holderDocumentEnc, businessId),
      verifiedBy: account.verifiedBy ?? null,
      verifiedAt: account.verifiedAt ?? null,
      snapshotAt: account.snapshotAt,
      /** `true` si el comercio cambió la cuenta después de liquidar: no se puede registrar el pago hasta refrescarla. */
      changedSinceSettlement,
    };
  }

  /**
   * Vuelve a tomar la foto de la cuenta de una liquidación **pendiente** con
   * la cuenta actual del comercio, que tiene que estar verificada. Es la
   * salida cuando el comercio cambió la cuenta tras liquidar (o cuando la
   * liquidación es anterior al control y no tiene foto): sin esto la
   * liquidación quedaría sin poder pagarse. Atómico sobre `PENDING` y sobre la
   * versión de la foto que se vio.
   */
  async refreshPayoutAccountSnapshot(settlementId: string, actorId: string, req?: Request) {
    if (!Types.ObjectId.isValid(settlementId)) throw new AppError('Liquidación no encontrada', 404);
    const existing = await Settlement.findOne({
      _id: settlementId,
      beneficiary: PayoutBeneficiary.BUSINESS,
    }).select('+payoutAccount businessId paymentStatus');
    if (!existing || !existing.businessId) throw new AppError('Liquidación no encontrada', 404);
    if (existing.paymentStatus !== SettlementPaymentStatus.PENDING) {
      throw new AppError('Solo se puede refrescar la cuenta de una liquidación pendiente de pago', 409);
    }

    const snapshot = await businessService.snapshotVerifiedPayoutAccount(String(existing.businessId));
    const previousVersion = existing.payoutAccount?.version ?? null;

    const updated = await Settlement.findOneAndUpdate(
      {
        _id: settlementId,
        paymentStatus: SettlementPaymentStatus.PENDING,
        ...(previousVersion !== null ? { 'payoutAccount.version': previousVersion } : { payoutAccount: { $exists: false } }),
      },
      { $set: { payoutAccount: snapshot } },
      { new: true }
    );
    if (!updated) {
      throw new AppError('La liquidación cambió mientras la refrescabas. Vuelve a abrirla.', 409, 'SETTLEMENT_CHANGED');
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.SETTLEMENT_PAYOUT_ACCOUNT_REFRESHED,
        entity: 'settlement',
        entityId: settlementId,
        severity: AuditSeverity.HIGH,
        description: 'Cuenta de pago de una liquidación pendiente refrescada con la cuenta actual verificada',
        metadata: {
          businessId: String(existing.businessId),
          previousVersion,
          newVersion: snapshot.version,
          accountLast4: snapshot.accountLast4,
          by: actorId,
        },
      });
    }
    return { settlementId, previousVersion, version: snapshot.version, accountLast4: snapshot.accountLast4 };
  }

  /**
   * Postea el asiento de desembolso de una liquidación ya pagada.
   *
   * Separado de `registerPayment` para poder relanzarlo tal cual cuando el
   * registro del pago quedó guardado pero el asiento no llegó a postearse
   * (caída justo en medio) — `ledgerService.post` dedupea por `reference`,
   * así que repetir esta llamada nunca duplica un asiento ya escrito.
   */
  private async postSettlementLedgerEntries(
    settlement: ISettlement,
    payouts: IPayout[]
  ): Promise<void> {
    // Los arrastres (`isClawback`) ya redujeron el `netAmount` calculado en
    // `settle()`; no generan su propio asiento de desembolso, o el pago
    // saliente quedaría contado dos veces. Se cierran aparte, más abajo.
    const disbursablePayouts = payouts.filter((p) => !p.isClawback);

    const payableAccount =
      settlement.beneficiary === PayoutBeneficiary.BUSINESS
        ? LedgerAccount.MERCHANT_PAYABLE
        : LedgerAccount.DRIVER_PAYABLE;

    // `reversedAtClaim` (no `reversedAmount` en vivo) es la misma foto que
    // usó `settle()` para calcular `grossAmount`/`reversedAmount`/`netAmount`
    // — cualquier reversión llegada después de reclamar este payout ya no
    // cabe aquí, le corresponde un arrastre en la próxima liquidación.
    const rawNets = disbursablePayouts.map((p) => Math.max(0, p.amount - p.reversedAtClaim));
    const rawTotal = rawNets.reduce((sum, n) => sum + n, 0);

    // El neto de cada payout se reparte en tres bolsillos que suman
    // exactamente lo que ese payout debía: efectivo (`PAYOUT_DISBURSEMENT`),
    // publicidad compensada (`AD_SPEND_OFFSET`) y arrastre compensado
    // (`PAYOUT_OFFSET_CLEARING`, ver más abajo el asiento que cierra el
    // pedido original). Tres repartos por mayor residuo independientes, uno
    // por bolsillo, garantizan que cada bolsillo cuadre con su propio total
    // (`netAmount`, `adSpendAmount`, `clawbackAmount`) sin que uno le robe un
    // peso de redondeo a otro.
    if (rawTotal > 0) {
      const cashShares = largestRemainderSplit(rawNets, rawTotal, settlement.netAmount);
      const adShares = largestRemainderSplit(rawNets, rawTotal, settlement.adSpendAmount);
      const clawShares = largestRemainderSplit(rawNets, rawTotal, settlement.clawbackAmount);

      for (let i = 0; i < disbursablePayouts.length; i += 1) {
        const payout = disbursablePayouts[i];
        const cash = cashShares[i];
        const ad = adShares[i];
        const claw = clawShares[i];
        const debitTotal = cash + ad + claw;
        if (debitTotal <= 0) continue;

        const lines: Array<{ account: LedgerAccount; direction: LedgerDirection; amount: number; memo: string }> = [
          {
            account: payableAccount,
            direction: LedgerDirection.DEBIT,
            amount: debitTotal,
            memo: `Pago de liquidación ${settlement._id}`,
          },
        ];
        if (cash > 0) {
          lines.push({
            account: LedgerAccount.PAYOUT_DISBURSEMENT,
            direction: LedgerDirection.CREDIT,
            amount: cash,
            memo: `Pago de liquidación ${settlement._id}`,
          });
        }
        if (ad > 0) {
          lines.push({
            account: LedgerAccount.AD_SPEND_OFFSET,
            direction: LedgerDirection.CREDIT,
            amount: ad,
            memo: `Publicidad compensada en la liquidación ${settlement._id}`,
          });
        }
        if (claw > 0) {
          lines.push({
            account: LedgerAccount.PAYOUT_OFFSET_CLEARING,
            direction: LedgerDirection.CREDIT,
            amount: claw,
            memo: `Arrastre compensado en la liquidación ${settlement._id}`,
          });
        }

        await ledgerService.post(
          {
            orderId: payout.orderId,
            event: LedgerEventType.SETTLEMENT_PAID,
            pricingConfigVersion: payout.pricingConfigVersion,
            businessId: payout.businessId ?? null,
            driverId: payout.driverId ?? null,
            currency: payout.currency,
            reference: String(settlement._id),
          },
          lines
        );
      }
    }

    // ── Cerrar el pasivo negativo de cada pedido cuyo arrastre se cobró ──
    //
    // Cuando el reembolso tardío llegó, `ledgerService.recordReversal` ya
    // debitó `MERCHANT_PAYABLE` del pedido VIEJO como si su pago siguiera
    // pendiente — pero ya se había pagado, así que esa cuenta quedó en
    // negativo (el comercio nos debe). Este asiento la cierra a cero: la
    // contrapartida es la misma `PAYOUT_OFFSET_CLEARING` que el pedido NUEVO
    // acaba de debitar arriba, así que la cuenta termina en 0 tras este pago
    // — es un cruce entre dos pedidos, no un saldo propio.
    for (const clawback of settlement.clawbacks ?? []) {
      if (clawback.amount <= 0) continue;
      await ledgerService.post(
        {
          orderId: clawback.orderId,
          event: LedgerEventType.SETTLEMENT_PAID,
          pricingConfigVersion: clawback.pricingConfigVersion,
          businessId: settlement.businessId ?? null,
          driverId: settlement.driverId ?? null,
          currency: settlement.currency,
          reference: `clawback:${settlement._id}:${clawback.payoutId}`,
        },
        [
          {
            account: LedgerAccount.PAYOUT_OFFSET_CLEARING,
            direction: LedgerDirection.DEBIT,
            amount: clawback.amount,
            memo: `Arrastre cobrado en la liquidación ${settlement._id}`,
          },
          {
            account: payableAccount,
            direction: LedgerDirection.CREDIT,
            amount: clawback.amount,
            memo: 'Cierra el pasivo que quedó en negativo tras el reembolso tardío',
          },
        ]
      );
    }
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
          // Una fila de arrastre (`isClawback`) no es una venta nueva de ese
          // pedido —la venta y la comisión ya aparecieron en su propia fila
          // cuando se pagó por primera vez—; mostrarlas otra vez aquí
          // duplicaría el pedido en el extracto. Solo el ajuste (negativo)
          // pertenece a esta fila.
          productSubtotal: {
            $cond: ['$isClawback', 0, { $ifNull: ['$order.finance.productSubtotal', '$order.subtotal'] }],
          },
          merchantCommission: {
            $cond: [
              '$isClawback',
              0,
              { $ifNull: ['$order.finance.merchantCommission', '$order.platformCommission'] },
            ],
          },
          merchantFundedDiscount: {
            $cond: ['$isClawback', 0, { $ifNull: ['$order.finance.merchantFundedDiscount', 0] }],
          },
          reversedAmount: '$reversedAmount',
          netAmount: {
            $cond: [
              '$isClawback',
              { $multiply: [-1, { $subtract: ['$amount', '$reversedAmount'] }] },
              { $subtract: ['$amount', '$reversedAmount'] },
            ],
          },
          isClawback: { $ifNull: ['$isClawback', false] },
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

      Settlement.find({ beneficiary: PayoutBeneficiary.BUSINESS, businessId: params.businessId })
        .sort({ createdAt: -1 })
        .limit(20),
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
    paymentStatus?: SettlementPaymentStatus;
    page?: number;
    limit?: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (params.beneficiary) filter.beneficiary = params.beneficiary;
    if (params.businessId) filter.businessId = params.businessId;
    if (params.driverId) filter.driverId = params.driverId;
    if (params.paymentStatus) filter.paymentStatus = params.paymentStatus;

    const limit = params.limit ?? 50;
    const page = Math.max(1, params.page ?? 1);
    const [rows, total] = await Promise.all([
      Settlement.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('businessId', 'name')
        .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
        .lean(),
      Settlement.countDocuments(filter),
    ]);

    // `payoutAccount` es `select: false` y aquí no se pide: la cuenta solo sale
    // por el endpoint de revelar, que audita.
    const items = rows.map((r: any) => ({
      ...r,
      businessName: r.businessId?.name ?? null,
      driverName: r.driverId?.userId?.name ?? null,
      businessId: r.businessId ? String(r.businessId._id ?? r.businessId) : null,
      driverId: r.driverId ? String(r.driverId._id ?? r.driverId) : null,
    }));
    return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /**
   * Lo que ya se puede liquidar, por beneficiario: la lista de trabajo de
   * finanzas cada semana. Solo `PAYABLE` sin liquidación; un arrastre resta.
   * Un neto de 0 o negativo aparece igual (con `net` <= 0): es un saldo que
   * hay que ver, aunque `settle()` no pague nada por él.
   */
  async listPayables(params: { beneficiary?: PayoutBeneficiary } = {}) {
    const match: Record<string, unknown> = { status: PayoutStatus.PAYABLE, settlementId: null };
    if (params.beneficiary) match.beneficiary = params.beneficiary;

    const groups = await Payout.aggregate([
      { $match: match },
      {
        $group: {
          _id: { beneficiary: '$beneficiary', businessId: '$businessId', driverId: '$driverId' },
          count: { $sum: 1 },
          net: {
            $sum: {
              $cond: [
                '$isClawback',
                { $subtract: [0, { $subtract: ['$amount', '$reversedAmount'] }] },
                { $subtract: ['$amount', '$reversedAmount'] },
              ],
            },
          },
          clawbackCount: { $sum: { $cond: ['$isClawback', 1, 0] } },
          oldest: { $min: { $ifNull: ['$becamePayableAt', '$createdAt'] } },
        },
      },
      { $sort: { oldest: 1 } },
      { $limit: 500 },
    ]);

    const businessIds = groups.map((g) => g._id.businessId).filter(Boolean);
    const driverIds = groups.map((g) => g._id.driverId).filter(Boolean);
    const [businesses, drivers] = await Promise.all([
      businessIds.length ? Business.find({ _id: { $in: businessIds } }).select('name').lean() : [],
      driverIds.length
        ? Driver.find({ _id: { $in: driverIds } })
            .select('userId')
            .populate('userId', 'name')
            .lean()
        : [],
    ]);
    const businessName = new Map(businesses.map((b: any) => [String(b._id), b.name as string]));
    const driverName = new Map(drivers.map((d: any) => [String(d._id), (d.userId?.name as string) ?? null]));

    const now = Date.now();
    return groups.map((g) => ({
      beneficiary: g._id.beneficiary as PayoutBeneficiary,
      businessId: g._id.businessId ? String(g._id.businessId) : null,
      driverId: g._id.driverId ? String(g._id.driverId) : null,
      name: g._id.businessId
        ? businessName.get(String(g._id.businessId)) ?? null
        : driverName.get(String(g._id.driverId)) ?? null,
      count: g.count as number,
      clawbackCount: g.clawbackCount as number,
      net: g.net as number,
      oldestAt: g.oldest as Date,
      daysWaiting: Math.max(0, Math.floor((now - new Date(g.oldest).getTime()) / 86_400_000)),
    }));
  }

  /**
   * Una `Commission` pasa a `SETTLED` cuando ya no queda ningún payout del
   * pedido por pagar (ni el del comercio ni el del domiciliario). Antes nada
   * la cerraba nunca. Idempotente: se puede llamar de nuevo sin efecto.
   */
  private async settleCommissions(orderIds: Array<Types.ObjectId | string>): Promise<void> {
    if (orderIds.length === 0) return;
    const stillOpen = await Payout.distinct('orderId', {
      orderId: { $in: orderIds },
      status: { $in: [PayoutStatus.ACCRUED, PayoutStatus.PAYABLE] },
    });
    const open = new Set(stillOpen.map(String));
    const done = orderIds.filter((id) => !open.has(String(id)));
    if (done.length === 0) return;
    await Commission.updateMany(
      { orderId: { $in: done }, status: CommissionStatus.PENDING },
      { $set: { status: CommissionStatus.SETTLED, settledAt: new Date() } }
    );
  }

  // ── Arrastres fuera de una liquidación ──────────────────────────────
  //
  // Un arrastre (`isClawback`) normalmente se cobra solo cuando el mismo
  // comercio vuelve a tener payouts que liquidar — pero un comercio que deja
  // de vender no vuelve a tener liquidaciones, y esa deuda se quedaría
  // PAYABLE para siempre sin que nadie la viera. Estos tres métodos son el
  // camino manual: verla, cobrarla directo (consignación aparte) o
  // castigarla como incobrable.

  /** Arrastres de comercio, para el panel de finanzas. */
  async listClawbacks(params: { status?: 'open' | 'collected' | 'written_off'; businessId?: string }) {
    const match: Record<string, unknown> = { isClawback: true };
    if (params.businessId) match.businessId = new Types.ObjectId(params.businessId);
    if (params.status === 'open') {
      match.status = PayoutStatus.PAYABLE;
      match.settlementId = null;
    } else if (params.status === 'collected') {
      match.status = PayoutStatus.SETTLED;
    } else if (params.status === 'written_off') {
      match.status = PayoutStatus.WRITTEN_OFF;
    }

    const rows = await Payout.find(match)
      .sort({ becamePayableAt: 1 })
      .populate('businessId', 'name')
      .populate('orderId', 'orderNumber')
      .lean();

    const now = Date.now();
    return rows.map((r: any) => ({
      id: String(r._id),
      orderId: r.orderId ? String(r.orderId._id ?? r.orderId) : null,
      orderNumber: r.orderId?.orderNumber ?? null,
      businessId: r.businessId ? String(r.businessId._id ?? r.businessId) : null,
      businessName: r.businessId?.name ?? null,
      amount: r.amount,
      netAmount: Math.max(0, r.amount - r.reversedAmount),
      status: r.status,
      settlementId: r.settlementId ? String(r.settlementId) : null,
      daysOpen: Math.max(
        0,
        Math.floor((now - new Date(r.becamePayableAt ?? r.createdAt).getTime()) / 86_400_000)
      ),
      createdAt: r.createdAt,
    }));
  }

  /**
   * Cobra un arrastre directamente, por fuera de la próxima liquidación del
   * comercio: una consignación aparte, con su propia referencia y
   * comprobante — mismo estándar de evidencia que pagar una liquidación
   * (decisión 7).
   *
   * Atómico por la condición de estado en el filtro: dos clics no pueden
   * cobrar el mismo arrastre dos veces, y uno que ya entró en una
   * liquidación en curso (`settlementId` no nulo) no se puede tocar por
   * aquí — se resuelve solo o con esa liquidación.
   */
  async collectClawback(params: {
    payoutId: string;
    reference: string;
    receiptUrl: string;
  }): Promise<IPayout> {
    if (!Types.ObjectId.isValid(params.payoutId)) {
      throw new AppError('Arrastre no encontrado', 404);
    }
    if (!params.reference?.trim()) {
      throw new AppError('Indica la referencia de la consignación', 422);
    }
    if (!params.receiptUrl?.trim()) {
      throw new AppError('Adjunta el comprobante de la consignación', 422);
    }

    const payout = await Payout.findOneAndUpdate(
      {
        _id: params.payoutId,
        isClawback: true,
        status: PayoutStatus.PAYABLE,
        settlementId: null,
      },
      { $set: { status: PayoutStatus.SETTLED, settledAt: new Date() } },
      { new: true }
    );
    if (!payout) {
      throw new AppError('Arrastre no encontrado o ya no está pendiente de cobro', 409);
    }

    const netAmount = Math.max(0, payout.amount - payout.reversedAmount);
    if (netAmount > 0) {
      const payableAccount =
        payout.beneficiary === PayoutBeneficiary.BUSINESS
          ? LedgerAccount.MERCHANT_PAYABLE
          : LedgerAccount.DRIVER_PAYABLE;

      await ledgerService.post(
        {
          orderId: payout.orderId,
          event: LedgerEventType.CLAWBACK_COLLECTED,
          pricingConfigVersion: payout.pricingConfigVersion,
          businessId: payout.businessId ?? null,
          driverId: payout.driverId ?? null,
          currency: payout.currency,
          reference: `clawback-collect:${payout._id}`,
        },
        [
          {
            account: LedgerAccount.PAYOUT_DISBURSEMENT,
            direction: LedgerDirection.DEBIT,
            amount: netAmount,
            memo: `Arrastre cobrado directo, ref. ${params.reference.trim()}`,
          },
          {
            account: payableAccount,
            direction: LedgerDirection.CREDIT,
            amount: netAmount,
            memo: 'Cierra el arrastre cobrado por fuera de una liquidación',
          },
        ]
      );
    }

    return payout;
  }

  /**
   * Da por incobrable un arrastre tras el seguimiento (>14 días abierto,
   * ver `IncidentCenterService`). Mueve el costo a `BAD_DEBT_EXPENSE`: ZIPP
   * asume la pérdida en vez de dejar la deuda PAYABLE para siempre.
   */
  async writeOffClawback(params: { payoutId: string; reason: string }): Promise<IPayout> {
    if (!Types.ObjectId.isValid(params.payoutId)) {
      throw new AppError('Arrastre no encontrado', 404);
    }
    if (!params.reason?.trim() || params.reason.trim().length < 5) {
      throw new AppError('Indica el motivo del castigo contable (mínimo 5 caracteres)', 422);
    }

    const payout = await Payout.findOneAndUpdate(
      {
        _id: params.payoutId,
        isClawback: true,
        status: PayoutStatus.PAYABLE,
        settlementId: null,
      },
      { $set: { status: PayoutStatus.WRITTEN_OFF, settledAt: new Date() } },
      { new: true }
    );
    if (!payout) {
      throw new AppError('Arrastre no encontrado o ya no está pendiente', 409);
    }

    const netAmount = Math.max(0, payout.amount - payout.reversedAmount);
    if (netAmount > 0) {
      const payableAccount =
        payout.beneficiary === PayoutBeneficiary.BUSINESS
          ? LedgerAccount.MERCHANT_PAYABLE
          : LedgerAccount.DRIVER_PAYABLE;

      await ledgerService.post(
        {
          orderId: payout.orderId,
          event: LedgerEventType.CLAWBACK_WRITTEN_OFF,
          pricingConfigVersion: payout.pricingConfigVersion,
          businessId: payout.businessId ?? null,
          driverId: payout.driverId ?? null,
          currency: payout.currency,
          reference: `clawback-writeoff:${payout._id}`,
        },
        [
          {
            account: LedgerAccount.BAD_DEBT_EXPENSE,
            direction: LedgerDirection.DEBIT,
            amount: netAmount,
            memo: `Arrastre castigado como incobrable: ${params.reason.trim()}`,
          },
          {
            account: payableAccount,
            direction: LedgerDirection.CREDIT,
            amount: netAmount,
            memo: 'Cierra el arrastre castigado como incobrable',
          },
        ]
      );
    }

    return payout;
  }
}

export const payoutService = new PayoutService();
