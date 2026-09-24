import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * El registro de cada oferta que se le hizo a un domiciliario.
 *
 * Hasta ahora esto vivía dentro del pedido, en `order.dispatch`, y
 * `stopDispatch` lo borraba entero al asignar (`$unset`). Tenía sentido
 * —el reparto había terminado— pero significaba que la plataforma no podía
 * contestar la pregunta más básica sobre su propia operación: a quién se le
 * ofrecen los pedidos y qué hace con ellos. Sin este registro no hay tasa
 * de aceptación, ni forma de saber si los rechazos son por distancia o
 * porque la tarifa no compensa.
 *
 * ── Lo que NO hace ──
 * Estos números son informativos. No entran en el orden de la cascada, que
 * sigue decidiéndose solo por cercanía y ETA real. Es una decisión
 * deliberada: cuando la aceptación pesa en el reparto —el modelo de Rappi,
 * donde además el peso es secreto— la gente acaba aceptando pedidos que no
 * le convienen por miedo a caer en el ranking, y el número deja de medir
 * nada porque todo el mundo lo infla. Aquí sirve para que el domiciliario
 * se vea a sí mismo, y para que nosotros veamos dónde falla el reparto.
 */

export type OfferOutcome =
  | 'pending'
  | 'accepted'
  | 'declined'
  /** Venció sin respuesta. Cuenta en la tasa: se le enseñó y no contestó. */
  | 'expired'
  /**
   * Se lo quedó otro mientras esta oferta seguía viva.
   *
   * Queda fuera de la tasa de aceptación a propósito. En las rondas anchas
   * el mismo pedido se ofrece a varios a la vez y solo uno puede quedárselo:
   * contar como fallo el no haber sido el más rápido penalizaría a quien
   * estaba conduciendo por estar conduciendo.
   */
  | 'taken_by_other';

/** Por qué dijo que no. Opcional: quien va en la moto puede no contestar. */
export type DeclineReason = 'too_far' | 'busy' | 'low_pay' | 'other';

export interface IDriverOffer extends Document {
  driverId: Types.ObjectId;
  orderId: Types.ObjectId;
  /** Ronda de la cascada. La 1 es exclusiva; las siguientes, compartidas. */
  round: number;
  /** ETA hasta el punto de recogida cuando se ofreció, en segundos. */
  etaSeconds: number;
  offeredAt: Date;
  expiresAt: Date;
  outcome: OfferOutcome;
  declineReason?: DeclineReason;
  /** Cuándo contestó. Da el tiempo de reacción sin guardarlo aparte. */
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IDriverOffer>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    round: { type: Number, required: true, min: 1 },
    etaSeconds: { type: Number, default: 0, min: 0 },
    offeredAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    outcome: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired', 'taken_by_other'],
      default: 'pending',
    },
    declineReason: {
      type: String,
      enum: ['too_far', 'busy', 'low_pay', 'other'],
    },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

/**
 * Un domiciliario puede recibir el mismo pedido dos veces: la cascada
 * olvida los rechazos al empezar otra vuelta, y quien dijo que no hace tres
 * minutos puede haber terminado su entrega. Por eso la clave lleva la
 * ronda: sin ella, el segundo ofrecimiento pisaría el primero y se perdería
 * el rechazo que sí ocurrió.
 */
schema.index({ driverId: 1, orderId: 1, round: 1 }, { unique: true });

/** La consulta de las métricas: un domiciliario, una ventana de tiempo. */
schema.index({ driverId: 1, offeredAt: -1 });

/** La ficha del pedido (panel admin): todas las ofertas de un pedido, por ronda. */
schema.index({ orderId: 1, round: 1 });

/** El barrido que cierra las ofertas vencidas. */
schema.index({ outcome: 1, expiresAt: 1 });

export const DriverOffer = mongoose.model<IDriverOffer>('DriverOffer', schema);
