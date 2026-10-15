import type { Schedule, DaySchedule } from '../pages/profile/InfoTab';

/**
 * Atajos para el horario del negocio y la lista de lo que le falta a su ficha.
 *
 * El horario no es decorativo: el servidor decide con él si la tienda está
 * abierta. Por eso los atajos solo reescriben `isOpen`, `open` y `close` —la
 * misma forma que ya guardaba el formulario— y no inventan nada nuevo.
 */

export const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const DEFAULT_OPEN = '08:00';
export const DEFAULT_CLOSE = '20:00';

export const SCHEDULE_PRESETS = [
  { id: 'weekdays', label: 'Lunes a viernes', open: DAY_KEYS.slice(0, 5) },
  { id: 'monsat', label: 'Lunes a sábado', open: DAY_KEYS.slice(0, 6) },
  { id: 'all', label: 'Todos los días', open: DAY_KEYS },
] as const;

type PresetId = (typeof SCHEDULE_PRESETS)[number]['id'];

/** Las horas que ya usa el negocio (las del primer día abierto) o las de siempre. */
export function referenceHours(schedule: Schedule): { open: string; close: string } {
  const first = DAY_KEYS.map((k) => schedule[k]).find((d) => d?.isOpen);
  return { open: first?.open ?? DEFAULT_OPEN, close: first?.close ?? DEFAULT_CLOSE };
}

/**
 * Abre solo los días del atajo y cierra los demás. Un día que ya estaba abierto
 * conserva sus horas; uno que se abre ahora estrena las del negocio.
 */
export function applyPreset(schedule: Schedule, id: PresetId): Schedule {
  const preset = SCHEDULE_PRESETS.find((p) => p.id === id)!;
  const reference = referenceHours(schedule);
  const next: Schedule = { ...schedule };
  for (const key of DAY_KEYS) {
    const open = (preset.open as readonly string[]).includes(key);
    next[key] = open
      ? { ...schedule[key], isOpen: true, open: schedule[key]?.open ?? reference.open, close: schedule[key]?.close ?? reference.close }
      : { ...schedule[key], isOpen: false };
  }
  return next;
}

/** Las horas del primer día abierto, copiadas a todos los demás días abiertos. */
export function copyHoursToOpenDays(schedule: Schedule): Schedule {
  const { open, close } = referenceHours(schedule);
  const next: Schedule = { ...schedule };
  for (const key of DAY_KEYS) {
    if (schedule[key]?.isOpen) next[key] = { ...schedule[key], open, close };
  }
  return next;
}

/** Un día cuyo cierre no es posterior a su apertura: el horario no puede cruzar la medianoche. */
export function dayProblem(day: DaySchedule | undefined): string {
  if (!day?.isOpen) return '';
  const open = day.open ?? DEFAULT_OPEN;
  const close = day.close ?? DEFAULT_CLOSE;
  return close <= open ? 'Cierra antes de abrir.' : '';
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

/** Lo que una tienda necesita para que la encuentren, la elijan y se pueda recoger su pedido. */
export function profileChecklist(input: {
  description: string;
  phone: string;
  address: string;
  hasLocation: boolean;
  schedule: Schedule;
  hasLogo: boolean;
  hasCover: boolean;
}): ChecklistItem[] {
  return [
    { id: 'logo', label: 'Logo', done: input.hasLogo },
    { id: 'cover', label: 'Portada', done: input.hasCover },
    { id: 'description', label: 'Descripción', done: input.description.trim().length > 0 },
    { id: 'phone', label: 'Teléfono', done: input.phone.trim().length > 0 },
    { id: 'address', label: 'Dirección', done: input.address.trim().length > 0 },
    { id: 'location', label: 'Punto de recogida', done: input.hasLocation },
    { id: 'schedule', label: 'Horario', done: DAY_KEYS.some((k) => input.schedule[k]?.isOpen) },
  ];
}
