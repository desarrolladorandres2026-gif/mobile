import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { config } from '../config';
import { encrypt, decrypt } from './encryption';

const APP_NAME = 'ZIPP';

/** Duración de un paso TOTP en segundos (RFC 6238). */
export const TOTP_STEP_SECONDS = 30;

/**
 * Generate TOTP secret and QR code for 2FA setup
 */
export async function generateTOTPSecret(
  userIdentifier: string
): Promise<{
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}> {
  const secret = speakeasy.generateSecret({
    name: `${APP_NAME} (${userIdentifier})`,
    issuer: APP_NAME,
    length: 32,
  });

  const otpauthUrl = secret.otpauth_url || '';
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  // Generate 10 recovery codes
  const recoveryCodes = generateRecoveryCodes(10);

  return {
    secret: secret.base32,
    otpauthUrl,
    qrCodeDataUrl,
    recoveryCodes,
  };
}

/**
 * El secreto TOTP se guarda cifrado (AES-256-GCM, `security/encryption.ts`).
 *
 * En claro, una copia de la base bastaba para generar los códigos de
 * cualquier cuenta con 2FA. `decrypt` devuelve intacto un valor que no está
 * cifrado, así que los secretos anteriores a este cambio siguen funcionando
 * hasta que la migración 004 los cifre.
 */
export function sealTotpSecret(secret: string): string {
  return encrypt(secret);
}

export function openTotpSecret(stored: string): string {
  return decrypt(stored);
}

/**
 * Paso TOTP que casa con el código, o `null`.
 *
 * Devuelve el paso y no un booleano para que quien llama pueda rechazar un
 * código ya usado: sin eso, el mismo código servía durante los ~90 s de la
 * ventana, y quien lo viera por encima del hombro entraba también.
 */
export function matchTOTPStep(storedSecret: string, token: string): number | null {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return null;
  const result = speakeasy.totp.verifyDelta({
    secret: openTotpSecret(storedSecret),
    encoding: 'base32',
    token,
    window: 1, // Un paso a cada lado: 30 s de tolerancia de reloj.
  });
  if (!result) return null;
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + result.delta;
}

/**
 * Verify a TOTP token (sin protección de repetición — solo para confirmar el
 * alta de 2FA, donde todavía no hay un paso previo que comparar).
 */
export function verifyTOTP(storedSecret: string, token: string): boolean {
  return matchTOTPStep(storedSecret, token) !== null;
}

/**
 * Códigos de recuperación de un solo uso.
 *
 * Antes eran 4 bytes (32 bits) con SHA-256 sin sal: con la base en la mano
 * se recorrían los 4.300 millones de posibilidades en minutos. Ahora son 10
 * bytes (80 bits) y se guarda un HMAC con clave del servidor.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I

function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(10);
    let raw = '';
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    // Formato: XXXXX-XXXXX
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

const canonicalRecovery = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

function hmacRecovery(code: string): string {
  return crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`zipp:recovery:v2:${canonicalRecovery(code)}`)
    .digest('hex');
}

/** Formato anterior (SHA-256 sin clave), aceptado solo para verificar códigos ya emitidos. */
function legacyRecoveryHash(code: string): string {
  return crypto.createHash('sha256').update(code.replace('-', '').toUpperCase()).digest('hex');
}

/**
 * Hash recovery codes for storage
 */
export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hmacRecovery);
}

/**
 * Verify a recovery code
 */
export function verifyRecoveryCode(
  code: string,
  hashedCodes: string[]
): { valid: boolean; index: number } {
  if (typeof code !== 'string' || !code.trim()) return { valid: false, index: -1 };
  const candidates = [hmacRecovery(code), legacyRecoveryHash(code)].map((h) => Buffer.from(h, 'hex'));

  for (let index = 0; index < hashedCodes.length; index++) {
    const stored = Buffer.from(hashedCodes[index] || '', 'hex');
    for (const candidate of candidates) {
      if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) {
        return { valid: true, index };
      }
    }
  }
  return { valid: false, index: -1 };
}
