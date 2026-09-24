/**
 * Dígito de verificación (DV) del NIT colombiano, según el algoritmo de la
 * DIAN (módulo 11).
 *
 * Cada dígito del NIT, contado desde la derecha, se multiplica por un peso
 * primo fijo; la suma módulo 11 da el residuo `r`, y el DV es `r` si `r` es
 * 0 o 1, y `11 - r` en cualquier otro caso.
 *
 * Se calcula en el servidor y no se confía en el que mande el cliente: un DV
 * mal escrito es el error más común al digitar un NIT y termina como una
 * factura electrónica rechazada meses después.
 */
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/** Deja solo los dígitos: quita puntos, guiones y espacios de "900.123.456-8". */
export function digitsOnly(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * El DV que le corresponde a un NIT (sin DV), o `null` si no es calculable
 * (vacío, con letras o más largo que la tabla de pesos).
 */
export function computeNitDv(nit: string): string | null {
  const clean = String(nit ?? '').trim();
  if (!/^\d{1,15}$/.test(clean)) return null;

  let sum = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const digit = Number(clean[clean.length - 1 - i]);
    sum += digit * NIT_WEIGHTS[i];
  }

  const remainder = sum % 11;
  return String(remainder > 1 ? 11 - remainder : remainder);
}

/** `true` si el DV dado corresponde al NIT. */
export function isValidNitDv(nit: string, dv: string | number): boolean {
  const expected = computeNitDv(nit);
  return expected !== null && expected === String(dv).trim();
}

/** `4567` para "1234567". Vacío si no hay suficientes dígitos. */
export function lastDigits(value: string, count = 4): string {
  const digits = digitsOnly(value);
  return digits.length >= count ? digits.slice(-count) : digits;
}

/** `••••4567` — lo que se muestra de una cuenta a quien no es finanzas. */
export function maskAccount(last4: string | null | undefined): string {
  return last4 ? `••••${last4}` : '';
}
