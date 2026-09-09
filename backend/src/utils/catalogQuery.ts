import { fromGeoPoint, haversineMeters, LatLng } from './geo';

/**
 * Las piezas que comparten búsqueda y ofertas.
 *
 * Las dos consultas hacen lo mismo con distinta pregunta: recortan el
 * catálogo a lo que un cliente puede comprar, lo acotan a un radio y le
 * cuelgan la distancia a cada fila. Vivían dentro de `search.service.ts`
 * porque no había un segundo consumidor; ahora que lo hay, duplicarlas
 * significaría que un negocio pueda ser invisible en la búsqueda y visible
 * en las ofertas, o que el radio mida distinto en cada pantalla.
 */

/** Radio terrestre en metros, para pasar una distancia a radianes. */
export const EARTH_RADIUS_M = 6_378_100;

/**
 * Solo el catálogo que un cliente puede comprar.
 *
 * Un negocio inactivo o sin aprobar no aparece aunque sus productos
 * encajen: enseñarlo lleva a una carta que no se puede pedir, y el usuario
 * culpa a la aplicación, no al estado del comercio.
 */
export const VISIBLE_BUSINESS = { isActive: true, isApproved: true };

/**
 * El filtro de radio, como cláusula de consulta y no como etapa.
 *
 * `$geoWithin` es la pieza que hace posible todo esto: a diferencia de
 * `$geoNear`, es un operador normal, así que cabe dentro del mismo `$match`
 * que el `$text` y deja la paginación exacta —el recorte lo hace la base y
 * no un filtro posterior, que dejaría páginas con huecos.
 */
export function withinRadius(coords: LatLng | null, maxDistance: number) {
  if (!coords) return {};
  return {
    location: {
      $geoWithin: {
        $centerSphere: [[coords.lng, coords.lat], maxDistance / EARTH_RADIUS_M],
      },
    },
  };
}

/** Adjunta la distancia real a cada fila que tenga ubicación utilizable. */
export function withDistance<T extends Record<string, any>>(
  rows: T[],
  from: LatLng | null,
  field: string
): (T & { distanceMeters?: number })[] {
  if (!from) return rows;

  return rows.map((row) => {
    const point = fromGeoPoint(row[field]);
    if (!point) return row;
    return { ...row, distanceMeters: haversineMeters(from, point) };
  });
}
