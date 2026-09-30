import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { getDeviceId } from './deviceId';
import { createRefresher, decodeJwtPayload, needsRefresh, SessionEndedError } from './sessionCore';

export { SessionEndedError };

/**
 * La sesión del panel, renovada de forma que ninguna pestaña la rompa.
 *
 * Por qué existe: el access token dura 15 minutos y el backend rota el
 * refresh token en cada uso. Cada pestaña guardaba el suyo en memoria y lo
 * presentaba tal cual; la segunda pestaña en renovar presentaba uno que la
 * primera ya había rotado. Dentro de 15 s el servidor lo toma por carrera
 * (409), pasado ese margen lo toma por robo y **cierra todas las sesiones**.
 * Un panel de cocina abierto todo el día en dos pantallas lo disparaba solo.
 *
 * Reglas que esto impone:
 *  1. Una sola renovación a la vez por navegador (Web Locks; sin ellas, por
 *     pestaña).
 *  2. Dentro del candado se relee `localStorage`: si otra pestaña ya rotó el
 *     token, se adopta sin volver a llamar al servidor.
 *  3. Un 409 "se está renovando" es esperar y releer, nunca cerrar sesión.
 *  4. Un corte de red o un 5xx tampoco cierran sesión: solo un rechazo
 *     definitivo del servidor lo hace.
 */

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const LOCK_NAME = 'zipp-business-auth-refresh';

// ── Instancia real ───────────────────────────────────────────────────

/** Cuánto adelanta el reloj del servidor al de este equipo (ms). */
let skewMs = 0;

/** Candado entre pestañas; sin Web Locks (http en LAN), solo dentro de esta. */
let tabQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, { signal: AbortSignal.timeout(20_000) }, fn);
  }
  const run = tabQueue.then(fn, fn);
  tabQueue = run.catch(() => undefined);
  return run;
}

export const ensureFreshToken = createRefresher({
  readTokens: () => ({
    access: localStorage.getItem('business_token'),
    refresh: localStorage.getItem('business_refresh_token'),
  }),
  adopt: (access, refresh) => useAuthStore.getState().adoptTokens(access, refresh),
  save: (access, refresh) => {
    const iat = decodeJwtPayload(access)?.iat;
    if (typeof iat === 'number') skewMs = iat * 1000 - Date.now();
    useAuthStore.getState().setTokens(access, refresh);
  },
  post: async (refreshToken) => {
    const { data } = await axios.post(
      `${API_BASE}/auth/refresh-token`,
      { refreshToken },
      { headers: { 'X-Device-ID': getDeviceId() }, timeout: 15_000 }
    );
    return data.data as { accessToken: string; refreshToken: string };
  },
  withLock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Hora del servidor, no la de este equipo: un reloj mal puesto no debe
  // disparar renovaciones de más.
  now: () => Date.now() + skewMs,
});

/** Cierra la sesión en esta pestaña y lleva al inicio de sesión. */
export function endSession() {
  useAuthStore.getState().logout();
  window.location.href = '/login';
}

/** Lo más reciente que hay guardado: mejor que la copia en memoria de esta pestaña. */
export function freshestToken(): string | null {
  return localStorage.getItem('business_token') ?? useAuthStore.getState().token;
}

const HEARTBEAT_MS = 30_000;
const PROACTIVE_MARGIN_MS = 150_000;
const MIN_GAP_MS = 60_000;

/**
 * Renueva el token antes de que caduque, sin esperar a que una petición
 * falle. El margen (2,5 min + un poco de azar por pestaña) absorbe que el
 * navegador frene los temporizadores de una pestaña oculta hasta ~1 min,
 * y el azar evita que todas las pestañas lo intenten al mismo tiempo.
 * Devuelve la función que lo detiene.
 */
export function startSessionKeeper(): () => void {
  const jitter = Math.random() * 15_000;
  let lastAttempt = 0;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    const { token } = useAuthStore.getState();
    const current = localStorage.getItem('business_token') ?? token;
    if (!current) return;
    const now = Date.now();
    if (!needsRefresh(current, now + skewMs, PROACTIVE_MARGIN_MS + jitter)) return;
    if (now - lastAttempt < MIN_GAP_MS) return;
    lastAttempt = now;
    ensureFreshToken({ minValidityMs: PROACTIVE_MARGIN_MS }).catch((error) => {
      // Un rechazo definitivo cierra la sesión; cualquier otro fallo se
      // reintenta en el siguiente latido.
      if (error instanceof SessionEndedError) endSession();
    });
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };

  check();
  const interval = setInterval(check, HEARTBEAT_MS);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    clearInterval(interval);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
