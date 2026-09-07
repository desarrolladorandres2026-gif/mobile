import { config } from '../config';
import { haversineKm, haversineMeters, LatLng } from '../utils/geo';

/**
 * Cliente de las APIs de navegación de Mapbox.
 *
 * Vive en el servidor y no en el teléfono por tres razones concretas:
 *
 * 1. El token no se reparte más de lo necesario. La app necesita el token
 *    para pintar tiles, pero no para pedir rutas.
 * 2. Una ruta se calcula una vez y la ven el cliente, el repartidor y el
 *    panel admin. Desde el teléfono se calcularía tres veces y se pagaría
 *    tres veces.
 * 3. El caché existe. Mapbox cobra por petición; una ruta urbana no cambia
 *    de un minuto a otro.
 *
 * Nada de esto puede tumbar una entrega: si Mapbox falla, tarda o no hay
 * token, se devuelve una estimación geométrica marcada como tal y el
 * pedido sigue su curso. Un domicilio no se detiene porque un proveedor de
 * mapas tenga un mal día.
 */

export interface RouteLeg {
  /** LineString GeoJSON con el trazado, listo para pintar en el mapa. */
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceMeters: number;
  durationSeconds: number;
  /**
   * De dónde salió el dato. El cliente lo usa para no prometer un ETA con
   * más precisión de la que tiene: "12 min" cuando viene de Mapbox,
   * "~12 min" cuando es una estimación en línea recta.
   */
  source: 'mapbox' | 'estimate';
}

/**
 * Velocidad media efectiva en ciudad, en km/h.
 *
 * No es la velocidad de la moto: es la de puerta a puerta, ya descontando
 * semáforos, giros y el tiempo de encontrar la dirección. Sale baja a
 * propósito — prometer de menos y llegar antes es un buen día para el
 * cliente; lo contrario es una queja.
 */
const URBAN_SPEED_KMH = 20;

/**
 * Cuánto más larga es la ruta real que la línea recta.
 *
 * En una ciudad con trazado de damero, recorrer una diagonal cuesta
 * aproximadamente su suma en calles. 1.3 es un valor conservador y medido
 * en el que caben las manzanas, los sentidos únicos y los retornos.
 */
const DETOUR_FACTOR = 1.3;

interface CacheEntry {
  value: RouteLeg;
  expiresAt: number;
}

/**
 * Caché en memoria del proceso.
 *
 * Deliberadamente no es Redis: el volumen es pequeño, las rutas caducan en
 * minutos y perderlas al reiniciar no cuesta nada más que unas peticiones
 * extra. Meter una dependencia de infraestructura para esto sería pagar un
 * servicio nuevo para ahorrar céntimos.
 */
const routeCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

/**
 * Redondea las coordenadas a ~110 m para construir la clave de caché.
 *
 * Sin esto el caché nunca acertaría: el repartidor se mueve unos metros
 * entre pings y cada ping generaría una clave nueva. Con 3 decimales, un
 * repartidor avanzando por una avenida reutiliza la misma ruta durante
 * una manzana entera, que es justo lo que se quiere.
 */
