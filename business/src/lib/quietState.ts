/**
 * El último "momento tranquilo" conocido (`isQuietMoment`), compartido
 * entre quien lo calcula (`OrderNotifications`, que tiene la cola de
 * pedidos) y quien lo necesita (`checkForUpdates.ts`, para recargar sola la
 * app de escritorio sin esperar un clic). Solo hay un productor y un
 * consumidor montados una vez en todo el panel, así que un módulo con
 * estado mutable basta — no hace falta Zustand para esto.
 */
let quiet = true;
const listeners = new Set<() => void>();

export function setQuiet(next: boolean): void {
  if (next === quiet) return;
  quiet = next;
  listeners.forEach((fn) => fn());
}

export function isQuietNow(): boolean {
  return quiet;
}

/** Devuelve la función para dejar de escuchar. */
export function onQuietChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
