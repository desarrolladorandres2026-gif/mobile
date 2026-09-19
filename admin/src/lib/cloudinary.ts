/**
 * La misma foto de Cloudinary, al ancho que de verdad se pinta.
 *
 * Las listas del panel pintan banners, categorías y flyers en miniatura:
 * pedir el original es descargar varias veces los bytes que se ven. Cloudinary redimensiona por URL (`c_limit` nunca agranda) y
 * `f_auto` entrega WebP/AVIF a quien lo acepta.
 *
 * Una URL que no es de Cloudinary se devuelve tal cual. No sirve para las
 * evidencias de entrega: van firmadas y cambiar la URL rompe la firma.
 */
export function sizedImage<T extends string | null | undefined>(url: T, width: number): T {
  if (!url || !url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
  return url.replace('/image/upload/', `/image/upload/c_limit,w_${Math.round(width)},q_auto,f_auto/`) as T;
}
