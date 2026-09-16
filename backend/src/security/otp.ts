import crypto from 'crypto';
import type { Model } from 'mongoose';
import { config } from '../config';

/**
 * Códigos de un solo uso (WhatsApp y correo), en un solo sitio.
 *
 * Antes cada flujo —registro, login por OTP, OTP de correo, recuperación de
 * contraseña— repetía su propia versión: el código se guardaba en claro, se
 * comparaba con `!==` y no había contador de intentos, así que un OTP de seis
 * dígitos solo lo protegía un límite por IP que además se podía falsificar.
 *
 * Aquí:
 * - Se guarda el HMAC-SHA256 del código con una clave del servidor. Con la
 *   base filtrada no se puede usar ni recuperar por fuerza bruta offline
 *   (un SHA-256 simple de seis dígitos se invierte en milisegundos).
 * - Cada intento se reserva con un `$inc` atómico condicionado a no haber
 *   llegado al tope, así que ni una ráfaga concurrente pasa de
 *   `OTP_MAX_ATTEMPTS` comparaciones por código.
 * - Al quinto fallo el código se invalida y hay que pedir otro.
 * - La comparación es en tiempo constante.
 */

export const OTP_MAX_ATTEMPTS = 5;

/** Nombres de los tres campos que sostienen un OTP dentro de un documento. */
export interface OtpSlot {
  hash: string;
  expires: string;
  attempts: string;
}

export const OTP_SLOTS = {
  /** `User`: login por WhatsApp y recuperación de contraseña. */
  phone: { hash: 'otpCode', expires: 'otpExpires', attempts: 'otpAttempts' },
  /** `User`: login por correo. */
  email: { hash: 'emailOtpCode', expires: 'emailOtpExpires', attempts: 'emailOtpAttempts' },
  /** `User`: confirmación de un celular nuevo antes de asociarlo. */
  pendingPhone: { hash: 'pendingPhoneOtpCode', expires: 'pendingPhoneOtpExpires', attempts: 'pendingPhoneOtpAttempts' },
  /** `PendingRegistration`: registro en tres pasos. */
  registration: { hash: 'otpCode', expires: 'otpExpires', attempts: 'otpAttempts' },
} satisfies Record<string, OtpSlot>;

export type OtpCheck = 'ok' | 'missing' | 'expired' | 'invalid' | 'locked';

/** Seis dígitos de un generador criptográfico. */
export function generateOtpCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * HMAC del código. La clave se deriva de `ENCRYPTION_KEY` con una etiqueta
 * propia para que este uso no comparta material con el cifrado de campos.
 */
export function hashOtp(code: string): string {
  return crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`zipp:otp:v1:${code}`)
    .digest('hex');
}

/** Comparación en tiempo constante de un código contra su HMAC guardado. */
export function otpMatches(code: string, storedHash: string | null | undefined): boolean {
  if (typeof code !== 'string' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashOtp(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function otpExpiryDate(): Date {
  return new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);
}

/** El `$set` que deja un código nuevo vivo en un documento, con el contador a cero. */
export function otpSetFields(slot: OtpSlot, code: string): Record<string, unknown> {
  return {
    [slot.hash]: hashOtp(code),
    [slot.expires]: otpExpiryDate(),
    [slot.attempts]: 0,
  };
}

export function otpUnsetFields(slot: OtpSlot): Record<string, 1> {
  return { [slot.hash]: 1, [slot.expires]: 1, [slot.attempts]: 1 };
}

/**
 * Cuándo se emitió el código vigente, derivado de su vencimiento. Sirve para
 * el enfriamiento entre reenvíos sin guardar un campo más.
 */
export function otpIssuedAt(expires: Date | null | undefined): Date | null {
  if (!expires) return null;
  return new Date(expires.getTime() - config.otp.expiryMinutes * 60 * 1000);
}

interface ConsumeOptions {
  /**
   * `false` valida sin gastar el código (se devuelve el intento). Lo usa la
   * recuperación de contraseña cuando la cuenta tiene 2FA y todavía falta
   * el TOTP: el código correcto no debe quemarse por eso.
   */
  consume?: boolean;
}

/**
 * Valida un código contra el documento que casa con `filter`.
 *
 * Nunca lanza por un código malo: devuelve el motivo y el llamador decide
 * el mensaje. Así el mismo resultado se traduce igual en los cuatro flujos.
 */
export async function checkOtp(
  // Cualquier modelo que tenga el slot; se consulta por nombre de campo.
  model: Model<any>,
  filter: Record<string, unknown>,
  slot: OtpSlot,
  code: string,
  options: ConsumeOptions = {}
): Promise<OtpCheck> {
  const consume = options.consume !== false;
  const projection = `+${slot.hash} +${slot.expires} +${slot.attempts}`;

  // Reserva un intento de forma atómica. Si no casa es que no hay código o
  // que ya se agotaron los intentos: se averigua cuál sin gastar nada.
  const doc = await model
    .findOneAndUpdate(
      {
        ...filter,
        [slot.hash]: { $exists: true, $type: 'string' },
        $or: [{ [slot.attempts]: { $exists: false } }, { [slot.attempts]: { $lt: OTP_MAX_ATTEMPTS } }],
      },
      { $inc: { [slot.attempts]: 1 } },
      { new: true }
    )
    .select(projection);

  if (!doc) {
    const current = await model.findOne(filter).select(projection);
    if (!current || typeof current.get(slot.hash) !== 'string') return 'missing';
    await model.updateOne({ _id: current._id }, { $unset: otpUnsetFields(slot) });
    return 'locked';
  }

  const storedHash = doc.get(slot.hash) as string;
  const expires = doc.get(slot.expires) as Date | undefined;
  const attempts = (doc.get(slot.attempts) as number | undefined) ?? OTP_MAX_ATTEMPTS;

  if (!expires || expires.getTime() < Date.now()) {
    await model.updateOne({ _id: doc._id, [slot.hash]: storedHash }, { $unset: otpUnsetFields(slot) });
    return 'expired';
  }

  if (!otpMatches(code, storedHash)) {
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await model.updateOne({ _id: doc._id, [slot.hash]: storedHash }, { $unset: otpUnsetFields(slot) });
      return 'locked';
    }
    return 'invalid';
  }

  if (!consume) {
    await model.updateOne({ _id: doc._id, [slot.hash]: storedHash }, { $inc: { [slot.attempts]: -1 } });
    return 'ok';
  }

  // Un solo uso: solo gana quien borra el hash que acaba de comparar. Dos
  // peticiones simultáneas con el código correcto no abren dos sesiones.
  const burned = await model.updateOne(
    { _id: doc._id, [slot.hash]: storedHash },
    { $unset: otpUnsetFields(slot) }
  );
  return burned.modifiedCount === 1 ? 'ok' : 'invalid';
}
