/**
 * Destino de navegación externa (Google Maps) para el domiciliario.
 *
 * Centraliza dos cosas que antes vivían duplicadas e inconsistentes entre
 * `order/[id].tsx` y `(tabs)/orders.tsx`: qué endpoint de Maps se abre y
 * cómo se extraen lat/lng de un punto GeoJSON. Las dos pantallas mandan al
 * mismo sitio con las mismas reglas.
 */

export interface GeoPointLike {
  /** GeoJSON: `[lng, lat]`, en ese orden — nunca al revés. */
  coordinates?: number[];
}

/** Extrae `{lat, lng}` de un punto GeoJSON `{coordinates: [lng, lat]}`. */
export function geoPointToLatLng(point?: GeoPointLike | null): { lat?: number; lng?: number } {
  const [lng, lat] = point?.coordinates ?? [];
  return { lat, lng };
}

/**
 * Enlace de Google Maps que abre direcciones de manejo hacia un destino.
 *
 * Antes se usaba `/maps/search/`, la API de búsqueda: solo centra un
 * marcador y el domiciliario tenía que tocar "Cómo llegar" una vez dentro
 * de la app. `/maps/dir/` con `travelmode=driving` arranca la navegación
 * turn-by-turn directamente.
 *
 * Con coordenadas válidas el destino es "lat,lng" — más preciso que un
 * texto que Google tiene que geocodificar primero. Sin ellas (negocio o
 * pedido sin ubicación registrada), cae a la dirección en texto: sigue
 * abriendo el mismo punto, solo que Google lo busca por su cuenta.
 */
export function buildDirectionsUrl(address?: string, lat?: number, lng?: number): string {
  const hasCoords = typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0);
  const destination = hasCoords ? `${lat},${lng}` : encodeURIComponent(address ?? '');
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}
