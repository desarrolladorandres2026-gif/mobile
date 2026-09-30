import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { apiErrorCode, apiStatus } from '../lib/apiError';
import { getDeviceId } from '../lib/deviceId';
import { API_BASE, ensureFreshToken, endSession, SessionEndedError } from '../lib/session';

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
 * El access token dura solo 15 minutos: cuando expira en plena jornada, la
 * petición vuelve a intentarse con un token renovado y el comercio no nota
 * nada. La renovación vive en `lib/session.ts`, que la coordina entre
 * pestañas (el backend rota el refresh token en cada uso y un token rotado
 * presentado por otra pestaña se toma por robo). Aquí solo se decide qué
 * hacer con el resultado.
 */
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (apiStatus(error) === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const failed = String(originalRequest.headers?.Authorization ?? '').replace(/^Bearer /, '') || null;
        const accessToken = await ensureFreshToken({ failedToken: failed });
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Solo un rechazo definitivo cierra la sesión. Un corte de red al
        // renovar deja el error original: el comercio sigue dentro y la
        // siguiente petición lo reintenta.
        if (refreshError instanceof SessionEndedError) endSession();
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