function cacheKey(from: LatLng, to: LatLng, profile: string): string {
  const r = (n: number) => n.toFixed(3);
  return `${profile}:${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

function readCache(key: string): RouteLeg | null {
  const hit = routeCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    routeCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key: string, value: RouteLeg): void {
  // Poda simple por inserción: la entrada más antigua sale. Con 500 rutas
  // vivas y un TTL de minutos, no hace falta un LRU de verdad.
  if (routeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = routeCache.keys().next().value;
    if (oldest) routeCache.delete(oldest);
  }
  routeCache.set(key, { value, expiresAt: Date.now() + config.mapbox.routeCacheTtlMs });
}

/**
 * Ruta estimada sin llamar a nadie.
 *
 * Es una recta entre los dos puntos, con la distancia corregida por el
 * factor de rodeo. No sirve para navegar, pero sí para decir cuánto falta
 * y para dibujar una línea que oriente al cliente — que es el 90% de lo
 * que la pantalla de seguimiento necesita.
 */
export function estimateRoute(from: LatLng, to: LatLng): RouteLeg {
  const straightKm = haversineKm(from, to);
  const roadKm = straightKm * DETOUR_FACTOR;

  return {
    geometry: {
      type: 'LineString',
      coordinates: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
    },
    distanceMeters: Math.round(roadKm * 1000),
    durationSeconds: Math.round((roadKm / URBAN_SPEED_KMH) * 3600),
    source: 'estimate',
  };
}

/**
 * Ruta óptima entre dos puntos.
 *
 * Nunca lanza: cualquier fallo —sin token, timeout, cuota agotada, Mapbox
 * caído— devuelve la estimación geométrica. La pantalla que la consume no
 * tiene que saber si hubo un problema; solo mira `source`.
 */
export async function getRoute(
  from: LatLng,
  to: LatLng,
  profile = config.mapbox.directionsProfile
): Promise<RouteLeg> {
  if (!config.mapbox.enabled) return estimateRoute(from, to);

  const key = cacheKey(from, to, profile);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}` +
      `?geometries=geojson&overview=full&steps=false` +
      `&access_token=${encodeURIComponent(config.mapbox.accessToken)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(config.mapbox.timeoutMs),
    });

    if (!response.ok) throw new Error(`Mapbox respondió ${response.status}`);

    const data = (await response.json()) as {
      routes?: Array<{
        distance: number;
        duration: number;
        geometry: { type: 'LineString'; coordinates: [number, number][] };
      }>;
    };

    const route = data.routes?.[0];
    // Sin ruta no es un error del servidor: pasa cuando el destino está en
    // una isla peatonal o fuera de la red vial. La estimación sigue siendo
    // útil, así que se devuelve en vez de romper.
    if (!route?.geometry) return estimateRoute(from, to);

    const leg: RouteLeg = {
      geometry: route.geometry,
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration),
      source: 'mapbox',
    };

    writeCache(key, leg);
    return leg;
  } catch (error) {
    // Se registra una vez y se sigue. Que Mapbox falle es un problema
    // operativo, no una razón para dejar de mostrar dónde va el pedido.
    if (config.isDev) {
      console.warn('[Mapbox] Ruta no disponible, usando estimación:', (error as Error).message);
    }
    return estimateRoute(from, to);
  }
}

export interface DurationToPoint {
  /** Índice del origen en el array que se pasó. Mapbox conserva el orden. */
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  source: 'mapbox' | 'estimate';
}

/**
 * Tiempo de viaje desde varios orígenes hasta un mismo destino.
 *
 * Es la pieza que convierte "el repartidor más cercano en línea recta" en
 * "el repartidor que llega antes", que no son el mismo. El más cercano
 * puede estar al otro lado de un río, de una vía férrea o de una avenida
 * sin retorno a 400 m; el segundo más cercano llega diez minutos antes.
 *
 * La Matrix API de Mapbox admite 25 coordenadas por petición, así que la
 * lista de candidatos se recorta antes con la consulta `$near` de MongoDB
 * —que usa el índice `2dsphere` que ya existe en `Driver`— y solo los
 * finalistas llegan hasta aquí.
 */
export async function getDurationsToPoint(
  origins: LatLng[],
  destination: LatLng,
  profile = config.mapbox.directionsProfile
): Promise<DurationToPoint[]> {
  const estimateAll = (): DurationToPoint[] =>
    origins.map((origin, index) => {
      const leg = estimateRoute(origin, destination);
      return {
        index,
        distanceMeters: leg.distanceMeters,
        durationSeconds: leg.durationSeconds,
        source: 'estimate' as const,
      };
    });

  if (!config.mapbox.enabled || origins.length === 0) return estimateAll();

  // 25 coordenadas por petición es el límite de Mapbox, y el destino ocupa
  // una. Pasarse hace que la API devuelva 422 para toda la petición.
  const MAX_COORDINATES = 25;
  if (origins.length > MAX_COORDINATES - 1) {
    origins = origins.slice(0, MAX_COORDINATES - 1);
  }

  try {
    const points = [...origins, destination]
      .map((p) => `${p.lng},${p.lat}`)
      .join(';');
    const destinationIndex = origins.length;
    const sourceIndexes = origins.map((_, i) => i).join(';');

    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${points}` +
      `?sources=${sourceIndexes}&destinations=${destinationIndex}` +
      `&annotations=duration,distance` +
      `&access_token=${encodeURIComponent(config.mapbox.accessToken)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(config.mapbox.timeoutMs),
    });
    if (!response.ok) throw new Error(`Mapbox Matrix respondió ${response.status}`);

    const data = (await response.json()) as {
      durations?: (number | null)[][];
      distances?: (number | null)[][];
    };

    if (!data.durations) return estimateAll();

    return origins.map((origin, index) => {
      const duration = data.durations?.[index]?.[0];
      const distance = data.distances?.[index]?.[0];

      // Un `null` significa que Mapbox no encontró camino entre ese origen
      // y el destino. Ese candidato concreto cae a estimación; los demás
      // conservan su dato real.
      if (duration == null) {
        const leg = estimateRoute(origin, destination);
        return {
          index,
          distanceMeters: leg.distanceMeters,
          durationSeconds: leg.durationSeconds,
          source: 'estimate' as const,
        };
      }

      return {
        index,
        durationSeconds: Math.round(duration),
        distanceMeters:
          distance != null ? Math.round(distance) : haversineMeters(origin, destination),
        source: 'mapbox' as const,
      };
    });
  } catch (error) {
    if (config.isDev) {
      console.warn('[Mapbox] Matrix no disponible, usando estimación:', (error as Error).message);
    }
    return estimateAll();
  }
}

// ── Geocodificación inversa ───────────────────────────────────────────

export interface GeocodedPlace {
  /**
   * Línea principal, lista para el campo "Dirección".
   *
   * Es lo mejor que Mapbox sabe del punto: idealmente calle y número, y si
   * no, la vía o el barrio. Nunca es la palabra final — quien la reciba
   * tiene que poder corregirla, porque en un municipio pequeño el número
   * de la casa a menudo simplemente no está cartografiado.
   */
  address: string;
  /** Barrio o vereda, cuando Mapbox lo conoce. */
  neighborhood?: string;
  /** Municipio. */
  city?: string;
  /** La cadena completa de Mapbox, contexto incluido. */
  full: string;
  /** Qué tan fino es el resultado. La app avisa cuando no es 'address'. */
  precision: 'address' | 'street' | 'area';
}

interface GeocodeCacheEntry {
  value: GeocodedPlace | null;
  expiresAt: number;
}

const geocodeCache = new Map<string, GeocodeCacheEntry>();
const MAX_GEOCODE_ENTRIES = 1000;

/**
 * Clave de caché con ~11 m de resolución (4 decimales).
 *
 * Más grueso que el de las rutas a propósito. Allí 3 decimales (110 m)
 * eran justo lo que se quería, porque una ruta que sirve para una manzana
 * sirve para toda la manzana. Aquí 110 m devolvería la dirección del
 * vecino de enfrente, que es exactamente el error que hace que el
 * domiciliario toque el timbre equivocado.
 */
function geocodeKey(point: LatLng): string {
  return `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
}

