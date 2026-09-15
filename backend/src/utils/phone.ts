import { z } from 'zod';

/**
 * Un celular colombiano, siempre escrito de una sola manera.
 *
 * Antes cada entrada validaba con `^(\+57)?[0-9]{10}$` y guardaba lo que
 * llegara, así que `+573101234567` y `3101234567` eran dos documentos
 * distintos para el índice único de `User.phone`: dos cuentas para el mismo
 * número, y un OTP pedido por una llegando al dueño de la otra.
 *
 * La forma canónica son los 10 dígitos nacionales, sin indicativo. Es la que
 * ya usan la app, los paneles, el seed y el TESTE, así que ningún dato bien
 * formado cambia al normalizarlo.
 */
export const PHONE_DIGITS = 10;

const COUNTRY_CODE = '57';

/**
 * Devuelve los 10 dígitos canónicos o `null` si no es un celular válido.
 *
 * Acepta separadores humanos (espacios, guiones, puntos, paréntesis) y el
 * indicativo con o sin `+`. No adivina: una cadena con letras u otro
 * indicativo no se "arregla", se rechaza.
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === PHONE_DIGITS + COUNTRY_CODE.length && digits.startsWith(COUNTRY_CODE)) {
    digits = digits.slice(COUNTRY_CODE.length);
  }

  return digits.length === PHONE_DIGITS ? digits : null;
}

/** Para Mongoose: normaliza al escribir y deja pasar lo que no se entiende, para que `match` lo rechace con su mensaje. */
export function phoneSetter(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  return normalizePhone(value) ?? value;
}

export const PHONE_ERROR = 'Número de celular inválido';

/** Esquema Zod único para cualquier celular que entre por la API. */
export const phoneSchema = z.preprocess(
  (value) => normalizePhone(value) ?? value,
  z.string({ required_error: 'El número de celular es requerido' }).regex(/^\d{10}$/, PHONE_ERROR)
);
