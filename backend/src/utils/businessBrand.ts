/**
 * Los colores con los que un comercio puede vestir su encabezado.
 *
 * Es una lista cerrada y no un selector libre a propósito. El cliente ve
 * cincuenta fichas distintas en una misma sesión, y basta con que dos o
 * tres comercios elijan un amarillo flúor para que el catálogo entero
 * parezca un tablón de anuncios. Todos estos tonos están comprobados
 * contra texto blanco, así que ningún nombre de negocio puede quedar
 * ilegible sobre el suyo.
 *
 * Solo se usan cuando el comercio **no** subió portada: con foto, el color
 * no se ve. Es el respaldo digno, no una capa de marca sobre la imagen.
 */
export const BUSINESS_BRAND_COLORS = [
  '#141B2A', // Obsidiana
  '#8A5D08', // Dorado titanio
  '#7A1F35', // Vino
  '#14532D', // Bosque
  '#123A5E', // Marino
  '#8C3B1E', // Terracota
  '#4C2A57', // Berenjena
  '#3F3F46', // Carbón
] as const;

export type BusinessBrandColor = (typeof BUSINESS_BRAND_COLORS)[number];

export const isBusinessBrandColor = (value: unknown): value is BusinessBrandColor =>
  typeof value === 'string' && (BUSINESS_BRAND_COLORS as readonly string[]).includes(value);
