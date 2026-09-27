import axios from 'axios';
import { apiStatus, apiErrorCode } from '../lib/apiError';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const api = axios.create({
 baseURL: API_BASE,
 headers: {
 'Content-Type': 'application/json',
 },
 timeout: 15000,
});

api.interceptors.request.use((config) => {
 const token = localStorage.getItem('admin_token');
 if (token) {
 config.headers.Authorization = `Bearer ${token}`;
 }
 return config;
}, (error) => {
 return Promise.reject(error);
});

/**
 * El access token dura solo 15 minutos. Antes, cualquier 401 —incluido el
 * que llega en cuanto expira, en medio de una sesión de trabajo normal—
 * borraba todo `localStorage` y mandaba al admin de vuelta al login sin más.
 * Guardamos el refresh token en el login precisamente para poder renovar la
 * sesión sola aquí, igual que ya hace la app móvil, y reservar el logout
 * duro para cuando el refresh también falla (token robado/expirado o
 * revocado a propósito).
 *
 * `refreshPromise` evita que dos peticiones que expiran a la vez disparen
 * dos refrescos en paralelo: el backend rota el refresh token en cada uso y
 * trataría el segundo intento como reuse, revocando todas las sesiones.
 */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
 const refreshToken = localStorage.getItem('admin_refresh_token');
 if (!refreshToken) throw new Error('No refresh token');

 const { data } = await axios.post(`${API_BASE}/auth/refresh-token`, { refreshToken });
 const tokens = data.data as { accessToken: string; refreshToken: string };
 localStorage.setItem('admin_token', tokens.accessToken);
 localStorage.setItem('admin_refresh_token', tokens.refreshToken);
 return tokens.accessToken;
}

api.interceptors.response.use(
 (response) => response,
 async (error) => {
 const originalRequest = error.config;

 // Un admin con `TOTP_REQUIRED_ADMINS` activo y sin 2FA propio recibe
 // este 403 en cualquier ruta salvo /auth/me, /logout y las de
 // configurar 2FA (ver `TWO_FACTOR_SETUP_PATHS` en el backend). No es un
 // fallo de la pantalla que lo pidió: es que la cuenta tiene que activar
 // 2FA antes de usar el resto del panel.
 if (
 apiStatus(error) === 403 &&
 apiErrorCode(error) === 'TWO_FACTOR_SETUP_REQUIRED' &&
 window.location.pathname !== '/setup-2fa'
 ) {
 window.location.href = '/setup-2fa';
 return Promise.reject(error);
 }

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
 localStorage.clear();
 window.location.href = '/login';
 return Promise.reject(error);
 }
 }
 return Promise.reject(error);
 }
);

export default api;

