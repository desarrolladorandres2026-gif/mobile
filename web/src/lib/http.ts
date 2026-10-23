import { API_URL } from './config';
import { tokenExpiresAt } from './jwt';
import { clearSession, getAccessToken, getDeviceId, getRefreshToken, setTokens } from './session';
import { singleFlight } from './singleFlight';

/** Error de la API con el estado HTTP y el código de negocio, si lo trae. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 12_000;
// Con tope y sin cortar antes: si el servidor rota el token y la respuesta se
// pierde por cortar pronto, el reintento encontraría el token ya usado.
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_RETRY_DELAY_MS = 400;
const REFRESH_RETRIES = 3;

async function send(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...(init.headers as Record<string, string> | undefined), 'X-Device-ID': getDeviceId() };
    return await fetch(`${API_URL}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  let body: { message?: string; code?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Respuesta sin JSON (502 de nginx, por ejemplo): vale el mensaje por defecto.
  }
  return new ApiError(body.message || fallback, res.status, body.code);
}

/** ¿Este fallo del refresco significa que la sesión murió de verdad? */
function sessionIsDead(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

async function refreshTokens(): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    // Se lee en cada intento: tras un 409 otra pestaña pudo rotar el token, y reenviar el viejo
    // sería «reuso» para el servidor, que cierra todas las sesiones.
    const refreshToken = getRefreshToken();
    if (!refreshToken) throw new ApiError('Sin sesión', 401, 'NO_REFRESH_TOKEN');
    const res = await send(
      '/auth/refresh-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      REFRESH_TIMEOUT_MS,
    );
    if (res.ok) {
      const tokens = (await res.json()).data as { accessToken: string; refreshToken: string };
      setTokens(tokens.accessToken, tokens.refreshToken);
      return tokens.accessToken;
    }
    const error = await toApiError(res, 'No se pudo renovar la sesión');
    // 409: otra pestaña o petición ya está rotando el token. Se espera y se
    // reintenta; no es una sesión muerta.
    if (error.code === 'REFRESH_IN_PROGRESS' && attempt < REFRESH_RETRIES) {
      await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAY_MS));
      continue;
    }
    throw error;
  }
}

/**
 * Un refresco a la vez. El backend rota el refresh token en cada uso y trata
 * reusar uno viejo como robo de sesión (cierra todas): dos 401 casi
 * simultáneos con el mismo token sacarían al cliente sin motivo.
 */
const refreshOnce = singleFlight(refreshTokens);

/** Renueva antes de usar el token si vence en menos de `marginSeconds`. */
export async function ensureFreshAccessToken(marginSeconds = 60): Promise<void> {
  if (!getRefreshToken()) return;
  const access = getAccessToken();
  const expiresAt = tokenExpiresAt(access);
  if (access && expiresAt !== null && expiresAt - Date.now() > marginSeconds * 1000) return;
  try {
    await refreshOnce();
  } catch (error) {
    // Solo un 401/403 cierra la sesión; un corte de red o un 5xx no.
    if (sessionIsDead(error)) clearSession();
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Con sesión: manda el Bearer y renueva si hace falta. */
  auth?: boolean;
  /** Bearer explícito para una sesión que todavía no se guardó (p. ej. cerrar la de una cuenta rechazada). */
  bearer?: string;
  /**
   * Un 401 renueva el token y repite la petición. Se apaga en las rutas cuyo 401 es una respuesta de
   * negocio (contraseña incorrecta): repetirlas rota el token de más y cuenta dos intentos fallidos.
   */
  retryOn401?: boolean;
  /** Tope de espera de esta petición. Crear un pedido reserva stock y pasa antifraude: necesita más que el resto. */
  timeoutMs?: number;
}

/** Llama a la API y devuelve `data` del cuerpo. Lanza `ApiError` si falla. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = false, bearer, retryOn401 = true, timeoutMs = REQUEST_TIMEOUT_MS } = opts;

  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = bearer ?? (auth ? getAccessToken() : null);
    if (token) headers.Authorization = `Bearer ${token}`;
    return send(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
  };

  if (auth) await ensureFreshAccessToken();
  let res = await attempt();

  if (auth && retryOn401 && res.status === 401) {
    try {
      await refreshOnce();
      res = await attempt();
    } catch (error) {
      if (sessionIsDead(error)) clearSession();
    }
  }

  if (!res.ok) throw await toApiError(res, 'No se pudo completar la solicitud');
  if (res.status === 204) return undefined as T;
  return (await res.json()).data as T;
}
