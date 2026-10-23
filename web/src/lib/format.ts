/** "$ 25.900": pesos enteros, punto de miles, sin decimales. Manual porque `es` no agrupa los números de 4 cifras. */
export const money = (value: number) =>
  `$ ${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/** Misma lista que `mobile/constants/config.ts` — BUSINESS_CATEGORIES. */
export const CATEGORIES = [
  { key: 'restaurant', label: 'Restaurantes' },
  { key: 'fast_food', label: 'Comidas rápidas' },
  { key: 'pharmacy', label: 'Droguerías' },
  { key: 'cafe', label: 'Cafeterías' },
  { key: 'supermarket', label: 'Mercados' },
] as const;

export const categoryLabel = (key: string) =>
  CATEGORIES.find((c) => c.key === key)?.label ?? key;

/** Estrellas en texto: "4,5 (12)". Sin reseñas no hay nada que mostrar. */
export const ratingText = (rating: number, reviews: number) =>
  reviews > 0 ? `${rating.toFixed(1).replace('.', ',')} (${reviews})` : null;

/** Condición de envío gratis, solo si hoy aplica. */
export const freeDeliveryText = (threshold: number, show: boolean) =>
  show && threshold > 0 ? `Envío gratis desde ${money(threshold)}` : null;
