import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * "Vista" de una alerta de la bandeja del panel admin, por persona.
 *
 * Es lo único que se guarda de las alertas: la alerta en sí se calcula desde
 * el dominio (SosAlert, Pqrs...). `key` = `kind:id:stage`, así una escalada
 * (`due_soon` → `overdue`) vuelve a sonar. Caduca sola a los 30 días.
 *
 * El upsert debe usar SOLO `$setOnInsert` (mezclar con `$set`/`$inc` sobre el
 * mismo campo revienta con ConflictingUpdateOperators).
 */
export const ALERT_RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IAlertReceipt extends Document {
  userId: Types.ObjectId;
  key: string;
  seenAt: Date;
}

const alertReceiptSchema = new Schema<IAlertReceipt>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, maxlength: 200 },
    seenAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);

alertReceiptSchema.index({ userId: 1, key: 1 }, { unique: true });
alertReceiptSchema.index({ seenAt: 1 }, { expireAfterSeconds: ALERT_RECEIPT_TTL_SECONDS });

export const AlertReceipt = mongoose.model<IAlertReceipt>('AlertReceipt', alertReceiptSchema);
