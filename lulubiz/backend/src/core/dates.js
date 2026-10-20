/**
 * Fechas de calendario (sin hora). Se guardan a mediodía UTC: así una fecha no cambia de día
 * con la zona horaria de quien la lee ni la del servidor.
 */
export const DAY_MS = 86_400_000;

/** `AAAA-MM-DD` → `Date` al mediodía UTC. `fail(mensaje)` debe lanzar el error propio del módulo. */
export function parseDay(value, label, fail) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) fail(`${label} debe tener el formato AAAA-MM-DD`);
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} no es una fecha válida`);
  return date;
}

export const dayOf = (date) => date.toISOString().slice(0, 10);

export const startOfDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
