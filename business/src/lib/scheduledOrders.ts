/**
 * Cuánto falta para un pedido programado, dicho como lo diría una persona en
 * la cocina («en 2 h 15 min», «en 12 min», «ya toca»), y qué tan cerca está.
 */

export type ScheduledTone = 'danger' | 'warning' | 'info' | 'muted';

/** Menos de una hora es «ya casi»; el resto del día es «hoy»; más allá, «después». */
export function scheduledTone(msUntil: number): ScheduledTone {
  if (msUntil <= 0) return 'danger';
  if (msUntil <= 60 * 60_000) return 'warning';
  if (msUntil <= 24 * 60 * 60_000) return 'info';
  return 'muted';
}

export function untilLabel(msUntil: number): string {
  if (msUntil <= 0) return 'Ya toca';
  const minutes = Math.round(msUntil / 60_000);
  if (minutes < 1) return 'En menos de 1 min';
  if (minutes < 60) return `En ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `En ${hours} h ${rest} min` : `En ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'En 1 día' : `En ${days} días`;
}
