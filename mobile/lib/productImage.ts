/**
 * Qué versión de la foto de un producto pedir.
 *
 * El servidor devuelve cuatro tamaños ya calculados en `product.images`.
 * Elegir el que toca no es una optimización cosmética: la miniatura de la
 * lista mide 84 pt y servirle la variante de catálogo significa descargar
 * cuatro veces más bytes por fila, con datos móviles, en la pantalla que
 * más productos muestra a la vez.
 *
 * `product.image` sigue funcionando como respaldo. Es lo que tienen los
 * productos anteriores a este sistema, y una app instalada no puede
 * quedarse sin fotos porque el backend cambiara de forma.
 */

export interface ProductImages {
  thumb: string;
  catalog: string;
  detail: string;
  large: string;
  placeholder: string;
  width: number;
  height: number;
}

export interface WithProductImage {
  image?: string;
  images?: ProductImages | null;
  /** Fotos adicionales de la ficha. La principal no está aquí. */
  galleryImages?: ProductImages[] | null;
}

export type ProductImageSize = keyof Pick<
  ProductImages,
  'thumb' | 'catalog' | 'detail' | 'large'
>;

/** La URL de la variante pedida, o la antigua si el producto no las tiene. */
export function productImageUri(
  product: WithProductImage | null | undefined,
  size: ProductImageSize = 'catalog'
): string | null {
  if (!product) return null;
  return product.images?.[size] ?? product.image ?? null;
}

/**
 * Miniatura borrosa para el hueco mientras carga.
 *
 * `expo-image` la pinta en el mismo sitio y con los colores reales de la
 * foto, así que la lista no parpadea en gris. Devuelve `undefined` —y no
 * `null`— porque es lo que espera la prop `placeholder`.
 */
export function productImagePlaceholder(
  product: WithProductImage | null | undefined
): { uri: string } | undefined {
  const uri = product?.images?.placeholder;
  return uri ? { uri } : undefined;
}

/**
 * Lo que se pinta mientras llega una variante grande: la del escalón de
 * abajo.
 *
 * A la ficha se llega tocando una tarjeta que ya pintó `catalog`, y al
 * visor desde la ficha, que ya pintó `detail`: las dos están en la caché
 * del teléfono y salen al instante y nítidas, no borrosas. Sin variantes
 * (productos anteriores al sistema) queda la miniatura borrosa.
 */
export function productImageStepDown(
  product: WithProductImage | null | undefined,
  size: 'detail' | 'large'
): { uri: string } | undefined {
  const uri = product?.images?.[size === 'large' ? 'detail' : 'catalog'];
  return uri ? { uri } : productImagePlaceholder(product);
}

/** Si hay algo que pintar, sin importar de qué generación venga. */
export function hasProductImage(product: WithProductImage | null | undefined): boolean {
  return Boolean(product?.images?.catalog || product?.image);
}

/**
 * Todas las fotos de un producto, en orden, para el visor.
 *
 * La principal va primera y siempre: es la que el cliente tocó para abrir
 * el visor, así que empezar por otra sería cambiarle la foto debajo del
 * dedo. Las adicionales van detrás, en el orden en que el comercio las
 * subió.
 */
export function productGallery(
  product: WithProductImage | null | undefined
): ProductImages[] {
  if (!product?.images) return [];
  return [product.images, ...(product.galleryImages ?? [])];
}
