import type { OfferBusiness, OfferCoupon, ProductSearchHit } from '../services/endpoints';

/**
 * Reglas de "esto es urgente" para la pantalla de Descuentos.
 *
 * Todo lo de aquí deriva de datos que el servidor ya manda —`validUntil`,
 * `usageLimit`/`usedCount`, `discountPercent`— para que la sensación de
 * urgencia sea real y no un efecto visual sin nada detrás.
 */

/** Ventana en la que un cupón se considera "por vencer". */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

/** Un producto entra a "Grandes rebajas" a partir de este porcentaje. */
export const BIG_DISCOUNT_PERCENT = 30;

export function msUntil(date: string | Date): number {
  return new Date(date).getTime() - Date.now();
}

export function isExpiringSoon(coupon: OfferCoupon): boolean {
  const ms = msUntil(coupon.validUntil);
  return ms > 0 && ms <= EXPIRING_SOON_MS;
}

/** `93820` → `"26:03:40"`. Siempre dos dígitos por campo, aunque pasen de 24h. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Cuánto se ha agotado un cupón con cupo limitado. `null` cuando no tiene
 * límite: un cupón sin `usageLimit` no tiene nada que mostrar en la barra.
 */
export function usageProgress(coupon: OfferCoupon): number | null {
  if (!coupon.usageLimit) return null;
  return Math.min(1, (coupon.usedCount ?? 0) / coupon.usageLimit);
}

/**
 * Puntaje comparable entre tipos de cupón distintos, solo para ordenar cuál
 * merece el spotlight. Un fijo se escala a un equivalente aproximado de
 * porcentaje y el envío gratis se trata como un descuento medio: ninguno de
 * los tres se puede comparar en sus propias unidades.
 */
function couponScore(coupon: OfferCoupon): number {
  if (coupon.type === 'percentage') return coupon.value;
  if (coupon.type === 'fixed') return Math.min(80, coupon.value / 500);
  return 40;
}

/**
 * El cupón que merece el spotlight de arriba: el que vence antes si hay
 * alguno por vencer, o si no el de mayor puntaje.
 */
export function pickSpotlightCoupon(coupons: OfferCoupon[]): OfferCoupon | null {
  if (!coupons.length) return null;

  const expiring = coupons
    .filter(isExpiringSoon)
    .sort((a, b) => msUntil(a.validUntil) - msUntil(b.validUntil));
  if (expiring.length) return expiring[0];

  return [...coupons].sort((a, b) => couponScore(b) - couponScore(a))[0];
}

/**
 * Los platos con el descuento más alto, ya limitados. `products` llega
 * ordenado por `discountPercent` desde el backend, así que basta con
 * filtrar y recortar: no hay que volver a ordenar.
 */
export function bigDiscountProducts(
  products: ProductSearchHit[],
  limit = 6
): ProductSearchHit[] {
  return products
    .filter((p) => (p.discountPercent ?? 0) >= BIG_DISCOUNT_PERCENT)
    .slice(0, limit);
}

/** Negocios con envío gratis vs. negocios con descuento en la carta. */
export function splitBusinessOffers(businesses: OfferBusiness[]): {
  freeDelivery: OfferBusiness[];
  discounted: OfferBusiness[];
} {
  return {
    freeDelivery: businesses.filter((b) => b.offer.kind === 'free_delivery'),
    discounted: businesses.filter((b) => b.offer.kind === 'discount'),
  };
}
