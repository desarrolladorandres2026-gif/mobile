import mongoose, { Schema, Document, Types } from 'mongoose';
import { PaymentType, PaymentStatus } from '../types';

/**
 * One entry per status transition, so a support ticket ("Wompi says
 * APPROVED, why does the order still say pending?") can be answered from
 * the database instead of the gateway's dashboard.
 */
export interface IPaymentStatusEvent {
  /** Platform-wide status after this transition. */
  status: PaymentStatus;
  /** Raw gateway status at the time (e.g. Wompi's PENDING/APPROVED/DECLINED/VOIDED/ERROR). */
  gatewayStatus?: string;
  message?: string;
  /**
   * Qué provocó la transición. `cash` es la declaración de un
   * domiciliario y no la de una pasarela: es la única fuente que
   * depende de una persona, así que queda marcada como tal para que un
   * informe pueda separar "lo confirmó Wompi" de "lo dijo alguien".
   */
  source: 'create' | 'webhook' | 'sync' | 'cash' | 'admin';
  at: Date;
}

export interface IPayment extends Document {
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  type: PaymentType;
  method: string;
  status: PaymentStatus;
  /** Raw gateway status mirrored from the latest transition (see statusHistory). */
  gatewayStatus?: string;
  statusMessage?: string;
  amount: number;
  currency: string;
  /**
   * Merchant-generated reference, unique per attempt and set once at
   * creation. It never changes, unlike `transactionId` — which starts out
   * equal to it (redirect-based gateways have no id of their own yet) and
   * is upgraded to the gateway's real id once a webhook or sync reports it.
   */
  reference?: string;
  transactionId?: string;
  metadata?: Record<string, unknown>;
  statusHistory: IPaymentStatusEvent[];
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const statusEventSchema = new Schema<IPaymentStatusEvent>(
  {
    status: { type: String, enum: Object.values(PaymentStatus), required: true },
    gatewayStatus: { type: String, default: null },
    message: { type: String, default: null },
    source: { type: String, enum: ['create', 'webhook', 'sync', 'cash', 'admin'], required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Transiciones que el estado de un pago puede recorrer.
 *
 * Los dos métodos comparten tabla pero no comparten camino: un pago en
 * línea nunca pasa por `CASH_RECEIVED` y uno en efectivo nunca sale de
 * `PENDING`. Tener la tabla escrita —en vez de repartida en condicionales
 * por los servicios— es lo que hace que un salto ilegal ("marcar pagado
 * un pedido que nadie ha entregado") sea imposible de expresar, y no solo
 * algo que alguien se acordó de comprobar.
 *
 * `REFUNDED` es terminal: un reembolso revertido se registra como un
 * cobro nuevo, nunca reabriendo el anterior.
 */
export const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  // ── En línea ──
  [PaymentStatus.PENDING]: [PaymentStatus.PAID, PaymentStatus.FAILED],
  // Un intento fallido puede reintentarse: Wompi emite una referencia nueva.
  [PaymentStatus.FAILED]: [PaymentStatus.PENDING, PaymentStatus.PAID],

  // ── Efectivo ──
  [PaymentStatus.PENDING_CASH]: [
    PaymentStatus.CASH_RECEIVED,
    PaymentStatus.CASH_NOT_RECEIVED,
    // El pedido se cancela antes de que nadie cobre nada.
    PaymentStatus.FAILED,
  ],
  [PaymentStatus.CASH_RECEIVED]: [PaymentStatus.PAID],
  // Un faltante que finanzas resuelve a favor del domiciliario vuelve a
  // cobrarse; el que se da por perdido se cierra como fallido.
  [PaymentStatus.CASH_NOT_RECEIVED]: [PaymentStatus.CASH_RECEIVED, PaymentStatus.FAILED],

  // ── Común ──
  [PaymentStatus.PAID]: [PaymentStatus.REFUNDED],
  [PaymentStatus.REFUNDED]: [],
};

/** Si `next` es alcanzable desde `current`. Un no-op (mismo estado) lo es. */
export function canTransitionPayment(current: PaymentStatus, next: PaymentStatus): boolean {
  if (current === next) return true;
  return (PAYMENT_STATUS_TRANSITIONS[current] ?? []).includes(next);
}

const paymentSchema = new Schema<IPayment>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(PaymentType), required: true },
    method: { type: String, required: true },
    status: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
    gatewayStatus: { type: String, default: null },
    statusMessage: { type: String, default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'COP' },
    // No `default: null` on reference/transactionId: a sparse unique index
    // only skips documents where the field is *absent*, and every online
    // payment sets both at creation anyway (see PaymentService.initiate).
    reference: { type: String },
    transactionId: { type: String },
    metadata: { type: Schema.Types.Mixed, default: {} },
    statusHistory: { type: [statusEventSchema], default: [] },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ userId: 1, type: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ reference: 1 }, { unique: true, sparse: true });
paymentSchema.index({ transactionId: 1 }, { unique: true, sparse: true });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
