import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  PayoutStatus,
  PayoutBeneficiary,
  SettlementPaymentMethod,
  SettlementPaymentStatus,
} from '../types';

/**
 * What the platform owes a merchant or a driver for one order.
 *
 * Kept separate from the order so the *obligation* has its own lifecycle:
 * an order can be delivered while its payout is still ACCRUED (payment not
 * captured), and a refund can REVERSE a payout without touching the order.
 * Dashboards read this, not `Order.businessPayout`, so "pending" and
 * "settled" are real states rather than derived guesses.
 */
export interface IPayout extends Document {
  orderId: Types.ObjectId;
  beneficiary: PayoutBeneficiary;
  businessId?: Types.ObjectId | null;
  driverId?: Types.ObjectId | null;
  /** Gross owed before reversals. Always >= 0. */
  amount: number;
  /** Reversed by refunds/chargebacks. Never exceeds `amount`. */
  reversedAmount: number;
  status: PayoutStatus;
  currency: string;
  pricingConfigVersion: number;
  settlementId?: Types.ObjectId | null;
  becamePayableAt?: Date | null;
  settledAt?: Date | null;
  /**
   * Fila de arrastre: no es lo que se le debe al beneficiario, es lo que él
   * le debe a ZIPP porque un reembolso/contracargo llegó después de que su
   * payout original ya estaba SETTLED. Vive como otro `Payout` del mismo
   * beneficiario para que la siguiente `settle()` la descuente con la misma
   * lógica de "solo se cobra lo que cabe" que ya usa la publicidad.
   */
  isClawback: boolean;
  /**
   * Foto de `reversedAmount` tomada atómicamente en el mismo `updateMany`
   * que reclama este payout para una liquidación (`settle()`). El cálculo de
   * la liquidación usa esta foto, no el valor en vivo, para que una
   * reversión que llega mientras `settle()` ya está en curso no pueda colar
   * un neto que nunca se leyó realmente: en vez de eso, `reverse()` ve que
   * el payout ya está reclamado (`settlementId != null`) y abre un arrastre
   * para la siguiente ronda.
   */
  reversedAtClaim: number;
  createdAt: Date;
  updatedAt: Date;
  /** Net still owed. */
  readonly netAmount: number;
}

const payoutSchema = new Schema<IPayout>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    beneficiary: { type: String, enum: Object.values(PayoutBeneficiary), required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    amount: {
      type: Number,
      required: true,
      min: [0, 'Un payout no puede ser negativo'],
      validate: { validator: Number.isInteger, message: 'El payout debe ser un entero en COP' },
    },
    reversedAmount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: Object.values(PayoutStatus), default: PayoutStatus.ACCRUED },
    currency: { type: String, default: 'COP' },
    pricingConfigVersion: { type: Number, required: true },
    settlementId: { type: Schema.Types.ObjectId, ref: 'Settlement', default: null },
    becamePayableAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    isClawback: { type: Boolean, default: false },
    reversedAtClaim: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

payoutSchema.virtual('netAmount').get(function (this: IPayout) {
  return Math.max(0, this.amount - this.reversedAmount);
});

// One (non-clawback) payout per beneficiary per order — makes accrual
// idempotent. Un arrastre de reembolso tardío es una fila aparte a
// propósito (ver `isClawback` arriba), así que queda fuera de este índice.
// Mongo solo admite operadores de igualdad/rango simples en
// `partialFilterExpression` ($ne no vale), así que la condición es
// `isClawback: false` explícito — coincide siempre porque el campo tiene
// default `false` y por tanto está presente en todo documento.
payoutSchema.index(
  { orderId: 1, beneficiary: 1 },
  {
    unique: true,
    partialFilterExpression: { isClawback: false },
    // Nombre explícito: la base real ya tenía un índice sin nombre
    // (`orderId_1_beneficiary_1`, sin `partialFilterExpression`) creado antes
    // de que existiera `isClawback`. Mongo no deja dos índices con las
    // mismas claves aunque cambie el filtro parcial (`IndexKeySpecsConflict`)
    // — hace falta la migración 016 para borrar el viejo antes de desplegar
    // este modelo. Ver `src/migrations/016-payout-clawback-index.ts`.
    name: 'one_payout_per_order_beneficiary',
  }
);
payoutSchema.index({ businessId: 1, status: 1 });
payoutSchema.index({ driverId: 1, status: 1 });
payoutSchema.index({ status: 1, becamePayableAt: 1 });

payoutSchema.pre('validate', function (next) {
  if (this.reversedAmount > this.amount) {
    return next(new Error('La reversión no puede superar el payout original'));
  }
  next();
});

export const Payout = mongoose.model<IPayout>('Payout', payoutSchema);

// ── Settlement batches ───────────────────────────────────────────────

export interface ISettlementPayoutAccount {
  /** `version` de la cuenta del comercio que finanzas verificó. */
  version: number;
  method: 'bank' | 'nequi' | 'daviplata';
  bankName?: string | null;
  accountType?: 'ahorros' | 'corriente' | null;
  /** Cifrado con AAD = businessId, copiado tal cual de la cuenta. Nunca sale en una respuesta. */
  accountNumberEnc: string;
  accountLast4: string;
  holderName: string;
  /** Cifrado con AAD = businessId. */
  holderDocumentEnc?: string | null;
  verifiedBy?: Types.ObjectId | null;
  verifiedAt?: Date | null;
  /** Cuándo se tomó la foto (al liquidar, o al refrescarla). */
  snapshotAt: Date;
}

