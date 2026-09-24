/**
 * Días hábiles en Colombia (América/Bogotá).
 *
 * Excluye sábados, domingos y los festivos nacionales de la Ley 51 de 1983
 * (Ley Emiliani): los festivos fijos que se trasladan al lunes siguiente
 * cuando no caen en lunes, más los que dependen de la Pascua (Jueves y
 * Viernes Santo, que no se trasladan, y Ascensión, Corpus Christi y Sagrado
 * Corazón, que sí).
 *
 * Bogotá vive en UTC-5 todo el año (no tiene horario de verano), así que la
 * conversión es un desplazamiento fijo de 5 horas y no hace falta ninguna
 * librería de zonas horarias.
 */

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

interface YMD { y: number; m: number; d: number; }

/** Parte una fecha UTC en año/mes/día tal como se ven en Bogotá. */
function toBogotaYMD(date: Date): YMD {
  const shifted = new Date(date.getTime() - BOGOTA_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/** El instante UTC de un año/mes/día en Bogotá a las 23:59:59.999. */
function bogotaEndOfDay(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) + BOGOTA_OFFSET_MS);
}

/** El instante UTC de un año/mes/día en Bogotá a las 00:00:00.000. */
function bogotaStartOfDay(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + BOGOTA_OFFSET_MS);
}

function addCalendarDays({ y, m, d }: YMD, days: number): YMD {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function weekday({ y, m, d }: YMD): number {
  // 0 = domingo … 6 = sábado. El día calendario es el mismo en cualquier
  // zona horaria, así que Date.UTC basta para esto.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Traslada al lunes siguiente si no cae en lunes (Ley Emiliani). */
function moveToMonday(ymd: YMD): YMD {
  const dow = weekday(ymd);
  if (dow === 1) return ymd;
  const toAdd = dow === 0 ? 1 : 8 - dow; // domingo→+1, martes(2)→+6 … sábado(6)→+2
  return addCalendarDays(ymd, toAdd);
}

/**
 * Domingo de Pascua (calendario gregoriano) por el algoritmo de
 * Meeus/Jones/Butcher.
 */
function easterSunday(year: number): YMD {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
}

/** Los festivos nacionales de un año, como claves `"y-m-d"`. */
export function nationalHolidays(year: number): Set<string> {
  const key = ({ y, m, d }: YMD) => `${y}-${m}-${d}`;
  const set = new Set<string>();

  // Fijos que NUNCA se trasladan (Ley 51 de 1983, art. 1).
  const fixed: Array<[number, number]> = [
    [1, 1], // Año Nuevo
    [5, 1], // Día del Trabajo
    [7, 20], // Independencia
    [8, 7], // Batalla de Boyacá
    [12, 8], // Inmaculada Concepción
    [12, 25], // Navidad
  ];
  for (const [m, d] of fixed) set.add(key({ y: year, m, d }));

  // Fijos que se trasladan al lunes siguiente (Ley Emiliani).
  const movable: Array<[number, number]> = [
    [1, 6], // Reyes Magos
    [3, 19], // San José
    [6, 29], // San Pedro y San Pablo
    [8, 15], // Asunción de la Virgen
    [10, 12], // Día de la Raza
    [11, 1], // Todos los Santos
    [11, 11], // Independencia de Cartagena
  ];
  for (const [m, d] of movable) set.add(key(moveToMonday({ y: year, m, d })));

  // Dependientes de la Pascua.
  const easter = easterSunday(year);
  const fromEaster = (offset: number) => addCalendarDays(easter, offset);

  set.add(key(fromEaster(-3))); // Jueves Santo (no se traslada)
  set.add(key(fromEaster(-2))); // Viernes Santo (no se traslada)
  set.add(key(moveToMonday(fromEaster(40)))); // Ascensión del Señor
  set.add(key(moveToMonday(fromEaster(60)))); // Corpus Christi
  set.add(key(moveToMonday(fromEaster(68)))); // Sagrado Corazón

  return set;
}

const holidayCache = new Map<number, Set<string>>();
function holidaysFor(year: number): Set<string> {
  let set = holidayCache.get(year);
  if (!set) {
    set = nationalHolidays(year);
    holidayCache.set(year, set);
  }
  return set;
}

function isBusinessDay(ymd: YMD): boolean {
  const dow = weekday(ymd);
  if (dow === 0 || dow === 6) return false;
  return !holidaysFor(ymd.y).has(`${ymd.y}-${ymd.m}-${ymd.d}`);
}

/**
 * Suma días hábiles a partir de `from` (excluyendo el propio `from`) y
 * devuelve el final del último día hábil (23:59:59.999 hora Bogotá).
 *
 * El conteo empieza al día calendario siguiente: el día de creación no
 * cuenta como el primero del plazo.
 */
export function addBusinessDays(from: Date, days: number): Date {
  let ymd = toBogotaYMD(from);
  let remaining = days;

  while (remaining > 0) {
    ymd = addCalendarDays(ymd, 1);
    if (isBusinessDay(ymd)) remaining--;
  }

  return bogotaEndOfDay(ymd.y, ymd.m, ymd.d);
}

/** Cuántos días hábiles completos quedan entre `now` y `deadline` (puede ser negativo si ya venció). */
export function businessDaysUntil(deadline: Date, now: Date = new Date()): number {
  if (deadline.getTime() <= now.getTime()) {
    // Vencido: cuenta hábiles transcurridos desde el plazo, en negativo.
    let ymd = toBogotaYMD(deadline);
    const nowYmd = toBogotaYMD(now);
    let count = 0;
    while (ymd.y !== nowYmd.y || ymd.m !== nowYmd.m || ymd.d !== nowYmd.d) {
      ymd = addCalendarDays(ymd, 1);
      if (isBusinessDay(ymd)) count++;
      if (count > 3650) break; // guarda contra bucles infinitos por datos corruptos
    }
    return -count;
  }

  let ymd = toBogotaYMD(now);
  const deadlineYmd = toBogotaYMD(deadline);
  let count = 0;
  while (ymd.y !== deadlineYmd.y || ymd.m !== deadlineYmd.m || ymd.d !== deadlineYmd.d) {
    ymd = addCalendarDays(ymd, 1);
    if (isBusinessDay(ymd)) count++;
    if (count > 3650) break;
  }
  return count;
}

export { bogotaStartOfDay, bogotaEndOfDay, toBogotaYMD };
