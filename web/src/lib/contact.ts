/**
 * Contacto de Zipp. El mismo número que atiende dentro de la app móvil y del
 * panel de comercios (ver `mobile/constants/config.ts`) — aquí se muestra
 * agrupado y se marca sin espacios.
 */
export const SUPPORT_PHONE = '3112421673';

/** E.164, con indicativo de país. Lo que pide el enlace `wa.me`. */
export const SUPPORT_PHONE_E164 = '573112421673';

/** Agrupado para leerlo de un vistazo. Solo para mostrar, nunca para marcar. */
export const SUPPORT_PHONE_DISPLAY = '311 242 1673';

/**
 * Enlace de WhatsApp a soporte, con el mensaje ya escrito.
 *
 * A diferencia de mobile (que usa el esquema `whatsapp://` vía `Linking`),
 * en el navegador el enlace universal es `wa.me`: funciona igual si hay
 * WhatsApp instalado (abre la app) o no (abre WhatsApp Web).
 */
export const supportWhatsAppUrl = (text: string) =>
  `https://wa.me/${SUPPORT_PHONE_E164}?text=${encodeURIComponent(text)}`;
