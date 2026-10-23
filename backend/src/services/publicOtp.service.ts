import type { Request } from 'express';
import { config } from '../config';
import { PublicOtp, PublicOtpPurpose } from '../models/PublicOtp';
import { AppError } from '../middlewares/errorHandler';
import {
  OTP_SLOTS, checkOtp, generateOtpCode, otpIssuedAt, otpSetFields,
  checkBruteForce, recordFailedAttempt, clearAttempts,
} from '../security';
import { clientIp } from '../utils/helpers';

/**
 * OTP de WhatsApp para formularios públicos (sin sesión ni cuenta previa).
 *
 * Reutiliza `security/otp.ts` (HMAC, intentos atómicos, un solo uso) y el
 * freno de fuerza bruta de `security/bruteforce.ts`; el código vive en
 * `PublicOtp` y no en `User`, porque el celular puede no tener cuenta.
 */

const OTP_REJECTED = 'Código inválido o vencido. Pide uno nuevo.';

const otpRejected = () => new AppError(OTP_REJECTED, 400, 'OTP_INVALID');

/** Deja un código nuevo vivo para ese celular. `null` si aún corre el enfriamiento del anterior. */
async function issue(purpose: PublicOtpPurpose, phone: string): Promise<string | null> {
  const current = await PublicOtp.findOne({ purpose, phone }).select('+otpExpires');
  const issued = otpIssuedAt(current?.otpExpires);
  if (issued && Date.now() - issued.getTime() < config.otp.resendCooldownSeconds * 1000) return null;

  const code = generateOtpCode();
  await PublicOtp.findOneAndUpdate(
    { purpose, phone },
    { $set: otpSetFields(OTP_SLOTS.registration, code) },
    { upsert: true }
  );
  return code;
}

/** Valida y consume el código. Cualquier fallo responde igual (400 `OTP_INVALID`). */
async function verify(purpose: PublicOtpPurpose, phone: string, code: string, req: Request): Promise<void> {
  const ip = clientIp(req);
  const identifier = `${purpose}:${phone}`;
  const brute = await checkBruteForce(ip, identifier);
  if (!brute.allowed) throw new AppError(brute.reason || 'Demasiados intentos. Intenta más tarde.', 429);

  const result = await checkOtp(PublicOtp, { purpose, phone }, OTP_SLOTS.registration, code);
  if (result !== 'ok') {
    await recordFailedAttempt(ip, identifier);
    throw otpRejected();
  }
  await clearAttempts(ip, identifier);
}

export const publicOtpService = { issue, verify };
