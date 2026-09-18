import type { WeekSchedule } from '../types';

const DAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

type Partial7 = Partial<Record<(typeof DAY_KEYS)[number], Partial<WeekSchedule['monday']>>>;

function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Día de la semana y minuto del día en la zona horaria del negocio.
 *
 * El servidor puede correr en UTC y los horarios están escritos en la hora
 * de Colombia: con `getHours()` a secas, un local que abre a las 8 de la
 * mañana aparecería abierto a las 3 de la madrugada.
 */
function localClock(when: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(when);

  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));

  return { day, minutes: Number(value('hour')) * 60 + Number(value('minute')) };
}

/**
 * Si el negocio atiende en un momento dado.
 *
 * Copia de `isOpenAt` del móvil (`mobile/lib/business.ts`), que es la que
 * decide qué franjas se ofrecen: si difieren, la app ofrece horas que el
 * servidor rechaza. Mira la ventana del propio día y la cola de la del día
 * anterior cuando cruza medianoche — un bar de 6 p. m. a 2 a. m. está
 * abierto a la 1 a. m. del día siguiente.
 *
 * No reutiliza `businessService.isCurrentlyOpen`: esa usa la zona horaria
 * del servidor, no contempla el cruce de medianoche y solo responde "ahora".
 */
export function isOpenAt(
  schedule: Partial7 | undefined | null,
  when: Date,
  timeZone: string
): boolean {
  if (!schedule) return true;

  const { day, minutes } = localClock(when, timeZone);
  const today = schedule[DAY_KEYS[day]];
  const yesterday = schedule[DAY_KEYS[(day + 6) % 7]];

  const window = (d: Partial<WeekSchedule['monday']> | undefined) => {
    if (!d || d.isOpen === false) return null;
    const open = toMinutes(d.open);
    const close = toMinutes(d.close);
    if (open === null || close === null) return { open: 0, close: 1440, crosses: false };
    return { open, close, crosses: close <= open };
  };

  const t = window(today);
  if (t && (t.crosses ? minutes >= t.open : minutes >= t.open && minutes < t.close)) return true;

  const y = window(yesterday);
  return !!y && y.crosses && minutes < y.close;
}
