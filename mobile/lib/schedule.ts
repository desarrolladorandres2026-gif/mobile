import { isOpenAt, type DaySchedule } from './business';

/**
 * Antelación de la primera franja.
 *
 * El servidor exige media hora (`MIN_SCHEDULE_LEAD_MS`), pero la franja se
 * elige antes de confirmar, y el rato que el cliente pasa en el checkout se
 * come ese margen. Con una hora, la primera franja no se convierte en un
 * rechazo por haber tardado en elegir el método de pago.
 */
export const SCHEDULE_LEAD_MINUTES = 60;

/** El servidor no acepta más de una semana (`MAX_SCHEDULE_AHEAD_MS`). */
export const SCHEDULE_DAYS = 7;

export const SLOT_MINUTES = 30;

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

export interface ScheduleDay {
  key: string;
  label: string;
  slots: Date[];
}

/**
 * Los días y las franjas que se pueden programar.
 *
 * Solo franjas en las que el negocio atiende: ofrecer el domingo a las 8 de
 * la mañana a un local que abre a las 11 es ofrecer un botón que el negocio
 * no va a poder cumplir. Un día sin ninguna franja no aparece.
 */
export function scheduleDays(
  schedule: Record<string, DaySchedule> | undefined,
  now: Date = new Date()
): ScheduleDay[] {
  const earliest = now.getTime() + SCHEDULE_LEAD_MINUTES * 60_000;
  const latest = now.getTime() + SCHEDULE_DAYS * 24 * 60 * 60_000;
  const days: ScheduleDay[] = [];

  for (let offset = 0; offset < SCHEDULE_DAYS; offset++) {
    const slots: Date[] = [];

    for (let minute = 0; minute < 24 * 60; minute += SLOT_MINUTES) {
      // Constructor local y no suma de milisegundos: así la franja cae en
      // la hora de reloj que se lee, pase lo que pase con el horario de
      // verano del teléfono.
      const slot = new Date(
        now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, minute
      );
      if (slot.getTime() < earliest || slot.getTime() > latest) continue;
      if (!isOpenAt(schedule, slot)) continue;
      slots.push(slot);
    }

    if (slots.length === 0) continue;

    const day = slots[0];
    days.push({
      key: `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
      label: offset === 0 ? 'Hoy' : offset === 1 ? 'Mañana' : `${WEEKDAYS[day.getDay()]} ${day.getDate()}`,
      slots,
    });
  }

  return days;
}

/** 19:30 → "7:30 p. m." */
export function slotLabel(when: Date): string {
  const hours = when.getHours();
  const suffix = hours < 12 ? 'a. m.' : 'p. m.';
  return `${hours % 12 || 12}:${String(when.getMinutes()).padStart(2, '0')} ${suffix}`;
}
