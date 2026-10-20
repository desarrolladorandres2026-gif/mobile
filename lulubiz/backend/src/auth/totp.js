import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Contraseña de un solo uso basada en tiempo (TOTP, RFC 6238) sobre HOTP (RFC 4226), con SHA-1,
 * 6 dígitos y paso de 30 segundos: lo que entienden Google Authenticator, Authy, 1Password, etc.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('secreto base32 inválido');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Secreto aleatorio de 160 bits en base32, el tamaño recomendado por el RFC. */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

function hotp(secretBuffer, counter, digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', secretBuffer).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const TOTP_PERIOD_SECONDS = 30;

export function totpAt(secret, timeMs, { period = TOTP_PERIOD_SECONDS, digits = 6 } = {}) {
  return hotp(base32Decode(secret), Math.floor(timeMs / 1000 / period), digits);
}

/**
 * Comprueba un código con tolerancia de `window` pasos hacia cada lado (relojes desfasados).
 * `lastStep` evita reutilizar un código: solo se acepta un paso posterior al último aceptado.
 * Devuelve el paso aceptado o `null`.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = -1, period = TOTP_PERIOD_SECONDS, digits = 6 } = {}) {
  if (typeof code !== 'string' || !/^[0-9]+$/.test(code) || code.length !== digits) return null;
  const secretBuffer = base32Decode(secret);
  const current = Math.floor(now / 1000 / period);
  const given = Buffer.from(code);
  let accepted = null;
  // Recorre todas las posiciones sin cortar al acertar: el tiempo no revela cuál coincidió.
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    const expected = Buffer.from(hotp(secretBuffer, step, digits));
    if (timingSafeEqual(expected, given) && step > lastStep && accepted === null) accepted = step;
  }
  return accepted;
}

/** URI para generar el código QR de alta: `otpauth://totp/Emisor:cuenta?secret=...`. */
export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
