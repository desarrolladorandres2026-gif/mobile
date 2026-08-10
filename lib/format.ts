/**
 * Formato de cifras en español colombiano.
 *
 * Se agrupa a mano en vez de usar `toLocaleString`: el soporte de Intl varía
 * entre Hermes y JSC, y un precio que se ve distinto según el motor es un
 * precio en el que el cliente deja de confiar.
 */

/** 18400 → "18.400" */
export function groupThousands(value: number): string {
  const n = Math.round(Math.abs(value));
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits[i];
  }
  return (value < 0 ? '-' : '') + out;
}

/** 18400 → "$18.400". Los pesos no llevan decimales. */
export function money(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '$0';
  return `$${groupThousands(value)}`;
}

/** 12 → "12 min" */
export function minutes(value: number | undefined | null): string {
  if (!value && value !== 0) return '—';
  return `${Math.round(value)} min`;
}

/** 1.4 → "1,4 km". Coma decimal, como se escribe en Colombia. */
export function km(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (value < 1) return `${Math.round(value * 1000)} m`;
  return `${value.toFixed(1).replace('.', ',')} km`;
}

/**
 * Código corto del pedido, el que uno le dicta al domiciliario por teléfono.
 * Salen del final del id de Mongo, que es la parte que varía.
 */
export function orderCode(id: string | undefined): string {
  if (!id) return '------';
  return id.slice(-6).toUpperCase();
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function clockTime(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h < 12 ? 'a. m.' : 'p. m.';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${suffix}`;
}

/** "Hoy, 3:40 p. m." · "Ayer, 8:12 p. m." · "14 mar, 1:05 p. m." */
export function orderDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (sameDay(d, now)) return `Hoy, ${clockTime(d)}`;
  if (sameDay(d, yesterday)) return `Ayer, ${clockTime(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clockTime(d)}`;
}

/** Hora estimada de llegada a partir de los minutos que faltan. */
export function etaClock(minutesAway: number): string {
  const d = new Date(Date.now() + minutesAway * 60_000);
  return clockTime(d);
}

/** "Buenos días" · "Buenas tardes" · "Buenas noches" */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Primer nombre. "María Fernanda Ríos" → "María" */
export function firstName(full: string | undefined): string {
  if (!full) return '';
  return full.trim().split(/\s+/)[0];
}

/** Iniciales para el avatar. "María Ríos" → "MR" */
export function initials(full: string | undefined): string {
  if (!full) return 'Z';
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Z';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
