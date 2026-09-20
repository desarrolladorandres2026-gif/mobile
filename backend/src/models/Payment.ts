import mongoose, { Schema, Document, Types } from 'mongoose';
import { PaymentType, PaymentStatus, PaymentMethod } from '../types';

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
  /**
   * El pedido que se cobra. Ausente solo en los cobros que no son de un
   * pedido —hoy, la membresía Zipp Pro—; ver el `required` condicional del
   * esquema.
   */
  orderId?: Types.ObjectId;
  userId: Types.ObjectId;
  type: PaymentType;
  /**
   * Cómo se cobra: `online` o `cash_on_delivery`. Es un `PaymentMethod` de
   * la plataforma y **no** cambia nunca por lo que diga una pasarela.
   *
   * Antes se sobrescribía con el carril que reportaba Wompi (`NEQUI`,
   * `CARD`…), y con ello se borraba el único campo que distingue un cobro
   * en línea de uno en efectivo — la distinción de la que dependen la
   * invalidación de intentos abiertos, la búsqueda del intento vigente y la
   * guarda que impide que un evento de pasarela cierre un cobro en efectivo.
   */
  method: string;
  /** El carril concreto que usó el cliente: CARD, NEQUI, PSE, BANCOLOMBIA_TRANSFER… */
  paymentMethodType?: string;
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
    // Obligatorio salvo en los cobros que no cuelgan de un pedido (la
    // membresía Zipp Pro). Se expresa como condición y no como
    // `required: false`, porque un cobro de pedido sin pedido es un
    // documento roto y el esquema es el único sitio donde se puede impedir
    // que exista.
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: function (this: { type?: PaymentType }) {
        return this.type !== PaymentType.PRO_SUBSCRIPTION;
      },
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(PaymentType), required: true },
    // Acotado al enum: es lo que impide que una pasarela —o un campo
    // reenviado sin mirar— convierta este campo en cualquier cosa.
    method: { type: String, enum: Object.values(PaymentMethod), required: true },
    paymentMethodType: { type: String, default: null },
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

/**
 * Un solo intento en línea abierto por pedido.
 *
 * Dos `initiate` simultáneos para el mismo pedido —doble toque, dos
 * pestañas, un reintento de red— pasaban los dos la comprobación de "¿ya
 * hay un intento pendiente?" antes de que ninguno la hubiera escrito, y
 * salían con dos referencias distintas: dos enlaces de Wompi válidos para
 * el mismo pedido, cada uno cobrable por su cuenta. La condición vive en
 * el índice y no en el código porque es el único sitio donde dos procesos
 * no pueden pasar a la vez. `PaymentService.initiate` atrapa el 11000 y
 * reutiliza el intento que ganó.
 */
paymentSchema.index(
  { orderId: 1 },
  {
    unique: true,
    name: 'one_open_online_payment_per_order',
    partialFilterExpression: {
      status: PaymentStatus.PENDING,
      method: PaymentMethod.ONLINE,
      type: PaymentType.ORDER_PAYMENT,
    },
  }
);

/**
 * Un solo cobro de membresía abierto por persona.
 *
 * El mismo razonamiento que el índice de arriba, sobre el otro eje: la
 * membresía no tiene pedido del que colgar, así que lo que no puede
 * duplicarse es el usuario. Sin esto, un doble toque en "Hazte Pro" —o el
 * reintento de una petición que se quedó sin red— abría dos transacciones
 * en Wompi, y las dos podían cobrarse.
 */
paymentSchema.index(
  { userId: 1 },
  {
    unique: true,
    name: 'one_open_pro_subscription_payment_per_user',
    partialFilterExpression: {
      status: PaymentStatus.PENDING,
      type: PaymentType.PRO_SUBSCRIPTION,
    },
  }
);

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
