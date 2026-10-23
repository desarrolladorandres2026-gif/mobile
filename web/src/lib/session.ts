/**
 * Sesión del cliente en el navegador.
 *
 * El access token (15 min) vive solo en memoria: un XSS no lo encuentra en
 * disco. El refresh token (7 días) va en localStorage para sobrevivir a un
 * cierre de pestaña; es el trade-off elegido frente a la cookie httpOnly y
 * por eso el sitio exige una CSP estricta (ver deploy/nginx/csp-web.conf).
 *
 * Todo acceso a localStorage va en try/catch: en modo privado o con el
 * almacenamiento bloqueado lanza, y la sesión debe seguir funcionando en
 * memoria mientras la pestaña viva.
 */
const REFRESH_KEY = 'zipp_refresh';

let accessToken: string | null = null;
let refreshMemory: string | null = null;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null): void {
  try {
    if (value) localStorage.setItem(REFRESH_KEY, value);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // Sin almacenamiento: la sesión queda solo en memoria.
  }
}

function notify(): void {
  listeners.forEach((l) => l());
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  // El almacenamiento compartido manda: otra pestaña pudo rotar el token mientras esta dormía.
  return readStored() ?? refreshMemory;
}

export function hasSession(): boolean {
  return getRefreshToken() !== null;
}

export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshMemory = refresh;
  writeStored(refresh);
  notify();
}

export function clearSession(): void {
  accessToken = null;
  refreshMemory = null;
  writeStored(null);
  notify();
}

/** Para `useSyncExternalStore`: avisa cuando la sesión cambia. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cerrar sesión (o iniciarla) en otra pestaña se refleja aquí: el refresh
// token rota en cada uso, y dos pestañas con copias distintas se pisarían.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== REFRESH_KEY) return;
    refreshMemory = e.newValue;
    if (!e.newValue) accessToken = null;
    notify();
  });
}

// Página restaurada desde la caché de «atrás» (p. ej. al volver de Wompi): su memoria es vieja.
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    refreshMemory = readStored();
    accessToken = null;
    notify();
  });
}

const DEVICE_KEY = 'zipp_device';

/**
 * Identificador estable de este navegador, para que el antifraude del
 * backend reconozca el dispositivo entre sesiones. No es un secreto ni
 * identifica a la persona: se borra con los datos del sitio.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'web-sin-almacenamiento';
  }
}
