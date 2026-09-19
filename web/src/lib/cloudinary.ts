/**
 * La misma foto de Cloudinary, al ancho que de verdad se pinta.
 *
 * El logo y la portada de un comercio se guardan a 512 y 1600 px. La
 * tarjeta compartida pinta el logo a 80 px y la portada a lo ancho de un
 * teléfono: pedir el original es descargar varias veces los bytes que se
 * ven. Cloudinary redimensiona por URL (`c_limit` nunca agranda) y
 * `f_auto` entrega WebP/AVIF a quien lo acepta.
 *
 * Una URL que no es de Cloudinary se devuelve tal cual.
 */
export function sizedImage<T extends string | null | undefined>(url: T, width: number): T {
  if (!url || !url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
  return url.replace('/image/upload/', `/image/upload/c_limit,w_${Math.round(width)},q_auto,f_auto/`) as T;
}
