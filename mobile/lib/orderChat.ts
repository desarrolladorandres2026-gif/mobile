/**
 * Los dos hilos del chat de un pedido.
 *
 * `client_driver` es el de siempre. `business_driver` (comercio y
 * domiciliario) solo lo ven y lo escriben el domiciliario y el comercio: el
 * servidor no se lo manda nunca al cliente. Aquí vive la lógica pura que
 * decide a qué hilo pertenece cada cosa, para que la caché, el socket y la
 * hoja no la reimplementen cada uno a su manera.
 */

export type ChatChannel = 'client_driver' | 'business_driver';

/** El hilo que existía antes de que hubiera dos. */
export const DEFAULT_CHAT_CHANNEL: ChatChannel = 'client_driver';

/**
 * Un servidor viejo no manda `channel`: ese mensaje es del hilo del cliente.
 * Cualquier valor desconocido cae ahí también — nunca en el del comercio —,
 * así un campo raro no cuela un mensaje en una conversación que no es.
 */
export function messageChannel(
  message: { channel?: string | null } | null | undefined,
): ChatChannel {
  return message?.channel === 'business_driver' ? 'business_driver' : DEFAULT_CHAT_CHANNEL;
}

/** Igual que `messageChannel`, para un canal suelto (p. ej. `order:chat:read`). */
export function normalizeChannel(channel: string | null | undefined): ChatChannel {
  return channel === 'business_driver' ? 'business_driver' : DEFAULT_CHAT_CHANNEL;
}

/** Prefijo de todas las claves de chat de un pedido (para invalidar ambos hilos). */
export const chatThreadsKey = (orderId: string | undefined) => ['orderChat', orderId] as const;

/** Clave de caché de un hilo: el canal va dentro para que no se mezclen. */
export const chatThreadKey = (orderId: string | undefined, channel: ChatChannel) =>
  ['orderChat', orderId, channel] as const;

/**
 * A qué hilo toca un evento de socket (`order:chat:message` u
 * `order:chat:read`), o `null` si hay que ignorarlo.
 *
 * - Se ignora si es de otro pedido.
 * - `canSeeBusiness` es `false` en la app del cliente: aunque algún día el
 *   servidor se equivocara, un mensaje del hilo del comercio no toca nada ahí.
 */
export function chatEventChannel(
  payload: { orderId?: string; channel?: string | null; message?: { channel?: string | null } | null } | null | undefined,
  orderId: string,
  canSeeBusiness: boolean,
): ChatChannel | null {
  if (!payload) return null;
  if (payload.orderId && payload.orderId !== orderId) return null;
  const channel = payload.message ? messageChannel(payload.message) : normalizeChannel(payload.channel);
  if (channel === 'business_driver' && !canSeeBusiness) return null;
  return channel;
}

export interface ChatUnread {
  unread?: number | null;
  unreadBusiness?: number | null;
}

/** No leídos por hilo. `unreadBusiness` falta en servidores viejos: vale 0. */
export function unreadByChannel(chat: ChatUnread | null | undefined): Record<ChatChannel, number> {
  return {
    client_driver: Math.max(0, chat?.unread ?? 0),
    business_driver: Math.max(0, chat?.unreadBusiness ?? 0),
  };
}

/** Suma de los dos hilos: lo que enseña el indicador del botón de chat. */
export function totalUnread(chat: ChatUnread | null | undefined): number {
  const u = unreadByChannel(chat);
  return u.client_driver + u.business_driver;
}

/**
 * Qué segmento abre la hoja. Por defecto el del cliente; solo se salta al del
 * comercio cuando es el único con algo sin leer.
 */
export function initialChatChannel(chat: ChatUnread | null | undefined): ChatChannel {
  const u = unreadByChannel(chat);
  return u.business_driver > 0 && u.client_driver === 0 ? 'business_driver' : DEFAULT_CHAT_CHANNEL;
}

/**
 * Parámetro `channel` que viaja a la API. Para el hilo del cliente se omite:
 * es lo que el servidor asume y deja la petición de la app del cliente
 * idéntica a la de antes.
 */
export function channelParam(channel: ChatChannel): { channel?: ChatChannel } {
  return channel === 'business_driver' ? { channel } : {};
}
