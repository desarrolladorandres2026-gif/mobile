import { palette } from '../theme/tokens';

/**
 * Colores de identidad para los negocios.
 *
 * Pocos comercios tienen una foto decente cargada, y una app llena
 * de placeholders grises se ve rota. En vez de eso, cada negocio recibe
 * siempre el mismo color, derivado de su id: Burger House es el rojo, Café
 * Aroma es el ámbar. Con dos o tres pedidos ya los reconoces por el color
 * antes de leer el nombre.
 */
const ACCENTS = [
  palette.zipp500,
  '#FF4D5E',
  '#FF8A3D',
  '#12B886',
  '#9B5DE5',
  '#0FA3C4',
] as const;

/**
 * El color de fondo de la ficha de un negocio: el suyo propio si lo eligió,
 * o el derivado de su id si no.
 *
 * `brandColor` gana siempre que esté puesto. Es el mismo color que ya
 * escogió en Ajustes para el encabezado de su ficha — mostrar uno distinto
 * aquí sería que el negocio se vea de un color en su portada y de otro en
 * la tarjeta del Inicio, que es justo la inconsistencia que este color
 * existe para evitar.
 */
export function businessAccent(id: string | undefined, brandColor?: string | null): string {
  if (brandColor) return brandColor;
  if (!id) return ACCENTS[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return ACCENTS[hash % ACCENTS.length];
}

// ──────────────────────────────────────────────────────────────
// Horarios
// ──────────────────────────────────────────────────────────────

export interface DaySchedule {
  open?: string;
  close?: string;
  isOpen?: boolean;
}

export const DAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export interface OpenState {
  open: boolean;
  /** Texto listo para mostrar: "Abierto hasta las 10:00 p. m." o "Abre a las 8:00 a. m." */
  label: string;
}

/**
 * Si el negocio está atendiendo ahora mismo.
 *
 * El backend ya guarda el horario por día; la app hasta ahora lo ignoraba y
 * dejaba pedir a locales cerrados, que es la forma más rápida de perder la
 * confianza de un cliente nuevo.
 */
export function openState(schedule: Record<string, DaySchedule> | undefined): OpenState {
  if (!schedule) return { open: true, label: '' };

  const now = new Date();
  const today = schedule[DAY_KEYS[now.getDay()]];

  if (!today || today.isOpen === false) {
    return { open: false, label: 'Cerrado hoy' };
  }

  const openAt = toMinutes(today.open);
  const closeAt = toMinutes(today.close);
  if (openAt === null || closeAt === null) return { open: true, label: '' };

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (nowMinutes < openAt) {
    return { open: false, label: `Abre a las ${prettyTime(today.open!)}` };
  }
  // Un cierre menor que la apertura significa que el local cruza medianoche.
  const closesNextDay = closeAt <= openAt;
  if (!closesNextDay && nowMinutes >= closeAt) {
    return { open: false, label: `Cerrado · abre a las ${prettyTime(today.open!)}` };
  }

  const minutesLeft = (closesNextDay ? closeAt + 1440 : closeAt) - nowMinutes;
  if (minutesLeft <= 45) {
    return { open: true, label: `Cierra en ${minutesLeft} min` };
  }
  return { open: true, label: `Abierto hasta las ${prettyTime(today.close!)}` };
}

/**
 * Si el negocio atiende en un momento dado, no solo ahora.
 *
 * Mira dos ventanas: la del propio día y la cola de la del día anterior
 * cuando esa cruza medianoche. `openState` solo mira la de hoy, así que a la
 * una de la mañana da por cerrado un bar que abrió a las seis de la tarde
 * del día anterior y cierra a las dos. Para programar un pedido para el
 * sábado a la 1 a. m. hace falta la cuenta completa.
 *
 * El backend repite exactamente esta regla al crear el pedido; si una cambia,
 * la otra también.
 */
export function isOpenAt(schedule: Record<string, DaySchedule> | undefined, when: Date): boolean {
  if (!schedule) return true;

  const minutes = when.getHours() * 60 + when.getMinutes();
  const today = schedule[DAY_KEYS[when.getDay()]];
  const yesterday = schedule[DAY_KEYS[(when.getDay() + 6) % 7]];

  const window = (day: DaySchedule | undefined) => {
    if (!day || day.isOpen === false) return null;
    const open = toMinutes(day.open);
    const close = toMinutes(day.close);
    // Sin horas escritas se trata como abierto todo el día, igual que
    // `openState`: es mejor dejar pedir que bloquear a un negocio que
    // simplemente no llenó el formulario.
    if (open === null || close === null) return { open: 0, close: 1440, crosses: false };
    return { open, close, crosses: close <= open };
  };

  const t = window(today);
  if (t && (t.crosses ? minutes >= t.open : minutes >= t.open && minutes < t.close)) return true;

  const y = window(yesterday);
  return !!y && y.crosses && minutes < y.close;
}

/** "22:00" → "10:00 p. m." */
function prettyTime(hhmm: string): string {
  const [rawH, m] = hhmm.split(':');
  let h = Number(rawH);
  const suffix = h < 12 ? 'a. m.' : 'p. m.';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${suffix}`;
}
