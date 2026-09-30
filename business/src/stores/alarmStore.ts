import { create } from 'zustand';
import { pruneSnoozes, SNOOZE_MS } from '../lib/orderAlarm';

/**
 * "Silenciar 1 min": qué pedidos callaron y hasta cuándo.
 *
 * Se guarda por pedido y no como un interruptor global: un pedido que llega
 * después de pulsar el botón no está en el mapa y suena de inmediato. Vive
 * en `localStorage` y se sincroniza entre pestañas para que callar en una
 * también calle a las otras del mismo equipo.
 */

const KEY = 'business_alarm_snoozes';

function read(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? pruneSnoozes(parsed as Record<string, number>, Date.now()) : {};
  } catch {
    return {};
  }
}

interface AlarmState {
  snoozes: Record<string, number>;
  snooze: (orderIds: string[], ms?: number) => void;
}

export const useAlarmStore = create<AlarmState>((set, get) => ({
  snoozes: read(),

  snooze: (orderIds, ms = SNOOZE_MS) => {
    const now = Date.now();
    const next = pruneSnoozes({ ...get().snoozes }, now);
    for (const id of orderIds) next[id] = now + ms;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Sin almacenamiento el silencio dura lo que esta pestaña.
    }
    set({ snoozes: next });
  },
}));

window.addEventListener('storage', (event) => {
  if (event.key === KEY) useAlarmStore.setState({ snoozes: read() });
});
