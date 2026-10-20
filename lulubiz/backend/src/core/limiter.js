/**
 * Limita cuántas operaciones simultáneas hay por clave (por empresa, aquí). Las que sobran esperan en
 * una cola acotada. Sirve para que muchos escritores de una misma empresa no se pisen: cada
 * contabilización toca los mismos documentos (consecutivo, compuerta de período, saldos), y sin límite
 * los choques y reintentos en cadena hacen que el rendimiento baje al subir la concurrencia.
 */
export class BusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusyError';
  }
}

export function createKeyedLimiter({ maxConcurrent = 2, maxQueue = 500, queueTimeoutMs = 10_000 } = {}) {
  const states = new Map();

  function release(key, state) {
    state.active -= 1;
    const next = state.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      state.active += 1;
      next.resolve();
    } else if (state.active === 0) {
      states.delete(key);
    }
  }

  return {
    async run(key, fn) {
      const id = String(key);
      let state = states.get(id);
      if (!state) {
        state = { active: 0, queue: [] };
        states.set(id, state);
      }
      if (state.active >= maxConcurrent) {
        if (state.queue.length >= maxQueue) throw new BusyError('demasiadas operaciones en espera para esta empresa');
        await new Promise((resolve, reject) => {
          const entry = { resolve };
          entry.timer = setTimeout(() => {
            const index = state.queue.indexOf(entry);
            if (index !== -1) state.queue.splice(index, 1);
            reject(new BusyError('la operación esperó demasiado turno: inténtalo de nuevo'));
          }, queueTimeoutMs);
          state.queue.push(entry);
        });
      } else {
        state.active += 1;
      }
      try {
        return await fn();
      } finally {
        release(id, state);
      }
    },

    /** Para pruebas y métricas: operaciones activas y en espera de una clave. */
    stats(key) {
      const state = states.get(String(key));
      return { active: state?.active ?? 0, queued: state?.queue.length ?? 0 };
    },
  };
}
