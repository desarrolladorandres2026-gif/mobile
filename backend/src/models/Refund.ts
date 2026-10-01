import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { RefundStatus, RefundKind } from '../types';

/**
 * Money returned to the customer, in whole or in part.
 *
 * A refund is its own record rather than a status on the payment, because
 * partial refunds accumulate and each one has to reverse its own slice of
 * commission, payouts and tax. `allocation` is that slice — computed once,
 * persisted, and posted to the ledger as compensating entries.
 */
export interface IRefund extends Document {
  orderId: Types.ObjectId;
  paymentId?: Types.ObjectId | null;
  kind: RefundKind;
  status: RefundStatus;
  /** Total returned to the customer. */
  amount: number;
  currency: string;
  reason: string;
  /**
   * How the refund is charged back across the parties. Sums to `amount`
   * minus any platform-absorbed remainder.
   */
  allocation: {
    fromMerchantPayout: number;
    fromDriverPayout: number;
    fromCommission: number;
    fromServiceFee: number;
    fromDeliveryMargin: number;
    fromTax: number;
    fromPlatform: number;
  };
  transactionId?: string | null;
  /** Client-supplied key so a retried refund never doubles up. */
  idempotencyKey?: string;
  requestedBy?: Types.ObjectId | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const refundSchema = new Schema<IRefund>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    kind: { type: String, enum: Object.values(RefundKind), required: true },
    status: { type: String, enum: Object.values(RefundStatus), default: RefundStatus.PENDING },
    amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'El reembolso debe ser un entero en COP' },
    },
    currency: { type: String, default: 'COP' },
    reason: { type: String, default: '', maxlength: 300 },
    allocation: {
      fromMerchantPayout: { type: Number, default: 0, min: 0 },
      fromDriverPayout: { type: Number, default: 0, min: 0 },
      fromCommission: { type: Number, default: 0, min: 0 },
      fromServiceFee: { type: Number, default: 0, min: 0 },
      fromDeliveryMargin: { type: Number, default: 0, min: 0 },
      fromTax: { type: Number, default: 0, min: 0 },
      fromPlatform: { type: Number, default: 0, min: 0 },
    },
    transactionId: { type: String, default: null },
    idempotencyKey: { type: String, unique: true, sparse: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

refundSchema.index({ orderId: 1, createdAt: -1 });
refundSchema.index({ status: 1 });

/**
 * Un solo reembolso en curso por pedido.
 *
 * `issue()` calcula cuánto queda por devolver sumando los reembolsos ya
 * completados. Dos peticiones simultáneas —un doble clic en el panel sin
 * clave de idempotencia, un reintento de red— leían las dos el mismo saldo,
 * las dos pasaban, y en un pedido en efectivo (sin pasarela que se niegue a
 * anular dos veces) las dos revertían libros y liquidaciones. La fila
 * PENDING es el cerrojo: se toma antes de calcular nada, y el índice hace
 * que solo una pueda existir.
 */
refundSchema.index(
  { orderId: 1 },
  {
    unique: true,
    name: 'one_refund_in_flight_per_order',
    partialFilterExpression: { status: RefundStatus.PENDING },
  }
);

refundSchema.plugin(realtimeInvalidatePlugin, { resource: 'finance' });
export const Refund = mongoose.model<IRefund>('Refund', refundSchema);

// ── Webhook de-duplication ───────────────────────────────────────────

/**
 * Every webhook the platform accepts, recorded before it is acted on.
 *
 * Gateways retry aggressively and deliver out of order; without this a
 * duplicate "approved" callback would capture the same payment twice and
 * accrue payouts twice. The unique index is the lock.
 */
export interface IProcessedWebhook extends Document {
  provider: string;
  /** Provider event id when present, else a hash of the raw body. */
  eventKey: string;
  paymentReference: string;
  status: string;
  orderId?: Types.ObjectId | null;
  handled: boolean;
  result?: string;
  createdAt: Date;
}

const processedWebhookSchema = new Schema<IProcessedWebhook>(
  {
    provider: { type: String, required: true },
    eventKey: { type: String, required: true },
    paymentReference: { type: String, default: '' },
    status: { type: String, default: '' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    handled: { type: Boolean, default: false },
    result: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

processedWebhookSchema.index({ provider: 1, eventKey: 1 }, { unique: true });

// Deduplication only needs to outlive the gateway's retry window, but these
// rows are also the audit trail for "did we ever receive that event?", so
// they are kept for 90 days and then expired. Without this the collection
// grows for the life of the platform, and its unique index with it.
processedWebhookSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ProcessedWebhook = mongoose.model<IProcessedWebhook>(
  'ProcessedWebhook',
  processedWebhookSchema
);
