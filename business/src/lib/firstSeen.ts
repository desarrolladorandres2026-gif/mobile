import type { BusinessOrder } from './orderFlow';
import { isActionable } from './orderAlarm';

/**
 * Cuándo vio este panel por primera vez un pedido en línea ya pagado.
 *
 * Un pedido en línea puede crearse minutos antes de que se pague (PSE,
 * Nequi y Bancolombia son asíncronos). Para la cocina empieza a esperar
 * cuando el pago entra, no cuando se creó; medir desde `createdAt` haría
 * escalar el timbre al instante. Se guarda en `sessionStorage` para que una
 * recarga no reinicie el reloj. Solo importa para pedidos en línea.
 */

const KEY = 'business_alarm_first_seen';
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (!cache) {
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
      cache = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
    } catch {
      cache = {};
    }
  }
  return cache;
}

function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    // Sin almacenamiento el reloj dura lo que la pestaña.
  }
}

/**
 * Anota los pedidos en línea aceptables que aún no se habían visto.
 * Con `prune`, `orders` es la lista completa y se olvidan los que ya no están.
 */
export function rememberFirstSeen(orders: readonly BusinessOrder[], options: { prune?: boolean; now?: number } = {}) {
  const map = load();
  const now = options.now ?? Date.now();
  let changed = false;

  for (const order of orders) {
    if (order.paymentMethod === 'online' && isActionable(order) && map[order._id] === undefined) {
      map[order._id] = now;
      changed = true;
    }
  }

  if (options.prune) {
    const present = new Set(orders.map((order) => order._id));
    for (const id of Object.keys(map)) {
      if (!present.has(id)) {
        delete map[id];
        changed = true;
      }
    }
  }
  if (changed) persist();
}

export function getFirstSeen(): Readonly<Record<string, number>> {
  return load();
}
