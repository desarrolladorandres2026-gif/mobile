/**
 * Mostrador y entrada como responsable (decisión 2026-10-13).
 *
 * El panel siempre arranca en el mostrador: el login pide
 * `surface: 'business-counter'` y el backend topa esa sesión al papel
 * Empleado, aunque entre el dueño. Para ver dinero, equipo o ajustes, un
 * administrador o el representante legal entra encima con su PIN
 * (`/auth/counter/elevate`) o, si aún no tiene PIN, con su contraseña.
 *
 * La sesión del mostrador no se cierra al subir: se guarda aparte y vuelve
 * al bajar. Por eso aquí hay dos juegos de tokens y una marca de qué tipo
 * de sesión es la activa. El token no dice su `scope`, así que la marca la
 * lleva el navegador; el backend decide igual lo que se puede hacer.
 */

export type SessionKind = 'counter' | 'elevated-pin' | 'elevated-password';

const KIND_KEY = 'business_session_kind';
const STASH_KEY = 'business_counter_stash';
const ACTIVITY_KEY = 'business_elevated_activity';

/** Lo mismo que el backend da a la sesión elevada: 15 min sin uso y se baja. */
export const ELEVATED_IDLE_MS = 15 * 60_000;

interface StashedCounter {
  user: unknown;
  token: string;
  refreshToken: string;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionKind(): SessionKind | null {
  const kind = read(KIND_KEY);
  return kind === 'counter' || kind === 'elevated-pin' || kind === 'elevated-password' ? kind : null;
}

export function isElevated(): boolean {
  const kind = sessionKind();
  return kind === 'elevated-pin' || kind === 'elevated-password';
}

export function markCounterSession(): void {
  localStorage.setItem(KIND_KEY, 'counter');
  localStorage.removeItem(STASH_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
}

/**
 * Sube a la sesión del responsable guardando la del mostrador.
 * Escribe los tokens nuevos directamente: quien llama recarga la página
 * para que ninguna caché ni socket de la identidad anterior sobreviva.
 */
export function enterElevated(
  kind: Exclude<SessionKind, 'counter'>,
  next: { user: unknown; accessToken: string; refreshToken: string }
): void {
  const token = read('business_token');
  const refreshToken = read('business_refresh_token');
  if (!token || !refreshToken) throw new Error('No hay sesión de mostrador que guardar.');
  // Subir desde una sesión ya elevada no debe pisar la del mostrador.
  if (!isElevated()) {
    const stash: StashedCounter = { user: JSON.parse(read('business_user') || 'null'), token, refreshToken };
    localStorage.setItem(STASH_KEY, JSON.stringify(stash));
  }
  localStorage.setItem('business_user', JSON.stringify(next.user));
  localStorage.setItem('business_token', next.accessToken);
  localStorage.setItem('business_refresh_token', next.refreshToken);
  localStorage.setItem(KIND_KEY, kind);
  touchElevated(true);
}

/**
 * Vuelve a la sesión del mostrador. Devuelve false si no había ninguna
 * guardada (y entonces lo correcto es cerrar sesión del todo).
 */
export function restoreCounter(): boolean {
  let stash: StashedCounter | null;
  try {
    stash = JSON.parse(read(STASH_KEY) || 'null');
  } catch {
    stash = null;
  }
  localStorage.removeItem(STASH_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
  if (!stash?.token || !stash.refreshToken) {
    localStorage.removeItem(KIND_KEY);
    return false;
  }
  localStorage.setItem('business_user', JSON.stringify(stash.user));
  localStorage.setItem('business_token', stash.token);
  localStorage.setItem('business_refresh_token', stash.refreshToken);
  localStorage.setItem(KIND_KEY, 'counter');
  return true;
}

export function clearCounterState(): void {
  localStorage.removeItem(KIND_KEY);
  localStorage.removeItem(STASH_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
}

let lastTouch = 0;
/** Registra uso real (teclado, puntero). Se escribe como mucho cada 10 s. */
export function touchElevated(force = false): void {
  const now = Date.now();
  if (!force && now - lastTouch < 10_000) return;
  lastTouch = now;
  localStorage.setItem(ACTIVITY_KEY, String(now));
}

/** ¿Lleva la sesión elevada más de `ELEVATED_IDLE_MS` sin uso? */
export function elevatedIdle(now = Date.now()): boolean {
  const last = Number(read(ACTIVITY_KEY));
  // Sin marca de actividad no hay forma de saber cuánto lleva: se baja.
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last > ELEVATED_IDLE_MS;
}

export const COUNTER_STORAGE_KEYS = [KIND_KEY, STASH_KEY] as const;
