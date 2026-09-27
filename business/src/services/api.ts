import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { apiErrorCode, apiStatus } from '../lib/apiError';
import { getDeviceId } from '../lib/deviceId';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // El centro de seguridad reconoce este navegador por aquí (ver lib/deviceId).
  config.headers['X-Device-ID'] = getDeviceId();
  return config;
}, (error) => {
  return Promise.reject(error);
});

/**
 * El access token dura solo 15 minutos. Antes, cualquier 401 —incluido el
 * que llega en cuanto expira, en medio de una jornada normal en el panel—
 * cerraba la sesión del comercio sin más. Ahora se intenta renovar primero
 * con el refresh token y solo se cierra sesión si eso también falla.
 *
 * `refreshPromise` evita que dos peticiones que expiran a la vez disparen
 * dos refrescos en paralelo: el backend rota el refresh token en cada uso y
 * trataría el segundo intento como reuse, revocando todas las sesiones.
 */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) throw new Error('No refresh token');

  const { data } = await axios.post(`${API_BASE}/auth/refresh-token`, { refreshToken }, { headers: { 'X-Device-ID': getDeviceId() } });
  const tokens = data.data as { accessToken: string; refreshToken: string };
  useAuthStore.getState().setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens.accessToken;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (apiStatus(error) === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        if (!refreshPromise) {
          refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
          });
        }
        const accessToken = await refreshPromise;
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        window.location.href = '/login';
        return Promise.reject(error);
      }
    }
    // Con `TOTP_REQUIRED_BUSINESS` encendido, un comercio sin 2FA solo puede
    // configurarlo: el backend responde 403 a todo lo demás. Se le lleva a
    // la pantalla de activación en vez de dejarle un panel vacío.
    if (
      apiStatus(error) === 403 &&
      apiErrorCode(error) === 'TWO_FACTOR_SETUP_REQUIRED' &&
      window.location.pathname !== '/setup-2fa'
    ) {
      window.location.href = '/setup-2fa';
    }
    return Promise.reject(error);
  }
);

export default api;

