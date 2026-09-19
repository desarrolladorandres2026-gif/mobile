import { Dimensions, PixelRatio } from 'react-native';

/**
 * La foto de Cloudinary al ancho al que de verdad se pinta.
 *
 * El logo y la portada de un comercio se guardan a 512 y 1600 px y se
 * pintaban tal cual: una portada de 195 pt en el carrusel del Inicio bajaba
 * los 1600 px enteros, tres o cuatro veces los bytes que se ven, con datos
 * móviles y veinte tarjetas a la vez. Cloudinary redimensiona por URL
 * (`c_limit` nunca agranda) y `f_auto` entrega WebP/AVIF.
 *
 * El ancho se redondea hacia arriba a unos pocos escalones: así pantallas
 * parecidas piden la misma URL y comparten la caché del CDN y la del
 * teléfono, en vez de una variante por cada tamaño exacto.
 *
 * Las fotos de producto no pasan por aquí: ya traen sus variantes
 * calculadas del servidor (`lib/productImage.ts`).
 */
const STEPS = [160, 320, 480, 640, 960, 1280, 1600];

export function sizedImageUri(url: string | null | undefined, widthPt: number): string | undefined {
  if (!url) return undefined;
  if (!url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
  const px = Math.ceil(widthPt * Math.min(PixelRatio.get(), 3));
  const width = STEPS.find((step) => step >= px) ?? STEPS[STEPS.length - 1];
  return url.replace('/image/upload/', `/image/upload/c_limit,w_${width},q_auto,f_auto/`);
}

/** El ancho de la ventana, para portadas que van de lado a lado. */
export const screenWidth = () => Dimensions.get('window').width;
