/**
 * Periodos de reporte en hora de Colombia (America/Bogota, UTC-5 fijo).
 *
 * El servidor no tiene por qué correr en hora colombiana (en producción
 * probablemente corre en UTC), así que `setHours(0,0,0,0)` sobre la hora
 * local del proceso corta el "día" a las 19:00 de Bogotá. Todo límite de
 * "hoy", "semana", "mes" o "el día del resumen" pasa por aquí.
 *
 * Reutiliza el manejo de zona de `businessDays.ts`: Bogotá no tiene horario
 * de verano, así que la conversión es un desplazamiento fijo de 5 horas.
 */

import { bogotaStartOfDay, bogotaEndOfDay, toBogotaYMD } from './businessDays';

export type ReportPeriod = 'today' | 'week' | 'month';

export const REPORT_PERIODS: readonly ReportPeriod[] = ['today', 'week', 'month'];

/** Rango cerrado [from, to] en instantes UTC. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** Días calendario (incluido hoy) que abarca cada periodo. */
const PERIOD_DAYS: Record<Exclude<ReportPeriod, 'today'>, number> = {
  week: 7,
  month: 30,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return typeof value === 'string' && (REPORT_PERIODS as readonly string[]).includes(value);
}

/** El día calendario de Bogotá de un instante, como `YYYY-MM-DD`. */
export function bogotaDateString(date: Date = new Date()): string {
  const { y, m, d } = toBogotaYMD(date);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Suma (o resta) días calendario a un `YYYY-MM-DD`. Aritmética pura de calendario. */
export function shiftDateString(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + deltaDays));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Los instantes UTC en que empieza y termina un día calendario de Bogotá. */
export function bogotaDayRange(dateStr: string): DateRange {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    from: bogotaStartOfDay(y, m ?? 1, d ?? 1),
    to: bogotaEndOfDay(y, m ?? 1, d ?? 1),
  };
}

/**
 * Rango de un periodo relativo a `now`, en días de Bogotá.
 *
 * - `today`: el día calendario actual, 00:00:00.000 a 23:59:59.999.
 * - `week`: los últimos 7 días calendario, incluido hoy.
 * - `month`: los últimos 30 días calendario, incluido hoy.
 *
 * Son ventanas móviles y no "semana ISO" ni "mes calendario" a propósito:
 * es lo que el selector Hoy/Semana/Mes ya prometía (`now - 7 días`,
 * `now - 1 mes`), solo que ahora con el corte de día en hora colombiana.
 */
export function periodRange(period: ReportPeriod, now: Date = new Date()): DateRange {
  const today = bogotaDateString(now);
  if (period === 'today') return bogotaDayRange(today);

  const first = shiftDateString(today, -(PERIOD_DAYS[period] - 1));
  return { from: bogotaDayRange(first).from, to: bogotaDayRange(today).to };
}

/**
 * Rango explícito `from`–`to` (`YYYY-MM-DD`, inclusive, hora de Bogotá).
 * Devuelve `null` si alguna fecha no es válida o el rango está invertido.
 */
export function customRange(fromStr: string, toStr: string): DateRange | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(fromStr) || !re.test(toStr)) return null;
  const from = bogotaDayRange(fromStr);
  const to = bogotaDayRange(toStr);
  if (
    Number.isNaN(from.from.getTime()) ||
    Number.isNaN(to.to.getTime()) ||
    // Fechas imposibles como 2026-02-31 se desbordan al mes siguiente.
    shiftDateString(fromStr, 0) !== fromStr ||
    shiftDateString(toStr, 0) !== toStr ||
    from.from.getTime() > to.to.getTime()
  ) {
    return null;
  }
  return { from: from.from, to: to.to };
}
