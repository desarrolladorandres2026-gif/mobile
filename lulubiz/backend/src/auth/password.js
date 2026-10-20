import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** scrypt con N=2^16 (64 MiB), r=8, p=2: dentro de lo recomendado por OWASP con menos pico de memoria. */
export const DEFAULT_PASSWORD_PARAMS = { N: 2 ** 16, r: 8, p: 2 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export class PasswordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PasswordError';
  }
}

export function validatePasswordStrength(password) {
  if (typeof password !== 'string') throw new PasswordError('la contraseña es obligatoria');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`la contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordError(`la contraseña admite como máximo ${MAX_PASSWORD_LENGTH} caracteres`);
  }
  if (new Set(password).size < 5) throw new PasswordError('la contraseña es demasiado repetitiva');
}

function derive(password, salt, { N, r, p }) {
  return scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r });
}

/** Formato: `scrypt$N$r$p$sal$hash` en base64. Los parámetros viajan con el hash para poder subirlos después. */
export async function hashPassword(password, params = DEFAULT_PASSWORD_PARAMS) {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Object.values(params).every(Number.isSafeInteger)) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
