import axios from 'axios';
import { API_URL } from '../constants';
import { useAuthStore } from '../stores/authStore';

const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
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

/**
 * El access token dura 15 minutos y cualquier pantalla puede disparar varias
 * peticiones a la vez (varias queries de React Query montándose juntas). Si
 * el token expiró, todas reciben 401 casi en el mismo instante.
 *
 * El backend rota el refresh token en cada uso y trata reusar uno viejo como
 * robo de sesión: revoca TODAS las sesiones del usuario. Sin este candado,
 * cada 401 dispararía su propio POST a /auth/refresh-token con el mismo
 * refresh token todavía vigente; la primera petición lo consume con éxito,
 * la segunda lo encuentra ya invalidado y el backend interpreta eso como
 * reuse — sesión cerrada de golpe sin que el usuario haya hecho nada.
 * Compartir una única promesa de refresco entre peticiones concurrentes
 * evita esa falsa alarma.
 */
let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

async function refreshTokens() {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) throw new Error('No refresh token');

  const { data } = await axios.post(`${API_URL}/auth/refresh-token`, { refreshToken });
  const tokens = data.data as { accessToken: string; refreshToken: string };
  await useAuthStore.getState().setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens;
}

// Response interceptor - handle token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        if (!refreshPromise) {
          refreshPromise = refreshTokens().finally(() => {
            refreshPromise = null;
          });
        }
        const { accessToken } = await refreshPromise;
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
