import { money } from './format';
import type {
  CouponAvailability, CouponEligibility, OfferBusiness, OfferCoupon, ProductSearchHit,
} from '../services/endpoints';

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
 * El cupón que merece el spotlight de arriba: el primero que manda el servidor.
 *
 * `rankCoupons()` del backend ya ordena ponderando quién financia cada cupón
 * (dato que `publicView` oculta a propósito) y pone primero lo urgente. Volver
 * a ordenar aquí por valor nominal deshacía eso y elegía siempre el cupón que
 * más le cuesta a ZIPP. Quien llama debe pasar la lista sin reordenar.
 */
export function pickSpotlightCoupon(coupons: OfferCoupon[]): OfferCoupon | null {
  return coupons[0] ?? null;
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

// ── Estado de un cupón, visto desde quien lo mira ──

/**
 * En qué punto está un cupón para esta persona en este momento.
 *
 * Son dos informaciones que llegan por caminos distintos y hay que juntar:
 * el horario lo decide el servidor igual para todo el mundo (viaja en
 * `/offers`, que se cachea), y "ya lo gastaste" solo se sabe preguntando
 * por ti (`/coupons/eligibility`). Cada una por su lado no basta para saber
 * qué ofrecerle a alguien.
 */
export type CouponStatusKind =
  | 'active'
  | 'scheduled'
  | 'used'
  | 'not_first_order'
  | 'unavailable';

export interface CouponStatus {
  kind: CouponStatusKind;
  /** ISO. Cuándo vuelve a abrir, si está `scheduled`. */
  opensAt?: string;
  /** ISO. Cuándo cierra la franja de hoy, si está activo dentro de una. */
  closesAt?: string;
  window?: CouponAvailability['window'];
}

export type EligibilityIndex = Map<string, CouponEligibility>;

/** Índice por id, para consultar la elegibilidad cupón a cupón sin recorrer. */
export function indexEligibility(rows: CouponEligibility[] | undefined): EligibilityIndex {
  return new Map((rows ?? []).map((row) => [row.couponId, row]));
}

/**
 * El estado de un cupón, con lo personal por delante.
 *
 * Que ya lo gastaste manda sobre el horario: decirle a alguien "abre a las
 * 6" de un cupón que nunca va a poder volver a usar es mandarlo a esperar
 * para nada.
 */
export function couponStatus(coupon: OfferCoupon, eligibility?: EligibilityIndex): CouponStatus {
  const mine = eligibility?.get(coupon._id);

  if (mine && !mine.usable) {
    if (mine.reason === 'already_used') return { kind: 'used' };
    if (mine.reason === 'not_first_order') return { kind: 'not_first_order' };
    return { kind: 'unavailable' };
  }

  const availability = coupon.availability;
  if (!availability) return { kind: 'active' };

  if (availability.state === 'exhausted') return { kind: 'unavailable' };

  if (availability.state === 'scheduled') {
    return {
      kind: 'scheduled',
      opensAt: availability.nextOpensAt,
      window: availability.window,
    };
  }

  return {
    kind: 'active',
    closesAt: availability.closesAt,
    window: availability.window,
  };
}

/** Si el cupón se puede usar ahora mismo. */
export function isUsable(status: CouponStatus): boolean {
  return status.kind === 'active';
}

const DAY_INITIALS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/**
 * La franja horaria escrita para leerse de un vistazo.
 *
 * Los días solo se nombran si el cupón no sirve todos: "11:00 a 13:00" ya
 * lo dice todo cuando es a diario, y añadirle "L M X J V S D" sería ruido.
 */
export function windowLabel(window: CouponAvailability['window']): string {
  if (!window) return '';
  const hours = `${window.from} a ${window.to}`;
  if (!window.days.length || window.days.length === 7) return hours;
  return `${window.days.map((d) => DAY_INITIALS[d]).join(' ')} · ${hours}`;
}

/**
 * Quita el envío gratis a quien ya lo tiene por ser Zipp Pro: el cupón no le
 * ahorra nada y destacarlo sería prometer un ahorro que no existe. Se filtra
 * en el cliente porque `/offers` se sirve de una caché compartida por zona.
 * Conserva el orden del servidor.
 */
export function withoutRedundantFreeDelivery(
  coupons: OfferCoupon[],
  hasProFreeDelivery: boolean
): OfferCoupon[] {
  return hasProFreeDelivery ? coupons.filter((c) => c.type !== 'free_delivery') : coupons;
}

/** Los cupones con horario, que son los que se anuncian como "Horas Zipp". */
export function scheduledCoupons(coupons: OfferCoupon[]): OfferCoupon[] {
  return coupons.filter((c) => !!c.availability?.window);
}

// ── Filtros de la pestaña ──

export type OfferFilter = 'all' | 'coupons' | 'products' | 'free_delivery';

export const OFFER_FILTERS: Array<{ key: OfferFilter; label: string }> = [
  { key: 'all', label: 'Todo' },
  { key: 'coupons', label: 'Cupones' },
  { key: 'products', label: 'Platos' },
  { key: 'free_delivery', label: 'Envío gratis' },
];

// ── Lo que promete un cupón ──

/**
 * El descuento partido en dos: el número y su letra pequeña.
 *
 * La pantalla se llama Descuentos y hasta ahora el dato más buscado —cuánto
 * ahorro— se pintaba como una frase del mismo tamaño que el título del
 * cupón. Separarlos deja poner la magnitud en grande, que es lo único que
 * alguien necesita leer para decidir si sigue mirando.
 *
 * `qualifier` va vacío cuando no añade nada: "25%" ya se entiende sin un
 * "de descuento" debajo ocupando una línea.
 */
export function couponMagnitude(coupon: {
  type: string;
  value: number;
  maxDiscount?: number;
}): { value: string; qualifier: string } {
  if (coupon.type === 'free_delivery') return { value: 'Envío $0', qualifier: '' };

  if (coupon.type === 'percentage') {
    return {
      value: `${coupon.value}%`,
      qualifier: coupon.maxDiscount && coupon.maxDiscount > 0
        ? `hasta ${money(coupon.maxDiscount)}`
        : '',
    };
  }

  // El servidor ya manda el techo efectivo: un monto fijo nunca paga más que él.
  const capped = coupon.maxDiscount && coupon.maxDiscount > 0
    ? Math.min(coupon.value, coupon.maxDiscount)
    : coupon.value;
  return { value: money(capped), qualifier: '' };
}

/**
 * El mismo beneficio en una sola frase.
 *
 * Para leerlo de corrido: lectores de pantalla y cualquier sitio donde no
 * quepa la magnitud en grande. Sale de `couponMagnitude` para que las dos
 * formas nunca puedan decir cosas distintas.
 */
export function couponBenefit(coupon: {
  type: string;
  value: number;
  maxDiscount?: number;
}): string {
  const { value, qualifier } = couponMagnitude(coupon);
  if (coupon.type === 'free_delivery') return 'Envío gratis';
  return qualifier ? `${value} ${qualifier}` : `${value} de descuento`;
}
