import mongoose, { Schema, Document } from 'mongoose';
import { phoneSetter } from '../utils/phone';

/**
 * OTP de formularios públicos (eliminación de cuenta sin sesión, solicitud de
 * aliados). Es un documento aparte de `User` a propósito: el celular puede no
 * tener cuenta, y para la eliminación existir o no la cuenta no debe notarse
 * ni en la respuesta ni en el tiempo. Mismo contrato de slots que
 * `security/otp.ts` (`OTP_SLOTS.registration`). Se autodestruye.
 */
export type PublicOtpPurpose = 'account_deletion' | 'partner_application';

export interface IPublicOtp extends Document {
  purpose: PublicOtpPurpose;
  phone: string;
  /** HMAC del código, nunca el código. */
  otpCode?: string;
  otpExpires?: Date;
  otpAttempts?: number;
  createdAt: Date;
}

const publicOtpSchema = new Schema<IPublicOtp>(
  {
    purpose: { type: String, enum: ['account_deletion', 'partner_application'], required: true },
    phone: { type: String, required: true, set: phoneSetter },
    otpCode: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, select: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

publicOtpSchema.index({ purpose: 1, phone: 1 }, { unique: true });
publicOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const PublicOtp = mongoose.model<IPublicOtp>('PublicOtp', publicOtpSchema);
