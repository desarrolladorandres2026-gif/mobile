import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Derives a key from the master encryption key using PBKDF2
 */
function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    config.security.encryptionKey,
    salt,
    100000,
    32,
    'sha512'
  );
}

/**
 * Encrypts sensitive data using AES-256-GCM
 * Format: salt:iv:authTag:encryptedData (all base64)
 */
export function encrypt(plainText: string): string {
  if (!plainText) return plainText;

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':');
}

/**
 * Decrypts data encrypted with AES-256-GCM
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;

  try {
    const [saltB64, ivB64, authTagB64, data] = encryptedText.split(':');

    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const key = deriveKey(salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

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
