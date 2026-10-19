import * as Crypto from 'expo-crypto';

/**
 * Identificador de un toque sobre un anuncio. El servidor lo usa para no
 * cobrar dos veces el mismo clic (índice único por campaña y `clickId`): se
 * genera UNA vez por anuncio en pantalla, así que un doble toque o un
 * reintento llegan con el mismo id y cuentan una sola vez.
 *
 * No es un secreto: si el módulo nativo no está (pruebas), basta con algo
 * único por exhibición.
 */
export function newAdClickId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
