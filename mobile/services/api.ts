import axios from 'axios';
import { API_URL } from '../constants';
import { useAuthStore } from '../stores/authStore';
import { singleFlight } from '../lib/singleFlight';
import { tokenExpiresAt } from '../lib/jwt';

const api = axios.create({
  baseURL: API_URL,
  /**
   * 12 s, no 15.
   *
   * Multiplicado por los reintentos de React Query, 15 s significaban que el
   * usuario miraba esqueletos **45 segundos** antes de que apareciera el
   * mensaje de error. Ninguna petición sana de esta API tarda ni de lejos
   * eso: pasado este punto lo honesto es decir que algo va mal, no seguir
   * fingiendo que carga.
   */
  timeout: 12000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor - add token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

async function refreshTokens() {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) throw new Error('No refresh token');

  // Con tope: sin él, un refresco colgado dejaba colgadas todas las
  // peticiones que esperaban el token nuevo. 15 s y no menos: si el servidor
  // rota el token y la respuesta se pierde por cortar antes, el siguiente
  // intento lo encontraría ya usado.
  const { data } = await axios.post(`${API_URL}/auth/refresh-token`, { refreshToken }, { timeout: 15_000 });
  const tokens = data.data as { accessToken: string; refreshToken: string };
  await useAuthStore.getState().setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens;
}

/**
 * Un refresco a la vez. Ver el comentario de `singleFlight` para el porqué:
 * aquí es donde importa, porque varias queries de React Query pueden
 * montarse juntas y recibir 401 casi en el mismo instante.
 */
const refreshOnce = singleFlight(refreshTokens);

/**
 * ¿Este fallo del refresco significa que la sesión murió de verdad?
 *
 * Solo un 401/403 del servidor —token revocado, vencido o reusado— o no
 * tener refresh token. Antes cualquier fallo cerraba la sesión: un túnel,
 * un timeout o un 5xx pasajero sacaban a la gente de la app sin motivo.
 * Ahora esos casos fallan la petición y la sesión sigue ahí para el
 * siguiente intento.
 */
function sessionIsDead(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401 || status === 403) return true;
  return (error as Error)?.message === 'No refresh token';
}

/**
 * Refresca el token **antes** de usarlo si vence en menos de `marginSeconds`.
 *
 * El access token dura 15 minutos, así que al abrir la app casi siempre
 * está vencido. Antes se descubría a golpe de 401: cada petición del
 * arranque (y el handshake del socket) fallaba primero, esperaba al
 * refresco y se repetía — tres viajes donde bastaba uno. Se llama desde el
 * splash, en paralelo con la marca.
 */
export async function ensureFreshAccessToken(marginSeconds = 60): Promise<void> {
  const { accessToken, refreshToken } = useAuthStore.getState();
  if (!accessToken || !refreshToken) return;
  const expiresAt = tokenExpiresAt(accessToken);
  if (expiresAt !== null && expiresAt - Date.now() > marginSeconds * 1000) return;
  try {
    await refreshOnce();
  } catch (error) {
    if (sessionIsDead(error)) await useAuthStore.getState().logout();
  }
}

// Response interceptor - handle token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const { accessToken } = await refreshOnce();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        if (sessionIsDead(refreshError)) useAuthStore.getState().logout();
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
