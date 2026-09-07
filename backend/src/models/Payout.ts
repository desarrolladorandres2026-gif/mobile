import mongoose, { Schema, Document, Types } from 'mongoose';
import { PayoutStatus, PayoutBeneficiary } from '../types';

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
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

payoutSchema.virtual('netAmount').get(function (this: IPayout) {
  return Math.max(0, this.amount - this.reversedAmount);
});

// One payout per beneficiary per order — makes accrual idempotent.
payoutSchema.index({ orderId: 1, beneficiary: 1 }, { unique: true });
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

export interface ISettlement extends Document {
  beneficiary: PayoutBeneficiary;
  businessId?: Types.ObjectId | null;
  driverId?: Types.ObjectId | null;
  periodStart: Date;
  periodEnd: Date;
  payoutCount: number;
  grossAmount: number;
  reversedAmount: number;
  netAmount: number;
  currency: string;
  reference: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

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
    netAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'COP' },
    /** External transfer reference, so a payment can be traced back. */
    reference: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

settlementSchema.index({ beneficiary: 1, createdAt: -1 });
settlementSchema.index({ businessId: 1, createdAt: -1 });
settlementSchema.index({ driverId: 1, createdAt: -1 });

export const Settlement = mongoose.model<ISettlement>('Settlement', settlementSchema);
