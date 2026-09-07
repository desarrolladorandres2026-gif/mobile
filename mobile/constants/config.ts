import Constants from 'expo-constants';

// ── Detect the dev server host so the app always reaches the backend ──
function getDevHost(): string {
  // expo-constants exposes the packager IP, which is the machine running Metro
  const debuggerHost = Constants.expoConfig?.hostUri ?? Constants.manifest2?.extra?.expoGo?.debuggerHost;
  if (debuggerHost) {
    // debuggerHost is "ip:port" – strip the Metro port
    return debuggerHost.split(':')[0];
  }
  // Fallback: your current LAN IP
  return '192.168.1.7';
}

const DEV_HOST = getDevHost();
const BACKEND_PORT = 3000;

/**
 * Origen del backend en las builds de producción.
 *
 * Sale de EXPO_PUBLIC_API_ORIGIN, que Expo incrusta en el bundle al
 * compilar, igual que Vite hace con los paneles. Se define en `mobile/.env`.
 * El valor por defecto es el despliegue actual: así un `assembleRelease`
 * lanzado sin variables produce un APK que apunta a un backend que existe,
 * en vez de a un dominio que nadie ha registrado.
 *
 * Sin barra final: las dos constantes de abajo la añaden.
 */
const PROD_ORIGIN =
  process.env.EXPO_PUBLIC_API_ORIGIN ?? 'https://api.45-93-100-122.sslip.io';

export const API_URL = __DEV__
  ? `http://${DEV_HOST}:${BACKEND_PORT}/api/v1`
  : `${PROD_ORIGIN}/api/v1`;

export const SOCKET_URL = __DEV__
  ? `http://${DEV_HOST}:${BACKEND_PORT}`
  : PROD_ORIGIN;

/**
 * Categorías de negocio. El icono ya no viaja aquí: lo resuelve
 * `categoryIcon()` en `theme/icons.ts`, para que exista un solo lugar donde
 * se decide cómo se ve cada categoría.
 */
export const BUSINESS_CATEGORIES = [
  { key: 'restaurant', label: 'Restaurantes' },
  { key: 'fast_food', label: 'Comidas rápidas' },
  { key: 'pharmacy', label: 'Droguerías' },
  { key: 'cafe', label: 'Cafeterías' },
  { key: 'supermarket', label: 'Mercados' },
] as const;

/** Estado del pedido en una palabra, como se lo contarías a alguien. */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Enviado al local',
  accepted: 'Aceptado',
  preparing: 'Preparando',
  ready: 'Listo',
  picked_up: 'Recogido',
  on_way: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

/**
 * Qué está pasando de verdad, en segunda persona. Se usa en seguimiento y en
 * el dock de pedido activo, donde el cliente quiere saber si ya puede bajar.
 */
export const ORDER_STATUS_DETAIL: Record<string, string> = {
  pending: 'Le avisamos al local. Confirma en un momento.',
  accepted: 'El local aceptó tu pedido y ya lo va a empezar.',
  preparing: 'Lo están preparando ahora mismo.',
  ready: 'Está listo. Un domiciliario pasa a recogerlo.',
  picked_up: 'Ya lo recogieron. Va saliendo hacia ti.',
  on_way: 'Va en camino a tu dirección.',
  delivered: 'Entregado. ¡Buen provecho!',
  cancelled: 'Este pedido se canceló.',
};

/** Estados en los que el pedido todavía se está moviendo. */
export const ACTIVE_ORDER_STATUSES = [
  'pending', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way',
] as const;

/**
 * Número de soporte de Zipp (WhatsApp / llamada).
 * Se incluye el código de país 57 donde sea necesario.
 */
export const SUPPORT_PHONE = '3001234567';
