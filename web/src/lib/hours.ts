import type { WeekSchedule } from './api';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const TIME_ZONE = 'America/Bogota';

const toMinutes = (hhmm: string | undefined) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
};

function localClock(when: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday')),
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

type Day = WeekSchedule['monday'] | undefined;

function window(d: Day) {
  if (!d || d.isOpen === false) return null;
  const open = toMinutes(d.open);
  const close = toMinutes(d.close);
  if (open === null || close === null) return { open: 0, close: 1440, crosses: false };
  return { open, close, crosses: close <= open };
}

/**
 * Copia de `isOpenAt` del backend (`backend/src/utils/businessHours.ts`) y del
 * móvil: mira la ventana del día y la cola de la del día anterior si cruza
 * medianoche. Sin horario cargado cuenta como abierto, igual que allá.
 */
export function isOpenNow(schedule: WeekSchedule | undefined | null, when = new Date()): boolean {
  if (!schedule) return true;
  const { day, minutes } = localClock(when);
  const t = window(schedule[DAY_KEYS[day]]);
  if (t && (t.crosses ? minutes >= t.open : minutes >= t.open && minutes < t.close)) return true;
  const y = window(schedule[DAY_KEYS[(day + 6) % 7]]);
  return !!y && y.crosses && minutes < y.close;
}

const to12h = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'p. m.' : 'a. m.';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
};

/** "Hoy 8:00 a. m. a 10:00 p. m." o "Hoy cerrado". */
export function todayHoursText(schedule: WeekSchedule | undefined | null, when = new Date()): string | null {
  if (!schedule) return null;
  const d = schedule[DAY_KEYS[localClock(when).day]];
  if (!d || d.isOpen === false) return 'Hoy cerrado';
  return `Hoy ${to12h(d.open)} a ${to12h(d.close)}`;
}
