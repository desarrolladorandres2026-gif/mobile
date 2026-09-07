import { Request } from 'express';

/**
 * Helper to safely extract a route param as string.
 * Express v5 types can return string | string[] for params.
 */
export const param = (req: Request, key: string): string => {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
};

/**
 * Helper to safely extract a query param as string or undefined.
 */
export const query = (req: Request, key: string): string | undefined => {
  const val = req.query[key];
  if (val === undefined) return undefined;
  return Array.isArray(val) ? String(val[0]) : String(val);
};

/**
 * Format Colombian pesos
 */
export const formatCOP = (amount: number): string => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
  }).format(amount);
};

/**
 * IP real de quien hace la petición.
 *
 * `trust proxy` está activo, así que Express ya resuelve `req.ip` detrás
 * del balanceador; se lee `x-forwarded-for` primero porque la auditoría
 * y la bitácora del pedido tienen que coincidir dígito a dígito con lo
 * que registra el limitador de peticiones, y ese mira la cabecera.
 */
export const clientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

export const userAgent = (req: Request): string =>
  (req.headers['user-agent'] as string) || 'unknown';

/**
 * Ubicación declarada por el dispositivo que ejecuta una acción.
 *
 * Es contexto, no prueba: un GPS se falsea. Sirve para que soporte vea
 * "la foto se tomó a 4 km del destino" y haga preguntas, nunca para
 * autorizar nada por sí sola.
 */
export const readLocation = (body: any): { lat: number; lng: number } | null => {
  const lat = Number(body?.latitude);
  const lng = Number(body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};
