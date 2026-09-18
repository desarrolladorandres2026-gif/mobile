import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Una tarjeta que el cliente pidió guardar para pagar con un toque.
 *
 * Lo que se guarda aquí **no permite cobrar a nadie**: ni número, ni CVV,
 * ni token de un solo uso. La tarjeta vive en Wompi como "fuente de pago" y
 * este documento solo recuerda su identificador y lo necesario para
 * pintarla ("Visa ···· 4242").
 *
 * Y aun ese identificador nunca sale hacia la app. La app se refiere a la
 * tarjeta por el `_id` de este documento y el servidor lo traduce tras
 * comprobar el dueño. Si la app mandara el `payment_source_id` de Wompi, un
 * número entero, bastaría adivinar uno para cobrarle a la tarjeta de otra
 * persona.
 *
 * Borrar el documento basta para que la tarjeta deje de poder usarse desde
 * Zipp: sin él no hay forma de llegar a su fuente de pago.
 */
export interface ISavedCard extends Document {
  userId: Types.ObjectId;
  /** Id de la fuente de pago en Wompi. Solo lo lee el servidor. */
  gatewaySourceId: number;
  /** Proveedor que emitió la fuente; una fuente de Wompi no vale en otro. */
  provider: string;
  brand: string;
  lastFour: string;
  /** Dos dígitos, como los devuelve la tokenización ("08"). */
  expMonth: string;
  expYear: string;
  /** Orden de la lista: la usada más recientemente va primero. */
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const savedCardSchema = new Schema<ISavedCard>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    gatewaySourceId: { type: Number, required: true },
    provider: { type: String, required: true },
    brand: { type: String, required: true, maxlength: 20 },
    lastFour: { type: String, required: true, match: /^\d{4}$/ },
    expMonth: { type: String, required: true, match: /^(0[1-9]|1[0-2])$/ },
    expYear: { type: String, required: true, match: /^\d{2}$/ },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

savedCardSchema.index({ userId: 1, lastUsedAt: -1 });
// La misma fuente no se guarda dos veces para la misma persona.
savedCardSchema.index({ userId: 1, provider: 1, gatewaySourceId: 1 }, { unique: true });

/** Lo único que la app necesita ver de una tarjeta guardada. */
export function toPublicCard(card: ISavedCard) {
  return {
    id: card._id.toString(),
    brand: card.brand,
    lastFour: card.lastFour,
    expMonth: card.expMonth,
    expYear: card.expYear,
    lastUsedAt: card.lastUsedAt,
  };
}

export const SavedCard = mongoose.model<ISavedCard>('SavedCard', savedCardSchema);
