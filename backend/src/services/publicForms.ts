import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { normalizePhone } from '../utils/phone';

/**
 * Piezas comunes de los formularios públicos (contacto, aliados, eliminación
 * de cuenta): texto limpio, HMAC de la IP y el esquema de campos libres.
 */

/** Texto plano: sin etiquetas HTML, sin caracteres de control y con espacios colapsados. Los saltos de línea se conservan. */
export function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Un campo de texto libre: recortado, limpio de HTML y con límites de longitud (medidos después de limpiar). */
export const text = (min: number, max: number, message?: string) =>
  z
    .string({ required_error: message ?? 'Campo requerido', invalid_type_error: 'Debe ser texto' })
    .transform(cleanText)
    .pipe(z.string().min(min, message ?? `Mínimo ${min} caracteres`).max(max, `Máximo ${max} caracteres`));

/** Opcional: ausente o vacío queda `undefined`. */
export const optionalText = (max: number) =>
  z
    .string({ invalid_type_error: 'Debe ser texto' })
    .max(max * 2, `Máximo ${max} caracteres`)
    .optional()
    .transform((v) => (v === undefined ? undefined : cleanText(v) || undefined))
    .pipe(z.string().max(max, `Máximo ${max} caracteres`).optional());

/** Honeypot: un humano nunca lo ve; cualquier valor lo delata. Se acepta cualquier tipo para que un bot no lo evite con un número. */
export const honeypot = z.unknown().optional();
export const honeypotTripped = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== '';

const EMAIL = z.string().email();

/** Celular colombiano (10 dígitos canónicos) o correo en minúsculas. */
export function normalizeContact(input: string): string | null {
  const value = input.trim();
  if (value.includes('@')) {
    const email = value.toLowerCase();
    return email.length <= 120 && EMAIL.safeParse(email).success ? email : null;
  }
  const phone = normalizePhone(value);
  return phone && phone.startsWith('3') ? phone : null;
}

/** Celular móvil colombiano (empieza por 3), forma canónica de 10 dígitos. */
export const mobilePhone = z.preprocess(
  (v) => normalizePhone(v) ?? v,
  z.string({ required_error: 'El número de celular es requerido' }).regex(/^3\d{9}$/, 'Número de celular inválido')
);

/** HMAC de la IP: sirve para agrupar abuso sin conservar la IP. */
export function hashIp(ip: string | undefined): string {
  return crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`zipp:public-form-ip:v1:${ip ?? 'unknown'}`)
    .digest('hex');
}
