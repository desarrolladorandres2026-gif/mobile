import mongoose, { Schema, Document, Types } from 'mongoose';
import { LedgerAccount, LedgerDirection, LedgerEventType } from '../types';

/**
 * An immutable double-entry ledger line.
 *
 * Entries are never updated or deleted: a cancellation, refund or
 * chargeback posts *compensating* entries in the opposite direction. That
 * is what makes the financial history auditable — the state of any account
 * is the sum of its entries, and you can always replay how it got there.
 *
 * Every batch shares a `groupId` and must balance: total debits equal
 * total credits. `LedgerService.post` enforces this before writing.
 */
export interface ILedgerEntry extends Document {
  /** Ties every line of one balanced batch together. */
  groupId: string;
  orderId: Types.ObjectId;
  event: LedgerEventType;
  account: LedgerAccount;
  direction: LedgerDirection;
  /** Always positive; `direction` carries the sign. */
  amount: number;
  currency: string;
  /** Config version the amounts were derived from. */
  pricingConfigVersion: number;
  businessId?: Types.ObjectId | null;
  driverId?: Types.ObjectId | null;
  /** Provider transaction / reconciliation id, when relevant. */
  reference?: string;
  memo?: string;
  createdAt: Date;
}

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    groupId: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    event: { type: String, enum: Object.values(LedgerEventType), required: true },
    account: { type: String, enum: Object.values(LedgerAccount), required: true },
    direction: { type: String, enum: Object.values(LedgerDirection), required: true },
    amount: {
      type: Number,
      required: true,
      min: [0, 'Un asiento no puede ser negativo; usa la dirección contraria'],
      validate: { validator: Number.isInteger, message: 'El asiento debe ser un entero en COP' },
    },
    currency: { type: String, default: 'COP' },
    pricingConfigVersion: { type: Number, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', default: null },
    reference: { type: String, default: '' },
    memo: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerEntrySchema.index({ orderId: 1, createdAt: 1 });
ledgerEntrySchema.index({ groupId: 1 });
ledgerEntrySchema.index({ account: 1, createdAt: -1 });
ledgerEntrySchema.index({ businessId: 1, account: 1 });
ledgerEntrySchema.index({ driverId: 1, account: 1 });
// Idempotency: the same event may only be posted once per order.
ledgerEntrySchema.index(
  { orderId: 1, event: 1, account: 1, direction: 1, reference: 1 },
  { unique: true }
);

/** The ledger is append-only. Block the mutating model helpers outright. */
function refuseMutation(this: unknown, next: (err?: Error) => void) {
  next(new Error('El libro mayor es inmutable: registra un asiento compensatorio'));
}
ledgerEntrySchema.pre('updateOne', refuseMutation);
ledgerEntrySchema.pre('updateMany', refuseMutation);
ledgerEntrySchema.pre('findOneAndUpdate', refuseMutation);
ledgerEntrySchema.pre('deleteOne', refuseMutation);
ledgerEntrySchema.pre('deleteMany', function (next) {
  // Test teardown wipes collections directly through the driver, which does
  // not run this hook — so this only blocks application code.
  refuseMutation.call(this, next);
});

export const LedgerEntry = mongoose.model<ILedgerEntry>('LedgerEntry', ledgerEntrySchema);
