import { apiErrorCode, apiStatus } from './apiError';

/**
 * El núcleo puro de la renovación de sesión (ver `session.ts` para el porqué).
 *
 * Vive aparte y sin tocar el store, axios ni `localStorage` para poder
 * probarlo sin navegador: todo lo que necesita del mundo entra por
 * `RefresherDeps`.
 */

const RACE_RETRIES = 3;

/** La sesión terminó de verdad: hay que volver a iniciar sesión. */
export class SessionEndedError extends Error {
  constructor() {
    super('Sesión terminada');
    this.name = 'SessionEndedError';
  }
}

// ── Piezas puras ─────────────────────────────────────────────────────

export interface JwtPayload {
  exp?: number;
  iat?: number;
  id?: string;
  sid?: string;
}

/** Lee el cuerpo de un JWT sin verificarlo (solo para saber cuándo caduca). */
export function decodeJwtPayload(token: string | null | undefined): JwtPayload | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as JwtPayload) : null;
  } catch {
    return null;
  }
}

/**
 * ¿Caduca dentro de `minValidityMs`? `skewMs` corrige un reloj mal puesto:
 * es lo que el servidor adelanta (o atrasa) respecto a este equipo. Un
 * token sin `exp` legible se da por caducado.
 */
export function needsRefresh(
  token: string | null | undefined,
  now: number,
  minValidityMs: number,
  skewMs = 0
): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number') return true;
  return exp * 1000 - (now + skewMs) <= minValidityMs;
}

export type RefreshFailure = 'race' | 'fatal' | 'transient';

/**
 * Qué hacer con un fallo al renovar.
 *
 * Solo un rechazo explícito del servidor termina la sesión. Sin respuesta
 * (red caída), 5xx y 429 son transitorios: el comercio no pierde su sesión
 * porque el wifi del local parpadeó.
 */
export function classifyRefreshError(status: number | null, code: string | null): RefreshFailure {
  if (status === 409 && code === 'REFRESH_IN_PROGRESS') return 'race';
  if (status === 401 || status === 400 || status === 403) return 'fatal';
  return 'transient';
}

// ── Renovador ────────────────────────────────────────────────────────

interface Tokens {
  access: string | null;
  refresh: string | null;
}

export interface RefresherDeps {
  /** Lo que hay guardado ahora mismo (otra pestaña pudo haberlo cambiado). */
  readTokens: () => Tokens;
  /** Toma unos tokens ya rotados por otra pestaña: solo estado, sin escribir. */
  adopt: (access: string, refresh: string) => void;
  /** Guarda tokens recién recibidos: almacenamiento y estado. */
  save: (access: string, refresh: string) => void;
  post: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string }>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface EnsureOptions {
  /** Renovar si al token le quedan menos de esto. */
  minValidityMs?: number;
  /** El token con el que falló la petición: uno distinto y vigente ya es el arreglo. */
  failedToken?: string | null;
}

/** Pausa mínima tras un fallo transitorio al renovar. */
const COOL_DOWN_MS = 30_000;

/** Lo que pide el servidor con `Retry-After` (segundos), si lo manda. */
function retryAfterMs(error: unknown): number {
  const header = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers?.['retry-after'];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function createRefresher(deps: RefresherDeps) {
  // Cortacircuitos: tras un fallo transitorio no se vuelve a llamar al
  // servidor hasta pasada la pausa. Sin esto, cada 401 del sondeo, el latido
  // y el socket disparaban su propio POST: ~8 por minuto, y el límite del
  // endpoint es 60 cada 15 min por IP. En 7 minutos una sola pestaña lo
  // agotaba y el 429 se sostenía solo, dejando sin pedidos a todo el local.
  let coolDownUntil = 0;

  return function ensureFreshToken(options: EnsureOptions = {}): Promise<string> {
    const { minValidityMs = 30_000, failedToken = null } = options;

    return deps.withLock(async () => {
      let { access, refresh } = deps.readTokens();
      if (!refresh) throw new SessionEndedError();

      const usable = (token: string | null) =>
        !!token && token !== failedToken && !needsRefresh(token, deps.now(), minValidityMs);

      if (usable(access)) {
        deps.adopt(access!, refresh);
        return access!;
      }

      for (let attempt = 1; attempt <= RACE_RETRIES; attempt++) {
        if (deps.now() < coolDownUntil) throw new Error('Renovación de sesión en pausa');
        try {
          const fresh = await deps.post(refresh);
          coolDownUntil = 0;
          deps.save(fresh.accessToken, fresh.refreshToken);
          return fresh.accessToken;
        } catch (error) {
          const kind = classifyRefreshError(apiStatus(error), apiErrorCode(error));
          if (kind === 'fatal') throw new SessionEndedError();
          if (kind === 'transient') {
            coolDownUntil = deps.now() + Math.max(COOL_DOWN_MS, retryAfterMs(error));
            throw error;
          }

          // Carrera: otra renovación está en curso. Se espera y se relee; si
          // el refresh token cambió, esa renovación terminó y su resultado
          // es el que hay que usar.
          await deps.sleep(1000 * attempt);
          const again = deps.readTokens();
          if (again.refresh && again.refresh !== refresh) {
            refresh = again.refresh;
            access = again.access;
            if (usable(access)) {
              deps.adopt(access!, refresh);
              return access!;
            }
          }
        }
      }
      throw new Error('La renovación de la sesión sigue en curso en otra pestaña');
    });
  };
}