export interface ISettlement extends Document {
  beneficiary: PayoutBeneficiary;
  businessId?: Types.ObjectId | null;
  driverId?: Types.ObjectId | null;
  periodStart: Date;
  periodEnd: Date;
  payoutCount: number;
  grossAmount: number;
  reversedAmount: number;
  /**
   * Publicidad que el comercio compró y se le descuenta de este pago.
   *
   * Va como línea propia y no restado dentro de `reversedAmount` porque
   * son cosas distintas: una reversión es dinero que nunca llegó a ganar,
   * y esto es algo que compró. Mezclarlas dejaría un extracto donde no se
   * puede explicar por qué el neto bajó.
   */
  adSpendAmount: number;
  /** Arrastre de reembolsos tardíos descontado en esta liquidación (ver `Payout.isClawback`). */
  clawbackAmount: number;
  /**
   * Detalle de cada arrastre cobrado en esta liquidación: de qué `Payout`
   * (arrastre) viene, a qué pedido original pertenece y cuánto se consumió.
   * `registerPayment` lo usa para cerrar a cero el pasivo negativo del
   * pedido viejo (`PAYOUT_OFFSET_CLEARING`); se guarda aquí y no se recalcula
   * porque para entonces el `Payout` de arrastre ya pudo quedar liberado o
   * consumido parcialmente.
   */
  clawbacks: Array<{ payoutId: Types.ObjectId; orderId: Types.ObjectId; amount: number; pricingConfigVersion: number }>;
  /** Facturas de publicidad (`AdInvoice`) descontadas en esta liquidación. */
  adInvoiceIds: Types.ObjectId[];
  netAmount: number;
  currency: string;
  /** Referencia de la transferencia/consignación una vez se registra el pago. */
  reference: string;
  createdBy: Types.ObjectId;
  createdAt: Date;

  /**
   * Foto de la cuenta de pago verificada del comercio al liquidar (solo
   * `beneficiary: business`). El dinero se transfiere a ESTA cuenta, no a la
   * que el comercio tenga después: sin la foto, un cambio de cuenta entre
   * liquidar y pagar desviaba la transferencia. `select: false`: se pide con
   * `+payoutAccount` desde el endpoint de revelar, que audita.
   */
  payoutAccount?: ISettlementPayoutAccount | null;

  // ── Pago manual ──
  // Liquidar solo reclama los payouts; el pago es un paso aparte, manual y
  // registrado en ZIPP, que es lo que cierra la liquidación y el asiento.
  paymentStatus: SettlementPaymentStatus;
  paymentMethod?: SettlementPaymentMethod | null;
  paidAt?: Date | null;
  receiptUrl?: string | null;
  paymentNote?: string | null;
  paidBy?: Types.ObjectId | null;
}

const settlementPayoutAccountSchema = new Schema<ISettlementPayoutAccount>(
  {
    version: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['bank', 'nequi', 'daviplata'], required: true },
    bankName: { type: String, default: null },
    accountType: { type: String, enum: ['ahorros', 'corriente', null], default: null },
    accountNumberEnc: { type: String, required: true },
    accountLast4: { type: String, required: true, maxlength: 4 },
    holderName: { type: String, required: true },
    holderDocumentEnc: { type: String, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    snapshotAt: { type: Date, required: true },
  },
  { _id: false }
);
// Segunda barrera: aunque alguien cargue `+payoutAccount` y serialice, el
// texto cifrado no sale.
settlementPayoutAccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as unknown as Record<string, unknown>).accountNumberEnc;
    delete (ret as unknown as Record<string, unknown>).holderDocumentEnc;
    return ret;
  },
});

const settlementSchema = new Schema<ISettlement>(
  {
    beneficiary: { type: String, enum: Object.values(PayoutBeneficiary), required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    payoutCount: { type: Number, required: true, min: 0 },
    grossAmount: { type: Number, required: true, min: 0 },
    reversedAmount: { type: Number, default: 0, min: 0 },
    adSpendAmount: { type: Number, default: 0, min: 0 },
    clawbackAmount: { type: Number, default: 0, min: 0 },
    clawbacks: {
      type: [
        {
          _id: false,
          payoutId: { type: Schema.Types.ObjectId, ref: 'Payout', required: true },
          orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
          amount: { type: Number, required: true, min: 0 },
          pricingConfigVersion: { type: Number, required: true },
        },
      ],
      default: [],
    },
    adInvoiceIds: { type: [Schema.Types.ObjectId], ref: 'AdInvoice', default: [] },
    netAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'COP' },
    /** External transfer reference, so a payment can be traced back. */
    reference: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    payoutAccount: { type: settlementPayoutAccountSchema, select: false, default: undefined },
    paymentStatus: {
      type: String,
      enum: Object.values(SettlementPaymentStatus),
      default: SettlementPaymentStatus.PENDING,
    },
    paymentMethod: { type: String, enum: Object.values(SettlementPaymentMethod), default: null },
    paidAt: { type: Date, default: null },
    receiptUrl: { type: String, default: null },
    paymentNote: { type: String, default: null, maxlength: 500 },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

settlementSchema.index({ beneficiary: 1, createdAt: -1 });
settlementSchema.index({ businessId: 1, createdAt: -1 });
settlementSchema.index({ driverId: 1, createdAt: -1 });

export const Settlement = mongoose.model<ISettlement>('Settlement', settlementSchema);
