/**
 * Fecha de nacimiento: se escribe en tres casillas (día, mes, año) y viaja
 * como `AAAA-MM-DD`.
 *
 * Nunca se pasa por `new Date(iso)` para mostrarla: el backend la guarda a
 * medianoche UTC, que en Colombia (UTC-5) es las 7 p. m. del día anterior,
 * y la fecha saldría corrida un día. Todo aquí trabaja con el texto.
 */

export const MIN_AGE = 14;
export const ADULT_AGE = 18;

/** `AAAA-MM-DD` si los tres campos forman una fecha real; si no, el motivo. */
export function composeBirthDate(
  day: string,
  month: string,
  year: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);

  if (!day || !month || !year) return { ok: false, error: 'Completa día, mes y año' };
  if (year.length !== 4) return { ok: false, error: 'El año va con cuatro cifras' };
  if (m < 1 || m > 12) return { ok: false, error: 'El mes va de 1 a 12' };

  // Date.UTC normaliza (31 de febrero → 3 de marzo): si al volver no
  // coinciden los tres números, la fecha no existe.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return { ok: false, error: 'Esa fecha no existe' };
  }

  const value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, value };
}

/** `2001-03-09` (o un ISO completo) → `09/03/2001`. */
export function formatBirthDate(iso: string | undefined | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : '';
}

/**
 * Años cumplidos por alguien nacido en `birthDate` (`AAAA-MM-DD` o ISO
 * completo) en el instante `now`, contados en la hora de Colombia.
 *
 * TODO(usuario): implementar. Devuelve `null` si `birthDate` no se puede leer.
 *
 * Lo que hay que decidir:
 * - "Hoy" es el día en Bogotá, no en UTC: a las 8 p. m. del 8 de marzo en
 *   Colombia ya es 9 de marzo en UTC, y quien cumple el 9 no debería tener
 *   un año más todavía. `now.toLocaleDateString('en-CA', { timeZone:
 *   'America/Bogota' })` da `AAAA-MM-DD` del día local.
 * - Quien nació un 29 de febrero: en un año no bisiesto, ¿cumple el 28 de
 *   febrero o el 1 de marzo? (En Colombia la costumbre es el 1 de marzo.)
 * - Solo se comparan año, mes y día; nada de restar milisegundos, que
 *   falla por los años bisiestos.
 *
 * Mientras devuelva `null`, la app no bloquea nada por su cuenta: el
 * servidor sigue siendo quien decide (mínimo 14 años al guardar, 18 para
 * productos +18).
 */
export function ageInBogota(birthDate: string, now: Date = new Date()): number | null {
  void birthDate;
  void now;
  return null;
}
