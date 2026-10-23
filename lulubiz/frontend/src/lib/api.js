/**
 * Cliente de la API. Todas las peticiones van al mismo origen (la cookie de sesión es SameSite=Strict
 * y HttpOnly: el código de la página nunca la ve). Un 401 avisa a la sesión para volver al inicio.
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

async function request(method, path, { body, headers } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new ApiError(response.status, data?.error ?? 'ERROR', data?.message ?? `Error ${response.status}`);
    // Un 401 de sesión vencida cierra la sesión local; un 401 de credenciales o de código es un error normal de formulario.
    if (response.status === 401 && ['INVALID_SESSION'].includes(error.code)) onUnauthorized(error);
    throw error;
  }
  return data;
}

/** Descarga un archivo (GET). Devuelve el contenido como Blob y el nombre sugerido por el servidor, si lo manda. */
async function download(path) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new ApiError(response.status, data?.error ?? 'ERROR', data?.message ?? `Error ${response.status}`);
    if (response.status === 401 && error.code === 'INVALID_SESSION') onUnauthorized(error);
    throw error;
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? null;
  return { blob: await response.blob(), name };
}

export const api = {
  download,
  get: (path) => request('GET', path),
  post: (path, body, headers) => request('POST', path, { body: body ?? {}, headers }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  delete: (path) => request('DELETE', path),
};

/** Clave de idempotencia nueva: se genera al abrir un formulario y se reutiliza si se reintenta el envío. */
export const newIdempotencyKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Lee el token del fragmento de la URL (`#token=...`) y lo borra de la barra de direcciones. */
export function takeFragmentToken() {
  const match = window.location.hash.match(/token=([^&]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}
