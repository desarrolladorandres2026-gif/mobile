/** Variables de entorno del sitio, leídas en un solo lugar. */
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
export const SOCKET_URL: string = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
export const BUSINESS_URL: string = import.meta.env.VITE_BUSINESS_URL || 'http://localhost:3002';
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Un build de producción sin su .env apuntaría a localhost y fallaría sin aviso en la primera llamada.
if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  throw new Error('Falta VITE_API_URL en web/.env.production (ver deploy/web.env.production.example).');
}
