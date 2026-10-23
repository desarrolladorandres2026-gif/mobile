/**
 * Coalesce llamadas concurrentes en una sola.
 *
 * Nace del refresco de sesión: el access token dura 15 minutos, cualquier
 * pantalla puede disparar varias peticiones a la vez, y el backend rota el
 * refresh token en cada uso tratando reusar uno viejo como robo de sesión.
 * Sin esto, dos 401 casi simultáneos dispararían dos `POST /refresh-token`
 * con el mismo token todavía vigente: el primero lo consume con éxito, el
 * segundo lo encuentra ya invalidado y el backend interpreta eso como
 * reuse — sesión cerrada de golpe sin que el usuario haya hecho nada.
 *
 * Vive aparte de `services/api.ts` porque es un patrón genérico —cualquier
 * operación cara y no idempotente que varias partes de la app puedan pedir
 * a la vez— y porque así se puede probar sin arrastrar axios ni el store de
 * sesión.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (!inFlight) {
      // Se limpia al asentarse, con éxito o con error: una vez resuelta la
      // llamada en curso, la siguiente petición merece un intento nuevo y
      // no el resultado (o el fallo) de una que ya terminó.
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
