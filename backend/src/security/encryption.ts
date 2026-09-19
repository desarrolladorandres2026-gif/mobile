import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';

// ── Formato v2 (el que se escribe hoy) ───────────────────────────────
//
//   v2:salt:iv:authTag:encryptedData   (base64, salt de 16 y IV de 12 bytes)
//
// La clave de cada registro sale de HKDF sobre una raíz que se deriva UNA
// vez por proceso. El formato anterior corría PBKDF2 de 100 000 vueltas en
// cada cifrado y en cada lectura, de forma síncrona: 134 ms con el hilo
// principal bloqueado — ninguna otra petición ni socket se atendía — y la
// app pide los códigos del pedido cada pocos segundos.
//
// La raíz pasa por scrypt, no por HKDF directo, porque `ENCRYPTION_KEY` solo
// se valida por longitud: si alguien puso una frase en vez de bytes
// aleatorios, scrypt conserva la resistencia a fuerza bruta que daba PBKDF2.
// Se paga una vez al arrancar, no por registro.
const V2_PREFIX = 'v2';
const V2_SALT_LENGTH = 16;
const V2_IV_LENGTH = 12;
const V2_HKDF_INFO = 'zipp:enc:v2:aes-256-gcm';

let v2Root: Buffer | null = null;
function rootKey(): Buffer {
  if (!v2Root) {
    v2Root = crypto.scryptSync(config.security.encryptionKey, 'zipp:enc:v2:root', 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
  }
  return v2Root;
}

function deriveV2Key(salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', rootKey(), salt, V2_HKDF_INFO, 32));
}

// ── Formato anterior (solo lectura) ──────────────────────────────────
//
//   salt:iv:authTag:encryptedData   (base64, salt de 32 y IV de 16 bytes)
//
// Sigue habiendo datos así (códigos de pedidos en curso, secretos TOTP), y
// se siguen leyendo. Cada registro tiene su propio salt, así que su clave
// derivada se recuerda: el mismo código leído cada 20 s cuesta PBKDF2 solo
// la primera vez.
const LEGACY_KEY_CACHE_MAX = 1000;
const legacyKeys = new Map<string, Buffer>();

function deriveLegacyKey(saltB64: string): Buffer {
  const cached = legacyKeys.get(saltB64);
  if (cached) return cached;

  const key = crypto.pbkdf2Sync(
    config.security.encryptionKey,
    Buffer.from(saltB64, 'base64'),
    100000,
    32,
    'sha512'
  );
  legacyKeys.set(saltB64, key);
  if (legacyKeys.size > LEGACY_KEY_CACHE_MAX) {
    const oldest = legacyKeys.keys().next().value;
    if (oldest !== undefined) legacyKeys.delete(oldest);
  }
  return key;
}

/**
 * Encrypts sensitive data using AES-256-GCM (formato v2).
 * Format: v2:salt:iv:authTag:encryptedData (all base64)
 */
export function encrypt(plainText: string): string {
  if (!plainText) return plainText;

  const salt = crypto.randomBytes(V2_SALT_LENGTH);
  const key = deriveV2Key(salt);
  const iv = crypto.randomBytes(V2_IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return [
    V2_PREFIX,
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/**
 * Decrypts data encrypted with AES-256-GCM, en formato v2 o anterior.
 *
 * Si no puede descifrar devuelve la entrada tal cual: hay datos que nunca
 * se cifraron y quien llama cuenta con ese comportamiento.
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;

  try {
    const parts = encryptedText.split(':');

    let key: Buffer;
    let ivB64: string;
    let authTagB64: string;
    let data: string;

    // Un salt legado en base64 mide 44 caracteres: nunca es "v2".
    if (parts.length === 5 && parts[0] === V2_PREFIX) {
      const [, saltB64, iv, tag, ct] = parts;
      key = deriveV2Key(Buffer.from(saltB64, 'base64'));
      [ivB64, authTagB64, data] = [iv, tag, ct];
    } else if (parts.length === 4) {
      const [saltB64, iv, tag, ct] = parts;
      key = deriveLegacyKey(saltB64);
      [ivB64, authTagB64, data] = [iv, tag, ct];
    } else {
      return encryptedText;
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch {
    return encryptedText; // Return as-is if decryption fails (data may not be encrypted)
  }
}

/**
 * Hash a value for searchable encrypted fields (deterministic)
 */
export function hashForSearch(value: string): string {
  return crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(value.toLowerCase().trim())
    .digest('hex');
}

/**
 * Generate a secure random token
 */
export function generateSecureToken(length: number = 64): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash a token for storage (so raw tokens are never stored)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
