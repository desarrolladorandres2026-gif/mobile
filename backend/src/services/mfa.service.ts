import crypto from 'crypto';
import { Types } from 'mongoose';
import { User, IUser } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { config } from '../config';
import { matchTOTPStep, verifyRecoveryCode } from '../security';

/**
 * Segundo factor, en un solo sitio.
 *
 * Antes solo `login` con contraseña miraba `twoFactorEnabled`: Google, Apple,
 * el OTP de WhatsApp, el OTP de correo y la recuperación de contraseña
 * emitían una sesión completa aunque la cuenta tuviera 2FA. Un SIM swap
 * bastaba para entrar a la cuenta de un administrador.
 *
 * Ahora cualquier camino que supere el primer factor en una cuenta con 2FA
 * recibe un reto (`challengeToken`) en lugar de tokens, y la sesión solo se
 * emite en `POST /auth/2fa/challenge` al presentar un TOTP o un código de
 * recuperación válido. Ver `AuthService.completeLogin`.
 *
 * El reto es opaco (no es un JWT, así que no puede confundirse con un access
 * token), de un solo uso, vive cinco minutos y admite cinco intentos,
 * reservados con un `$inc` atómico igual que los OTP.
 */

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;

export type FirstFactor = 'password' | 'google' | 'apple' | 'otp' | 'email_otp' | 'password_reset';

export const hasTwoFactor = (user: Pick<IUser, 'twoFactorEnabled' | 'twoFactorSecret'>): boolean =>
  !!user.twoFactorEnabled;

function hmac(value: string): string {
  return crypto.createHmac('sha256', config.security.encryptionKey).update(`zipp:mfa:v1:${value}`).digest('hex');
}

function sameHex(a: string, b: string | undefined | null): boolean {
  if (!b) return false;
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Abre (o reemplaza) el reto pendiente de un usuario y devuelve el token para el cliente. */
export async function openMfaChallenge(userId: Types.ObjectId | string, method: FirstFactor): Promise<string> {
  const secret = crypto.randomBytes(32).toString('base64url');
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        mfaChallengeHash: hmac(secret),
        mfaChallengeExpires: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
        mfaChallengeAttempts: 0,
        mfaChallengeMethod: method,
      },
    }
  );
  return `${userId.toString()}.${secret}`;
}

const clearChallenge = { mfaChallengeHash: 1, mfaChallengeExpires: 1, mfaChallengeAttempts: 1, mfaChallengeMethod: 1 } as const;

/**
 * Verifica un segundo factor contra la cuenta: TOTP (sin repetición) o
 * código de recuperación (se consume). No abre ni cierra retos.
 */
export async function verifySecondFactor(userId: Types.ObjectId | string, code: string): Promise<boolean> {
  if (typeof code !== 'string' || !code.trim()) return false;

  const user = await User.findById(userId).select('+twoFactorSecret +twoFactorLastStep +recoveryCodes twoFactorEnabled');
  if (!user?.twoFactorEnabled || !user.twoFactorSecret) return false;

  const step = matchTOTPStep(user.twoFactorSecret, code.trim());
  if (step !== null) {
    // Solo gana quien avanza el último paso: el mismo código, o uno anterior,
    // ya no sirve aunque siga dentro de la ventana de tolerancia.
    const advanced = await User.updateOne(
      {
        _id: user._id,
        $or: [{ twoFactorLastStep: { $exists: false } }, { twoFactorLastStep: null }, { twoFactorLastStep: { $lt: step } }],
      },
      { $set: { twoFactorLastStep: step } }
    );
    return advanced.modifiedCount === 1;
  }

  const recovery = verifyRecoveryCode(code, user.recoveryCodes ?? []);
  if (recovery.valid) {
    const stored = (user.recoveryCodes ?? [])[recovery.index];
    // `$pull` condicionado al valor: dos usos simultáneos del mismo código
    // no pueden tener éxito los dos.
    const pulled = await User.updateOne({ _id: user._id, recoveryCodes: stored }, { $pull: { recoveryCodes: stored } });
    return pulled.modifiedCount === 1;
  }

  return false;
}

/**
 * Resuelve un reto: valida el token opaco, gasta un intento, verifica el
 * segundo factor y, si todo cuadra, cierra el reto y devuelve el usuario.
 * Lanza `AppError` con un mensaje apto para el cliente en cualquier otro caso.
 */
export async function resolveMfaChallenge(challengeToken: string, code: string): Promise<{ user: IUser; method: FirstFactor }> {
  const invalid = new AppError('El reto de verificación no es válido o venció. Inicia sesión de nuevo.', 401, 'MFA_CHALLENGE_INVALID');

  const [userId, secret] = typeof challengeToken === 'string' ? challengeToken.split('.') : [];
  if (!userId || !secret || !Types.ObjectId.isValid(userId)) throw invalid;

  // Reserva un intento de forma atómica, solo si el reto sigue vivo.
  const reserved = await User.findOneAndUpdate(
    {
      _id: userId,
      mfaChallengeHash: { $type: 'string' },
      mfaChallengeExpires: { $gt: new Date() },
      $or: [{ mfaChallengeAttempts: { $exists: false } }, { mfaChallengeAttempts: { $lt: MFA_MAX_ATTEMPTS } }],
    },
    { $inc: { mfaChallengeAttempts: 1 } },
    { new: true }
  ).select('+mfaChallengeHash +mfaChallengeMethod +mfaChallengeAttempts');

  if (!reserved || !sameHex(hmac(secret), reserved.mfaChallengeHash)) {
    if (reserved && (reserved.mfaChallengeAttempts ?? 0) >= MFA_MAX_ATTEMPTS) {
      await User.updateOne({ _id: userId }, { $unset: clearChallenge });
    }
    throw invalid;
  }

  const ok = await verifySecondFactor(reserved._id, code);
  if (!ok) {
    if ((reserved.mfaChallengeAttempts ?? 0) >= MFA_MAX_ATTEMPTS) {
      await User.updateOne({ _id: userId }, { $unset: clearChallenge });
      throw new AppError('Demasiados códigos incorrectos. Inicia sesión de nuevo.', 429, 'MFA_LOCKED');
    }
    throw new AppError('Código de verificación inválido', 401, 'MFA_CODE_INVALID');
  }

  // Un solo uso: solo cierra el reto quien todavía lo encuentra abierto.
  const closed = await User.updateOne(
    { _id: userId, mfaChallengeHash: reserved.mfaChallengeHash },
    { $unset: clearChallenge }
  );
  if (closed.modifiedCount !== 1) throw invalid;

  const user = await User.findById(userId);
  if (!user) throw invalid;
  return { user, method: (reserved.mfaChallengeMethod as FirstFactor) || 'password' };
}
