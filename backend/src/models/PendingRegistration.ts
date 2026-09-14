import mongoose, { Schema, Document } from 'mongoose';

/**
 * Registro en 3 pasos al estilo Rappi: el celular se confirma por OTP antes
 * de pedir nombre y contraseña, así que todavía no existe un `User` cuando
 * se manda o se valida el código. Este documento sostiene ese estado
 * intermedio hasta que `authService.completeRegistration` lo convierte en
 * una cuenta real, y se borra solo si nadie vuelve a terminarlo.
 */
export interface IPendingRegistration extends Document {
  phone: string;
  otpCode?: string;
  otpExpires?: Date;
  /** Se pone en `true` al validar el OTP; completar el registro lo exige. */
  verified: boolean;
  /** Ventana para terminar el registro una vez verificado el celular. */
  verifiedUntil?: Date;
  createdAt: Date;
}

const pendingRegistrationSchema = new Schema<IPendingRegistration>(
  {
    phone: { type: String, required: true, unique: true },
    otpCode: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    verified: { type: Boolean, default: false },
    verifiedUntil: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Nadie vuelve a un registro a medias después de un día; se borra solo, sin
// dejar números de celular colgando en una colección aparte.
pendingRegistrationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const PendingRegistration = mongoose.model<IPendingRegistration>(
  'PendingRegistration',
  pendingRegistrationSchema
);
