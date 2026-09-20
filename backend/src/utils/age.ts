/**
 * Edad cumplida, contada en el día de Colombia.
 *
 * Decide si alguien puede pedir productos +18, así que no puede depender de
 * la zona del servidor: a las 8 p. m. del 8 de marzo en Bogotá ya es 9 de
 * marzo en UTC, y quien cumple el 9 todavía no tiene un año más.
 *
 * La fecha de nacimiento se guarda a medianoche UTC del día (ver
 * `parseBirthDate`), así que su día es el de sus componentes UTC.
 */

export const BIRTHDATE_MIN_AGE = 14;
export const ADULT_AGE = 18;
const MAX_AGE = 120;
const TIMEZONE = 'America/Bogota';

/** Año, mes (1-12) y día de `now` en Bogotá. */
function todayInBogota(now: Date): [number, number, number] {
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE }).split('-').map(Number);
  return [y, m, d];
}

/**
 * Años cumplidos por quien nació en `birthDate` al instante `now`.
 *
 * Quien nació un 29 de febrero cumple, en años no bisiestos, el 1 de marzo:
 * comparar (mes, día) contra (2, 29) lo da solo, porque el 28 de febrero
 * todavía es "antes" y el 1 de marzo ya es "después".
 */
export function ageOn(birthDate: Date, now: Date = new Date()): number {
  const by = birthDate.getUTCFullYear();
  const bm = birthDate.getUTCMonth() + 1;
  const bd = birthDate.getUTCDate();
  const [ty, tm, td] = todayInBogota(now);

  const hadBirthday = tm > bm || (tm === bm && td >= bd);
  return ty - by - (hadBirthday ? 0 : 1);
}

/**
 * `AAAA-MM-DD` → medianoche UTC de ese día, o `null` si la fecha no existe
 * (31 de febrero, mes 13) o no tiene esa forma. `Date.UTC` normaliza las
 * fechas imposibles, así que se comprueba que los tres números vuelvan
 * intactos.
 */
export function parseBirthDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Motivo por el que una fecha de nacimiento no se acepta, o `null`. */
export function birthDateProblem(date: Date, now: Date = new Date()): string | null {
  const age = ageOn(date, now);
  if (age < 0 || date.getTime() > now.getTime()) return 'La fecha de nacimiento no puede ser futura';
  if (age < BIRTHDATE_MIN_AGE) return `Para usar Zipp necesitas tener al menos ${BIRTHDATE_MIN_AGE} años`;
  if (age > MAX_AGE) return 'Revisa el año de nacimiento';
  return null;
}
