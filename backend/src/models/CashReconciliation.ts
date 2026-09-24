import mongoose, { Schema, Document, Types } from 'mongoose';
import { CashReconciliationStatus } from '../types';

/**
 * Cash a driver collected on the platform's behalf and still owes it.
 *
 * Replaces the old `DriverDebt`, whose only transition was a driver-invoked
 * "mark as paid" with no money attached. Here the driver may only move the
 * record to REPORTED (a declaration); reaching VERIFIED requires either a
 * gateway transaction the platform can see or a finance admin, and SETTLED
 * is admin/settlement-only. The role check lives in the service, but the
 * status machine below makes the illegal jump unrepresentable anyway.
 */
export interface ICashReconciliation extends Document {
  driverId: Types.ObjectId;
  orderId: Types.ObjectId;
  /**
   * What the driver owes: commission + service fee + delivery margin + tax.
   * The driver's own fee and tip are never part of this.
   */
  amount: number;
  breakdown: {
    merchantCommission: number;
    customerServiceFee: number;
    deliveryMargin: number;
    taxPayable: number;
  };
  currency: string;
  status: CashReconciliationStatus;
  dueAt: Date;
  /** Driver's declaration. */
  reportedAt?: Date | null;
  reportedReference?: string;
  /** Confirmed by a verified transaction or a finance admin. */
  verifiedAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;
  verificationMethod?: 'gateway_transaction' | 'admin_confirmation' | null;
  transactionId?: string | null;
  /** Comprobante de la consignación verificada por un admin de finanzas. */
  receiptUrl?: string | null;
  settledAt?: Date | null;
  settlementId?: Types.ObjectId | null;
  /** Set when a cancellation/refund voids the obligation. */
  voidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Transitions the state machine allows. Anything else is rejected. */
export const CASH_RECONCILIATION_TRANSITIONS: Record<
  CashReconciliationStatus,
  CashReconciliationStatus[]
> = {
  [CashReconciliationStatus.PENDING]: [
    CashReconciliationStatus.REPORTED,
    CashReconciliationStatus.VERIFIED,
    CashReconciliationStatus.OVERDUE,
  ],
  [CashReconciliationStatus.REPORTED]: [
    CashReconciliationStatus.VERIFIED,
    // A declaration that turns out to be false goes back to pending.
    CashReconciliationStatus.PENDING,
    CashReconciliationStatus.OVERDUE,
  ],
  [CashReconciliationStatus.VERIFIED]: [CashReconciliationStatus.SETTLED],
  [CashReconciliationStatus.OVERDUE]: [
    CashReconciliationStatus.REPORTED,
    CashReconciliationStatus.VERIFIED,
  ],
  [CashReconciliationStatus.SETTLED]: [],
};

const cashReconciliationSchema = new Schema<ICashReconciliation>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'El monto debe ser un entero en COP' },
    },
    breakdown: {
      merchantCommission: { type: Number, default: 0, min: 0 },
      customerServiceFee: { type: Number, default: 0, min: 0 },
      deliveryMargin: { type: Number, default: 0, min: 0 },
      taxPayable: { type: Number, default: 0, min: 0 },
    },
    currency: { type: String, default: 'COP' },
    status: {
      type: String,
      enum: Object.values(CashReconciliationStatus),
      default: CashReconciliationStatus.PENDING,
    },
    dueAt: { type: Date, required: true },
    reportedAt: { type: Date, default: null },
    reportedReference: { type: String, default: '' },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verificationMethod: {
      type: String,
      enum: ['gateway_transaction', 'admin_confirmation', null],
      default: null,
    },
    transactionId: { type: String, default: null },
    receiptUrl: { type: String, default: null },
    settledAt: { type: Date, default: null },
    settlementId: { type: Schema.Types.ObjectId, ref: 'Settlement', default: null },
    voidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One reconciliation per order: makes accrual idempotent on retries.
cashReconciliationSchema.index({ orderId: 1 }, { unique: true });
cashReconciliationSchema.index({ driverId: 1, status: 1 });
cashReconciliationSchema.index({ status: 1, dueAt: 1 });

// `verifyByTransaction` pregunta qué otras conciliaciones respalda ya una
// transacción antes de aplicarla. Sin este índice esa consulta recorre la
// colección entera en cada verificación, y es una consulta que corre en el
// camino del dinero.
cashReconciliationSchema.index({ transactionId: 1 }, { sparse: true });

export const CashReconciliation = mongoose.model<ICashReconciliation>(
  'CashReconciliation',
  cashReconciliationSchema
);
