/**
 * Qué distintivos merece un producto, y por qué.
 *
 * Las reglas viven aquí y no repartidas por las pantallas por una razón
 * concreta: un badge es una promesa al cliente. Si "Nuevo" significa siete
 * días en la carta del negocio y catorce en el buscador, deja de significar
 * nada. Un solo sitio donde cambiarlo es la única forma de que sigan
 * queriendo decir lo mismo en toda la app.
 */

export interface BadgeableProduct {
  price: number;
  discountPrice?: number | null;
  isAvailable?: boolean;
  isFeatured?: boolean;
  createdAt?: string | Date;
}

/**
 * Cuántos días un producto se considera recién llegado.
 *
 * Catorce y no siete: en un pueblo, un negocio puede tardar semanas en que
 * sus clientes habituales vuelvan a pedir. Una semana deja el distintivo
 * apagado antes de que la mitad de la gente lo haya visto.
 */
export const NEW_PRODUCT_DAYS = 14;

/**
 * El descuento redondeado, o null si no hay.
 *
 * Se redondea hacia abajo a propósito. Anunciar "-20%" sobre un ahorro real
 * del 19,6% es prometer de más por un punto que nadie iba a notar, y basta
 * una vez para que el precio final parezca un error.
 */
export function discountPercent(product: BadgeableProduct): number | null {
  const { price, discountPrice } = product;
  if (!discountPrice || discountPrice >= price || price <= 0) return null;

  const percent = Math.floor(((price - discountPrice) / price) * 100);

  // Por debajo del 5% el distintivo cuesta más de lo que aporta: llena la
  // tarjeta de ruido para anunciar unos pocos pesos.
  return percent >= 5 ? percent : null;
}

/** ¿Llegó hace poco a la carta? */
export function isNewProduct(product: BadgeableProduct): boolean {
  if (!product.createdAt) return false;

  const created = new Date(product.createdAt).getTime();
  if (Number.isNaN(created)) return false;

  return Date.now() - created < NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000;
}

export type CatalogBadgeKind = 'descuento' | 'nuevo' | 'destacado' | 'agotado';

export interface CatalogBadgeSpec {
  kind: CatalogBadgeKind;
  label: string;
}

/**
 * Los distintivos de un producto, ya ordenados y recortados.
 *
 * Devuelve como mucho dos. Tres o más convierten la tarjeta en un semáforo
 * y el ojo deja de leerlos: cuando todo destaca, nada destaca.
 *
 * El orden no es estético, es de utilidad para quien compra. "Agotado"
 * primero porque cambia si merece la pena seguir leyendo; el descuento
 * después porque es lo que mueve la decisión; "nuevo" y "destacado"
 * al final, que informan pero no aprietan.
 */
export function catalogBadges(product: BadgeableProduct): CatalogBadgeSpec[] {
  const badges: CatalogBadgeSpec[] = [];

  if (product.isAvailable === false) {
    // Un producto agotado no necesita que le cuenten su descuento.
    return [{ kind: 'agotado', label: 'Agotado' }];
  }

  const percent = discountPercent(product);
  if (percent) badges.push({ kind: 'descuento', label: `-${percent}%` });

  if (isNewProduct(product)) badges.push({ kind: 'nuevo', label: 'Nuevo' });
  if (product.isFeatured) badges.push({ kind: 'destacado', label: 'Destacado' });

  return badges.slice(0, 2);
}

/**
 * Cuánto falta para el envío gratis, o null si no aplica.
 *
 * Se calcula sobre el subtotal, no sobre el total: incluir el propio envío
 * en la cuenta haría que la cifra bajara sola al acercarse, que es la clase
 * de detalle que hace desconfiar del número entero.
 */
export function freeDeliveryGap(
  subtotal: number,
  threshold: number | null | undefined
): number | null {
  if (!threshold || threshold <= 0) return null;
  if (subtotal >= threshold) return null;
  return threshold - subtotal;
}

/**
 * Votos mínimos para enseñar el porcentaje de un plato.
 *
 * Con menos, el número engaña más de lo que informa: "100%" con un solo
 * pulgar no distingue un plato bueno de uno que probó una persona amable.
 */
export const MIN_VOTES_TO_SHOW = 3;

/** El porcentaje de pulgares arriba, o null si aún no se sostiene. */
export function likeRatio(
  sentiment: { likes: number; total: number } | undefined
): number | null {
  if (!sentiment || sentiment.total < MIN_VOTES_TO_SHOW) return null;
  return Math.round((sentiment.likes / sentiment.total) * 100);
}
