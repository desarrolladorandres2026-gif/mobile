import mongoose, { Schema, Document } from 'mongoose';

/**
 * Buzón de OTP para desarrollo y pruebas. NUNCA existe en producción.
 *
 * Los códigos antes se imprimían con `console.log`, así que quien leyera los
 * logs del servidor podía entrar en cualquier cuenta. Sin un proveedor real
 * configurado, el código se deja aquí en vez de en la consola:
 *
 * - En pruebas, la suite lo lee igual que un usuario lee su WhatsApp.
 * - En desarrollo, `npm run dev:otp -- --to=<celular|correo>` lo muestra a
 *   quien tiene acceso a la base de desarrollo.
 *
 * `config/env.ts` impide arrancar producción con el proveedor de buzón, y el
 * TTL borra cada entrada a los diez minutos.
 */
export interface IOtpOutbox extends Document {
  channel: 'whatsapp' | 'email';
  destination: string;
  code: string;
  createdAt: Date;
}

const otpOutboxSchema = new Schema<IOtpOutbox>(
  {
    channel: { type: String, enum: ['whatsapp', 'email'], required: true },
    destination: { type: String, required: true, index: true },
    code: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

otpOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 10 * 60 });

export const OtpOutbox = mongoose.model<IOtpOutbox>('OtpOutbox', otpOutboxSchema);
