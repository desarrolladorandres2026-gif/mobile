import { fromGeoPoint, haversineMeters, LatLng } from './geo';
import { effectiveFreeDeliveryThreshold } from './freeDeliveryWindow';
import { config as envConfig } from '../config';

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
export const VISIBLE_BUSINESS = {
  isActive: true,
  isApproved: true,
  isArchived: { $ne: true },
  isSuspended: { $ne: true },
};

/**
 * Campos seguros para servir sin sesión: sin `commissionRate(Bps)` ni
 * `ownerId` (S1). Lista blanca, no lista negra — un campo nuevo del modelo
 * no se cuela aquí por accidente. Compartida por `business.service.ts`,
 * `search.service.ts`, `offers.service.ts` y `favorite.service.ts` (A2):
 * un negocio no puede ser visible en una ruta y filtrado en otra.
 */
export const PUBLIC_BUSINESS_FIELDS =
  'name slug description logo coverImage brandColor category address phone ' +
  'rating totalReviews deliveryTime minOrder freeDeliveryThreshold ' +
  'freeDeliveryValidFrom freeDeliveryValidUntil freeDeliveryValidDays ' +
  'freeDeliveryValidFromTime freeDeliveryValidUntilTime ' +
  'showPromoBanner schedule city isActive location';

/** El listado público lleva además `isFeatured`, que la app usa para ordenar y marcar. */
export const PUBLIC_LIST_FIELDS = `${PUBLIC_BUSINESS_FIELDS} isFeatured`;
export const PUBLIC_LIST_PROJECTION: Record<string, 1> = Object.fromEntries(
  PUBLIC_LIST_FIELDS.split(' ').map((field) => [field, 1])
);

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

/**
 * Resuelve `freeDeliveryThreshold` a su valor vigente ahora mismo (0 si
 * está fuera de su ventana de fecha/horario) y quita del objeto los cinco
 * campos crudos de vigencia — el cliente nunca necesita saber cuándo
 * empieza o termina, solo si aplica ahora. `PUBLIC_BUSINESS_FIELDS` los
 * trae porque hace falta leerlos para este cálculo, no para exponerlos.
 */
export function withEffectiveFreeDelivery<T extends Record<string, any>>(row: T): T {
  const threshold = effectiveFreeDeliveryThreshold(
    row as any,
    new Date(),
    envConfig.settlement.timezone
  );
  const {
    freeDeliveryValidFrom,
    freeDeliveryValidUntil,
    freeDeliveryValidDays,
    freeDeliveryValidFromTime,
    freeDeliveryValidUntilTime,
    ...rest
  } = row;
  return { ...rest, freeDeliveryThreshold: threshold } as unknown as T;
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
