const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Distancia en metros entre dos puntos.
 *
 * Duplica a propósito la fórmula que el backend tiene en `utils/geo.ts`.
 * Podría pedirse al servidor, pero esto se ejecuta en cada posición del
 * GPS para saber si el repartidor se salió de la ruta: hacer una petición
 * de red para responder a una pregunta de aritmética sería gastar datos y
 * batería del repartidor —y añadir latencia— justo mientras conduce.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Cuánto se ha salido el repartidor del trazado, en metros.
 *
 * Mide contra el punto más cercano de la ruta, no contra el destino. Es la
 * diferencia entre detectar un desvío real y molestar a alguien que está
 * rodeando una manzana para tomar el sentido correcto: ese se aleja del
 * destino durante medio minuto sin salirse de la ruta ni un metro.
 */
export function distanceToRoute(
  point: LatLng,
  coordinates: [number, number][] | undefined
): number | null {
  if (!coordinates?.length) return null;

  let min = Infinity;
  for (const [lng, lat] of coordinates) {
    const distance = haversineMeters(point, { lat, lng });
    if (distance < min) min = distance;
  }
  return min;
}