/**
 * Qué dirección hay en un punto del mapa.
 *
 * Existe para que marcar el punto en el mapa sea suficiente y nadie tenga
 * que escribir su propia dirección a mano después de haberla señalado —
 * decir dos veces el mismo dato es también dos oportunidades de que no
 * coincidan.
 *
 * Devuelve `null` en vez de lanzar cuando no hay token, Mapbox falla o el
 * punto cae donde no hay nada cartografiado. Ninguno de esos casos puede
 * impedir guardar una dirección: la coordenada, que es lo que de verdad
 * decide el envío y el destino, ya la tiene la app.
 *
 * Los fallos también se cachean. Un punto en mitad del monte va a seguir
 * sin tener dirección dentro de un minuto, y sin esto cada arrastre
 * repetido sobre esa zona pagaría otra petición para recibir la misma
 * nada.
 */
export async function reverseGeocode(point: LatLng): Promise<GeocodedPlace | null> {
  if (!config.mapbox.enabled) return null;

  const key = geocodeKey(point);
  const hit = geocodeCache.get(key);
  if (hit && hit.expiresAt >= Date.now()) return hit.value;
  if (hit) geocodeCache.delete(key);

  let place: GeocodedPlace | null = null;

  try {
    const url =
      `https://api.mapbox.com/search/geocode/v6/reverse` +
      `?longitude=${encodeURIComponent(point.lng)}&latitude=${encodeURIComponent(point.lat)}` +
      `&language=es&limit=1` +
      `&access_token=${encodeURIComponent(config.mapbox.accessToken)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(config.mapbox.timeoutMs),
    });
    if (!response.ok) throw new Error(`Mapbox Geocoding respondió ${response.status}`);

    const data = (await response.json()) as {
      features?: Array<{
        properties?: {
          feature_type?: string;
          name?: string;
          full_address?: string;
          place_formatted?: string;
          context?: Record<string, { name?: string; street_name?: string; address_number?: string }>;
        };
      }>;
    };

    place = toPlace(data.features?.[0]?.properties);
  } catch (error) {
    if (config.isDev) {
      console.warn('[Mapbox] Geocodificación no disponible:', (error as Error).message);
    }
    place = null;
  }

  if (geocodeCache.size >= MAX_GEOCODE_ENTRIES) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, {
    value: place,
    expiresAt: Date.now() + config.mapbox.geocodeCacheTtlMs,
  });

  return place;
}

/**
 * Traduce una feature de Mapbox a lo que el formulario necesita.
 *
 * Se prefiere `name` sobre `full_address` para el campo de dirección
 * porque `full_address` arrastra municipio, departamento y país. Alguien
 * que está guardando la dirección de su casa no escribe "…, Colombia" al
 * final, y dejarlo obligaría a borrarlo a mano cada vez.
 */
function toPlace(
  props:
    | {
        feature_type?: string;
        name?: string;
        full_address?: string;
        place_formatted?: string;
        context?: Record<string, { name?: string; street_name?: string; address_number?: string }>;
      }
    | undefined
): GeocodedPlace | null {
  if (!props) return null;

  const context = props.context ?? {};
  const address = props.name?.trim() || context.street?.name?.trim() || '';
  if (!address) return null;

  const type = props.feature_type;
  const precision: GeocodedPlace['precision'] =
    type === 'address' ? 'address' : type === 'street' ? 'street' : 'area';

  return {
    address,
    neighborhood: context.neighborhood?.name || undefined,
    city: context.place?.name || undefined,
    full: props.full_address?.trim() || [address, props.place_formatted].filter(Boolean).join(', '),
    precision,
  };
}

/** Vacía los cachés del servicio. Solo lo usan las pruebas. */
export function clearRouteCache(): void {
  routeCache.clear();
  geocodeCache.clear();
}
