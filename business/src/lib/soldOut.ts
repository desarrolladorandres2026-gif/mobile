/** Minutos que faltan para la medianoche de hoy, entre 5 y 1440. */
export function minutesUntilMidnight(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.min(1440, Math.max(5, Math.ceil((midnight.getTime() - now.getTime()) / 60_000)));
}
