import crypto from 'crypto';
import { Types } from 'mongoose';
import { LedgerEntry, ILedgerEntry, IOrderFinance } from '../models';
import { LedgerAccount, LedgerDirection, LedgerEventType } from '../types';
import { assertMoney } from '../utils';

export interface LedgerLine {
  account: LedgerAccount;
  direction: LedgerDirection;
  amount: number;
  memo?: string;
}

export interface PostContext {
  orderId: string | Types.ObjectId;
  event: LedgerEventType;
  pricingConfigVersion: number;
  businessId?: string | Types.ObjectId | null;
  driverId?: string | Types.ObjectId | null;
  reference?: string;
  currency?: string;
}

export class LedgerImbalanceError extends Error {
  constructor(debits: number, credits: number, event: string) {
    super(`Asiento descuadrado en "${event}": débitos ${debits} ≠ créditos ${credits}`);
    this.name = 'LedgerImbalanceError';
  }
}

/**
 * Append-only double-entry bookkeeping for orders.
 *
 * Nothing here ever updates a row. Reversals are posted as opposite-signed
 * batches, so the history of an account is replayable and an auditor can
 * always see what happened rather than what the current state implies.
 */
export class LedgerService {
  /**
   * Writes one balanced batch.
   *
   * Refuses to write anything unless debits equal credits — a partial or
   * lopsided batch is worse than no batch, because it silently corrupts
   * every downstream total.
   *
   * Idempotent: the unique index on
   * (orderId, event, account, direction, reference) means a retried call
   * inserts nothing and reports `duplicated`.
   */
  async post(ctx: PostContext, lines: LedgerLine[]): Promise<{
    groupId: string;
    entries: ILedgerEntry[];
    duplicated: boolean;
  }> {
    const meaningful = lines.filter((line) => line.amount !== 0);

    if (meaningful.length === 0) {
      return { groupId: '', entries: [], duplicated: false };
    }

    let debits = 0;
    let credits = 0;
    for (const line of meaningful) {
      assertMoney(line.amount, `asiento ${line.account}`);
      if (line.direction === LedgerDirection.DEBIT) debits += line.amount;
      else credits += line.amount;
    }

    if (debits !== credits) {
      const error = new LedgerImbalanceError(debits, credits, ctx.event);
      console.error('[LEDGER]', error.message, { orderId: String(ctx.orderId), lines: meaningful });
      throw error;
    }

    const groupId = crypto.randomUUID();
    const reference = ctx.reference ?? '';

    const documents = meaningful.map((line) => ({
      groupId,
      orderId: ctx.orderId,
      event: ctx.event,
      account: line.account,
      direction: line.direction,
      amount: line.amount,
      currency: ctx.currency ?? 'COP',
      pricingConfigVersion: ctx.pricingConfigVersion,
      businessId: ctx.businessId ?? null,
      driverId: ctx.driverId ?? null,
      reference,
      memo: line.memo ?? '',
    }));

    try {
      const entries = await LedgerEntry.insertMany(documents, { ordered: true });
      return { groupId, entries, duplicated: false };
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        // Another delivery of the same event already posted this batch.
        const entries = await LedgerEntry.find({ orderId: ctx.orderId, event: ctx.event });
        return { groupId: entries[0]?.groupId ?? '', entries, duplicated: true };
      }
      throw error;
    }
  }

  /**
   * Books an order at placement time.
   *
   * Revenue, payables and tax are recognised here against a receivable:
   * the customer owes us, we owe the merchant and the driver. Capturing
   * the payment later just converts the receivable into cash — it does not
   * re-recognise revenue, which is what keeps a duplicate webhook harmless.
   */
  async recordOrderPlaced(params: {
    orderId: string | Types.ObjectId;
    finance: IOrderFinance;
    businessId?: string | Types.ObjectId | null;
    driverId?: string | Types.ObjectId | null;
  }) {
    const f = params.finance;

    const lines: LedgerLine[] = [
      {
        account: LedgerAccount.RECEIVABLE,
        direction: LedgerDirection.DEBIT,
        amount: f.customerTotal,
        memo: 'Total a cargo del cliente',
      },
      {
        account: LedgerAccount.PROMOTION_EXPENSE,
        direction: LedgerDirection.DEBIT,
        amount: f.platformPromotionExpense,
        memo: 'Descuento financiado por ZIPP',
      },
      {
        account: LedgerAccount.MERCHANT_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: f.businessPayout,
        memo: 'Por pagar al comercio',
      },
      {
        account: LedgerAccount.DRIVER_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: f.driverPayout,
        memo: 'Por pagar al repartidor (tarifa + propina)',
      },
      {
        account: LedgerAccount.COMMISSION_REVENUE,
        direction: LedgerDirection.CREDIT,
        amount: f.merchantCommission,
        memo: 'Comisión del comercio',
      },
      {
        account: LedgerAccount.SERVICE_FEE_REVENUE,
        direction: LedgerDirection.CREDIT,
        amount: f.customerServiceFee,
        memo: 'Fee de servicio al cliente',
      },
      {
        account: LedgerAccount.TAX_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: f.taxPayable,
        memo: 'Impuestos por pagar',
      },
    ];

    // Delivery margin can be negative when a promotional customer fee sits
    // below the driver's guarantee. A negative credit is not a thing, so it
    // flips to a debit and books as the loss it is.
    if (f.deliveryMargin >= 0) {
      lines.push({
        account: LedgerAccount.DELIVERY_MARGIN_REVENUE,
        direction: LedgerDirection.CREDIT,
        amount: f.deliveryMargin,
        memo: 'Margen de domicilio',
      });
    } else {
      lines.push({
        account: LedgerAccount.DELIVERY_MARGIN_REVENUE,
        direction: LedgerDirection.DEBIT,
        amount: Math.abs(f.deliveryMargin),
        memo: 'Subsidio de domicilio asumido por ZIPP',
      });
    }

    return this.post(
      {
        orderId: params.orderId,
        event: LedgerEventType.ORDER_PLACED,
        pricingConfigVersion: f.pricingConfigVersion,
        businessId: params.businessId,
        driverId: params.driverId,
        currency: f.currency,
      },
      lines
    );
  }

  /** Converts the receivable into collected cash once the gateway confirms. */
  async recordPaymentCaptured(params: {
    orderId: string | Types.ObjectId;
    amount: number;
    pricingConfigVersion: number;
    transactionId: string;
    currency?: string;
  }) {
    return this.post(
      {
        orderId: params.orderId,
        event: LedgerEventType.PAYMENT_CAPTURED,
        pricingConfigVersion: params.pricingConfigVersion,
        reference: params.transactionId,
        currency: params.currency,
      },
      [
        {
          account: LedgerAccount.CUSTOMER_PAYMENT,
          direction: LedgerDirection.DEBIT,
          amount: params.amount,
          memo: 'Cobro confirmado por la pasarela',
        },
        {
          account: LedgerAccount.RECEIVABLE,
          direction: LedgerDirection.CREDIT,
          amount: params.amount,
          memo: 'Cancelación del cobro pendiente',
        },
      ]
    );
  }

  /**
   * Settles a cash delivery at the door.
   *
   * The driver collects the customer's whole total, but most of it is
   * already discharged the moment they hand it over: they paid the merchant
   * out of their own fund, and their fee and tip are money they simply keep.
   * Only the platform's share stays outstanding, so that is all that lands
   * in CASH_IN_TRANSIT — booking the full total there would leave a balance
   * the remittance could never clear.
   */
  async recordCashCollected(params: {
    orderId: string | Types.ObjectId;
    /** Total handed over by the customer. */
    customerTotal: number;
    businessPayout: number;
    driverPayout: number;
    /** customerTotal − businessPayout − driverPayout. */
    cashToRemit: number;
    pricingConfigVersion: number;
    driverId: string | Types.ObjectId;
    businessId?: string | Types.ObjectId | null;
    currency?: string;
  }) {
    return this.post(
      {
        orderId: params.orderId,
        event: LedgerEventType.ORDER_DELIVERED,
        pricingConfigVersion: params.pricingConfigVersion,
        driverId: params.driverId,
        businessId: params.businessId,
        currency: params.currency,
      },
      [
        {
          account: LedgerAccount.MERCHANT_PAYABLE,
          direction: LedgerDirection.DEBIT,
          amount: params.businessPayout,
          memo: 'El repartidor pagó al comercio en efectivo',
        },
        {
          account: LedgerAccount.DRIVER_PAYABLE,
          direction: LedgerDirection.DEBIT,
          amount: params.driverPayout,
          memo: 'El repartidor retuvo su tarifa y propina',
        },
        {
          account: LedgerAccount.CASH_IN_TRANSIT,
          direction: LedgerDirection.DEBIT,
          amount: params.cashToRemit,
          memo: 'Efectivo de ZIPP en poder del repartidor',
        },
        {
          account: LedgerAccount.RECEIVABLE,
          direction: LedgerDirection.CREDIT,
          amount: params.customerTotal,
          memo: 'Cobro en efectivo al cliente',
        },
      ]
    );
  }

  /** Clears cash in transit once a remittance is verified. */
  async recordCashSettled(params: {
    orderId: string | Types.ObjectId;
    amount: number;
    pricingConfigVersion: number;
    driverId: string | Types.ObjectId;
    reference: string;
    currency?: string;
  }) {
    return this.post(
      {
        orderId: params.orderId,
        event: LedgerEventType.CASH_SETTLED,
        pricingConfigVersion: params.pricingConfigVersion,
        driverId: params.driverId,
        reference: params.reference,
        currency: params.currency,
      },
      [
        {
          account: LedgerAccount.CUSTOMER_PAYMENT,
          direction: LedgerDirection.DEBIT,
          amount: params.amount,
          memo: 'Efectivo rendido a ZIPP',
        },
        {
          account: LedgerAccount.CASH_IN_TRANSIT,
          direction: LedgerDirection.CREDIT,
          amount: params.amount,
          memo: 'Baja de efectivo en tránsito',
        },
      ]
    );
  }

  /**
   * Da de baja el efectivo que un domiciliario nunca llegó a cobrar.
   *
   * Es el cierre contable de un faltante que finanzas resolvió a favor del
   * domiciliario. Hasta que existió este asiento, perdonarle la deuda le
   * quitaba la obligación pero dejaba el dinero en `CASH_IN_TRANSIT` para
   * siempre: el balance decía que había efectivo en la calle que nadie iba
   * a traer nunca, y ese saldo solo podía crecer.
   *
   * No es una reversión del pedido. El cliente recibió su comida, el
   * comercio cobró y el domiciliario cobró su tarifa: todo eso pasó y se
   * queda como está. Lo único que cambia es que la parte de ZIPP se
   * reconoce como pérdida en vez de como un cobro pendiente, que es
   * exactamente lo que es.
   *
   * `reference` viene del expediente que motivó la baja, así que el
   * índice único hace la operación idempotente: reintentar la resolución
   * no vuelve a castigar la cuenta de gasto.
   */
  async recordCashShortage(params: {
    orderId: string | Types.ObjectId;
    /** Lo que queda vivo en CASH_IN_TRANSIT para este pedido. */
    amount: number;
    pricingConfigVersion: number;
    driverId: string | Types.ObjectId;
    /** Identificador del expediente: `incident:<id>`. */
    reference: string;
    currency?: string;
  }) {
    return this.post(
      {
        orderId: params.orderId,
        event: LedgerEventType.CASH_SHORTAGE_WRITTEN_OFF,
        pricingConfigVersion: params.pricingConfigVersion,
        driverId: params.driverId,
        reference: params.reference,
        currency: params.currency,
      },
      [
        {
          account: LedgerAccount.CASH_SHORTAGE_EXPENSE,
          direction: LedgerDirection.DEBIT,
          amount: params.amount,
          memo: 'Faltante de efectivo asumido por la plataforma',
        },
        {
          account: LedgerAccount.CASH_IN_TRANSIT,
          direction: LedgerDirection.CREDIT,
          amount: params.amount,
          memo: 'Baja del efectivo que el repartidor no llegó a cobrar',
        },
      ]
    );
  }

  /**
   * Reverses an order's recognition, wholly or partly.
   *
   * Takes the exact per-account allocation rather than a single total, so a
   * partial refund reverses precisely the slice of commission, payouts and
   * tax that it should — and the batch still balances.
   */
  async recordReversal(params: {
    orderId: string | Types.ObjectId;
    event: LedgerEventType;
    pricingConfigVersion: number;
    reference: string;
    businessId?: string | Types.ObjectId | null;
    driverId?: string | Types.ObjectId | null;
    currency?: string;
    allocation: {
      fromMerchantPayout: number;
      fromDriverPayout: number;
      fromCommission: number;
      fromServiceFee: number;
      fromDeliveryMargin: number;
      fromTax: number;
      fromPlatform: number;
    };
    /** Total returned to (or clawed back from) the customer. */
    customerAmount: number;
    /** True when the money never reached us — cancellation before capture. */
    againstReceivable: boolean;
  }) {
    const a = params.allocation;

    const lines: LedgerLine[] = [
      // Undo what we owed and what we earned.
      {
        account: LedgerAccount.MERCHANT_PAYABLE,
        direction: LedgerDirection.DEBIT,
        amount: a.fromMerchantPayout,
        memo: 'Reversión de payout al comercio',
      },
      {
        account: LedgerAccount.DRIVER_PAYABLE,
        direction: LedgerDirection.DEBIT,
        amount: a.fromDriverPayout,
        memo: 'Reversión de payout al repartidor',
      },
      {
        account: LedgerAccount.COMMISSION_REVENUE,
        direction: LedgerDirection.DEBIT,
        amount: a.fromCommission,
        memo: 'Reversión de comisión',
      },
      {
        account: LedgerAccount.SERVICE_FEE_REVENUE,
        direction: LedgerDirection.DEBIT,
        amount: a.fromServiceFee,
        memo: 'Reversión de fee de servicio',
      },
      {
        // A negative margin was booked as a debit at placement (a subsidy),
        // so unwinding it is a credit. Mirroring the sign here is what lets
        // the reversal of a subsidised delivery still balance.
        account: LedgerAccount.DELIVERY_MARGIN_REVENUE,
        direction:
          a.fromDeliveryMargin >= 0 ? LedgerDirection.DEBIT : LedgerDirection.CREDIT,
        amount: Math.abs(a.fromDeliveryMargin),
        memo: 'Reversión de margen de domicilio',
      },
      {
        account: LedgerAccount.TAX_PAYABLE,
        direction: LedgerDirection.DEBIT,
        amount: a.fromTax,
        memo: 'Reversión de impuestos',
      },
      // Give back the promotion expense we no longer incur.
      {
        account: LedgerAccount.PROMOTION_EXPENSE,
        direction: LedgerDirection.CREDIT,
        amount: a.fromPlatform,
        memo: 'Reversión de gasto promocional',
      },
    ];

    // The credit side names where the money goes back to. REFUND and
    // CHARGEBACK are contra-asset accounts sitting against
    // CUSTOMER_PAYMENT, so cash on hand is
    // `CUSTOMER_PAYMENT + REFUND + CHARGEBACK` and each outflow reason keeps
    // its own reportable line instead of being netted away invisibly.
    const outflowAccount = params.againstReceivable
      ? LedgerAccount.RECEIVABLE
      : params.event === LedgerEventType.CHARGEBACK_RECEIVED
        ? LedgerAccount.CHARGEBACK
        : LedgerAccount.REFUND;

    lines.push({
      account: outflowAccount,
      direction: LedgerDirection.CREDIT,
      amount: params.customerAmount,
      memo: params.againstReceivable
        ? 'Cobro pendiente anulado'
        : 'Devolución al cliente',
    });

    return this.post(
      {
        orderId: params.orderId,
        event: params.event,
        pricingConfigVersion: params.pricingConfigVersion,
        reference: params.reference,
        businessId: params.businessId,
        driverId: params.driverId,
        currency: params.currency,
      },
      lines
    );
  }

  /** Net balance of an account: debits minus credits. */
  async accountBalance(account: LedgerAccount, filter: Record<string, unknown> = {}) {
    const [result] = await LedgerEntry.aggregate([
      { $match: { account, ...filter } },
      {
        $group: {
          _id: null,
          debit: {
            $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', 0] },
          },
          credit: {
            $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.CREDIT] }, '$amount', 0] },
          },
        },
      },
    ]);

    const debit = result?.debit ?? 0;
    const credit = result?.credit ?? 0;
    return { debit, credit, balance: debit - credit };
  }

  /** Full trail for one order, oldest first. */
  async forOrder(orderId: string | Types.ObjectId) {
    return LedgerEntry.find({ orderId }).sort({ createdAt: 1 });
  }

  /** Confirms the whole book balances. Used by tests and admin health. */
  async isBalanced(filter: Record<string, unknown> = {}): Promise<boolean> {
    const [result] = await LedgerEntry.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          debit: {
            $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.DEBIT] }, '$amount', 0] },
          },
          credit: {
            $sum: { $cond: [{ $eq: ['$direction', LedgerDirection.CREDIT] }, '$amount', 0] },
          },
        },
      },
    ]);
    if (!result) return true;
    return result.debit === result.credit;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidate = error as { code?: number; writeErrors?: Array<{ code?: number }> };
  if (candidate?.code === 11000) return true;
  return Boolean(candidate?.writeErrors?.some((e) => e.code === 11000));
}

export const ledgerService = new LedgerService();
