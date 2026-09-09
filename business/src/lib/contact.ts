/**
 * Contacto de Zipp para el panel de comercios.
 *
 * Es el mismo número que atiende a clientes y domiciliarios en la app móvil
 * (`mobile/constants/config.ts`). Cada frontend guarda su propia copia porque
 * el repo no tiene paquete compartido — igual que `apiError.ts`, que también
 * está duplicado en `admin/`. Si el número cambia, hay que tocar los dos.
 */

/** Nacional, sin indicativo. Lo que se marca desde Colombia (`tel:`). */
export const SUPPORT_PHONE = '3112421673';

/** Agrupado para leerlo de un vistazo. Solo para mostrar, nunca para marcar. */
export const SUPPORT_PHONE_DISPLAY = '311 242 1673';

/**
 * Enlace de WhatsApp a soporte, con el mensaje ya escrito.
 *
 * Va por `https://wa.me/` y no por el esquema `whatsapp://` que usa la app
 * móvil: en el navegador un esquema propio depende de que el sistema tenga
 * la app registrada, y si no lo está el clic no hace nada. `wa.me` siempre
 * aterriza en algún sitio — la app de escritorio o WhatsApp Web.
 */
export const supportWhatsAppUrl = (text: string) =>
  `https://wa.me/57${SUPPORT_PHONE}?text=${encodeURIComponent(text)}`;
