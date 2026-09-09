import axios from 'axios';
import { API_URL } from '../constants';
import { useAuthStore } from '../stores/authStore';
import { singleFlight } from '../lib/singleFlight';

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

  const { data } = await axios.post(`${API_URL}/auth/refresh-token`, { refreshToken });
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
      } catch {
        useAuthStore.getState().logout();
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
