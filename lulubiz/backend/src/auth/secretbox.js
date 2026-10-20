import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de secretos que hay que poder recuperar (el secreto TOTP): AES-256-GCM con IV aleatorio.
 * Formato `v1.iv.etiqueta.cifrado` en base64. El prefijo de versión permite rotar la clave después.
 */
export function parseKey(base64) {
  const key = Buffer.from(String(base64 ?? ''), 'base64');
  if (key.length !== 32) throw new Error('la clave de cifrado debe ser de 32 bytes en base64');
  return key;
}

export function seal(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

export function open(sealed, key) {
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('secreto cifrado con formato desconocido');
  const [, iv, tag, encrypted] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}
