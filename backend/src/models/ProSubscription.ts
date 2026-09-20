import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Estado de una membresía Zipp Pro.
 *
 * `CANCELLED` **no** quiere decir "sin acceso": quiere decir "no vuelve a
 * cobrarse". Quien cancela un martes y pagó hasta fin de mes sigue siendo
 * Pro hasta fin de mes, porque ya lo pagó. Lo que decide si hoy hay
 * beneficios es la fecha (`currentPeriodEnd`), nunca el estado a secas —
 * confundir las dos cosas es la forma más rápida de quitarle a alguien
 * algo por lo que ya pagó.
 */
export enum ProSubscriptionStatus {
  /** Hay un cobro en curso y todavía no hay dinero. No da beneficios. */
  PENDING = 'pending',
  ACTIVE = 'active',
  /** Sigue vigente hasta `currentPeriodEnd`, pero no se renueva. */
  CANCELLED = 'cancelled',
  /** El periodo terminó y no se pudo cobrar el siguiente. */
  EXPIRED = 'expired',
}

export interface IProSubscription extends Document {
  userId: Types.ObjectId;
  status: ProSubscriptionStatus;
  /** El plan que se contrató, tal como estaba el día del cobro. */
  planId: string;
  /** Lo que se cobró de verdad. No se lee del archivo de configuración:
   *  si mañana sube el precio, esta suscripción siguió costando esto. */
  price: number;
  currency: string;
  /** La primera vez que esta persona fue Pro. No se mueve al renovar. */
  startedAt: Date | null;
  currentPeriodStart: Date | null;
  /** Hasta cuándo hay beneficios pagados. Es el campo que manda. */
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  /** Tarjeta con la que se renueva. Sin ella no hay renovación posible. */
  savedCardId: Types.ObjectId | null;
  lastPaymentId: Types.ObjectId | null;
  cancelledAt: Date | null;
  /** Rechazos seguidos de la renovación. Vuelve a cero en cuanto entra. */
  renewalFailures: number;
  lastRenewalAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const proSubscriptionSchema = new Schema<IProSubscription>(
  {
    // Único: una persona tiene una membresía, que se renueva o se deja
    // vencer. Un segundo documento para el mismo usuario significaría dos
    // cobros mensuales corriendo a la vez, y el índice es el único sitio
    // donde dos peticiones simultáneas no pueden pasar las dos.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    status: {
      type: String,
      enum: Object.values(ProSubscriptionStatus),
      default: ProSubscriptionStatus.PENDING,
      index: true,
    },
    planId: { type: String, required: true },
    price: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, default: 'COP' },
    startedAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    autoRenew: { type: Boolean, default: true },
    savedCardId: { type: Schema.Types.ObjectId, ref: 'SavedCard', default: null },
    lastPaymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    cancelledAt: { type: Date, default: null },
    renewalFailures: { type: Number, default: 0, min: 0 },
    lastRenewalAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// El barrido de renovaciones pregunta "¿qué vence ya?" cada hora. Sin esto
// sería un recorrido completo de la colección, y crece con cada persona
// que alguna vez fue Pro, no con las que lo son hoy.
proSubscriptionSchema.index({ status: 1, autoRenew: 1, currentPeriodEnd: 1 });

/**
 * ¿Da beneficios ahora mismo?
 *
 * Una sola función, usada por el motor de precios y por la pantalla, para
 * que no haya dos definiciones de "ser Pro" que puedan discrepar.
 */
export function isProActive(
  sub: Pick<IProSubscription, 'status' | 'currentPeriodEnd'> | null,
  now = new Date()
): boolean {
  if (!sub || !sub.currentPeriodEnd) return false;
  if (sub.status !== ProSubscriptionStatus.ACTIVE && sub.status !== ProSubscriptionStatus.CANCELLED) {
    return false;
  }
  return sub.currentPeriodEnd.getTime() > now.getTime();
}

export const ProSubscription = mongoose.model<IProSubscription>(
  'ProSubscription',
  proSubscriptionSchema
);
