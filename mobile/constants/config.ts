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
 * El origen del backend, siempre el real — nunca el de desarrollo.
 *
 * Lo usa el botón "Compartir": ese enlace lo abre alguien en otro
 * teléfono, o el rastreador de vista previa de WhatsApp desde internet, así
 * que un host de LAN (`192.168.x.x`) sería un enlace roto para todos menos
 * para quien está probando en este mismo momento. `API_URL` sí cambia con
 * `__DEV__` a propósito —ese es el que usa *esta* app para hablar con el
 * backend—, pero un enlace que sale de la app tiene que servir fuera de
 * ella.
 */
export const API_ORIGIN = PROD_ORIGIN;

/**
 * Quién puede hablarle a la vista previa del constructor de Explorar
 * (`app/preview/explore.tsx`) por `postMessage`: solo el panel admin.
 *
 * Sale de EXPO_PUBLIC_ADMIN_ORIGIN (varios separados por coma). En
 * desarrollo siempre se acepta el panel local.
 */
export const PREVIEW_ADMIN_ORIGINS: readonly string[] = [
  ...String(process.env.EXPO_PUBLIC_ADMIN_ORIGIN ?? '')
    .split(',')
    .map((origin: string) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  ...(__DEV__ ? ['http://localhost:3001'] : []),
];

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
 * Contacto de Zipp: el mismo número para clientes, domiciliarios y comercios.
 *
 * Se exporta en tres formas porque cada destino pide una distinta. Antes cada
 * pantalla armaba la suya a mano — el prefijo `57` estaba copiado en cuatro
 * sitios, así que "el número" vivía repartido y cambiarlo obligaba a
 * acordarse de todos.
 */

/** Nacional, sin indicativo. Lo que se marca dentro de Colombia (`tel:`). */
export const SUPPORT_PHONE = '3112421673';

/** E.164, con indicativo de país. Lo que piden WhatsApp y los enlaces `wa.me`. */
export const SUPPORT_PHONE_E164 = '+573112421673';

/** Agrupado para leerlo de un vistazo. Solo para mostrar, nunca para marcar. */
export const SUPPORT_PHONE_DISPLAY = '311 242 1673';

/**
 * Enlace de WhatsApp a soporte, con el mensaje ya escrito.
 *
 * Usa el esquema `whatsapp://`, que abre la app instalada sin pasar por el
 * navegador. Quien lo llame necesita un plan B: si WhatsApp no está
 * instalado `Linking.openURL` rechaza y no pasa nada visible.
 */
export const supportWhatsAppUrl = (text: string) =>
  `whatsapp://send?phone=${SUPPORT_PHONE_E164.slice(1)}&text=${encodeURIComponent(text)}`;
