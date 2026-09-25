import mongoose, { Schema, Document } from 'mongoose';

/**
 * Contador de ventana para límites del panel admin, atómico y compartido
 * (Mongo, no memoria de proceso: PM2 recarga y borra cualquier `Map`).
 *
 * `key` incluye el cubo de tiempo (`nota:<userId>:<minuto>`), así cada ventana
 * es un documento y el TTL lo limpia solo. El incremento usa `$inc` sobre
 * `count` y `$setOnInsert` solo sobre `expiresAt`: campos distintos, sin
 * `ConflictingUpdateOperators`.
 */
export interface IAdminThrottle extends Document {
  key: string;
  count: number;
  expiresAt: Date;
}

const adminThrottleSchema = new Schema<IAdminThrottle>(
  {
    key: { type: String, required: true, maxlength: 200 },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

adminThrottleSchema.index({ key: 1 }, { unique: true });
adminThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminThrottle = mongoose.model<IAdminThrottle>('AdminThrottle', adminThrottleSchema);
