import { Types } from 'mongoose';
import { Driver, DriverLocation, Order, Business, IOrder } from '../models';
import { DriverStatus, OrderStatus, UserRole } from '../types';
import { config } from '../config';
import { AppError } from '../middlewares/errorHandler';
import { haversineMeters, isValidCoordinate, fromGeoPoint, LatLng } from '../utils/geo';
import { getRoute, getDurationsToPoint, RouteLeg } from './mapbox.service';
import { resolveOrderAccess } from './orderAccess.service';
import { antiFraudService, FraudAlertType } from '../security';

/**
 * Seguimiento en vivo de repartidores.
 *
 * Reparte el trabajo entre tres capas que hoy estaban mezcladas:
 *
 * - `Driver.currentLocation` — dónde está ahora. Se sobrescribe.
 * - `DriverLocation` — por dónde pasó. Solo durante un pedido.
 * - Los sockets — quién se entera. Lo decide `sockets/index.ts`.
 *
 * El objetivo de este archivo es que un ping del GPS cueste lo mínimo:
 * antes de esto, cada fix del teléfono provocaba una escritura por socket
 * *y* otra por REST, sin filtro ninguno. Un repartidor conectado ocho
 * horas eran ~11.500 escrituras al día por persona, la mitad de ellas
 * diciendo que seguía en el mismo semáforo.
 */

// ── Ingesta de posiciones ─────────────────────────────────────────────

export interface LocationPing {
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  batteryLevel?: number;
  isMocked?: boolean;
  /** Momento del fix en el dispositivo. Si falta, se usa la hora de llegada. */
  recordedAt?: Date | string | number;
}

export type PingRejection =
  | 'invalid_coordinates'
  | 'inaccurate'
  | 'throttled'
  | 'not_moved'
  | 'unknown_driver';

export interface PingResult {
  accepted: boolean;
  reason?: PingRejection;
  driverId?: string;
  /** Pedido activo al que pertenece este punto, si lo hay. */
  orderId?: string | null;
  location?: LatLng;
  recordedAt?: Date;
}

/**
 * Estado del último ping aceptado por repartidor.
 *
 * Vive en memoria porque su única función es decidir si vale la pena
 * *tocar* la base de datos: consultarla para averiguarlo anularía el
 * ahorro. Perderlo al reiniciar solo provoca una escritura extra por
 * repartidor, que es exactamente el coste que tiene equivocarse aquí.
 */
interface LastAccepted {
  lat: number;
  lng: number;
  at: number;
}
const lastAccepted = new Map<string, LastAccepted>();

/**
 * Cuánto puede quedarse quieto un repartidor antes de que se escriba igual.
 *
 * Sin este latido, alguien parado almorzando dejaría de escribir y a los
 * 90 s el panel lo daría por "sin señal" aunque su teléfono esté mandando
 * pings perfectos. Estar quieto y estar desconectado no son lo mismo y el
 * mapa no debe confundirlos.
 *
 * Es la mitad servidor de un mecanismo de dos: aquí se *acepta* un ping sin
 * movimiento, pero quien tiene que *enviarlo* es el teléfono. El GPS no
 * entrega fixes cuando el repartidor está quieto —`distanceInterval` los
 * bloquea— así que sin un latido del lado del cliente esta rama no se
 * alcanzaba nunca y el repartidor desaparecía del mapa igual. Por eso el
 * valor viaja a la app en `getMapConfig`: el ritmo lo manda el servidor, no
 * dos constantes que se desincronizan.
 */
export const HEARTBEAT_MS = 30_000;

/**
 * Descarta un ping dejando rastro, en desarrollo.
 *
 * `throttled` y `not_moved` no pasan por aquí: son el caso normal y
 * anunciarlos llenaría la consola. Los que sí pasan son los que significan
 * que *algo está mal configurado* — y esos, al ser silenciosos, producían
 * el peor síntoma posible: el repartidor desaparecía del mapa sin un solo
 * mensaje en ningún log, ni en el teléfono ni en el servidor.
 *
 * Se limita a uno por repartidor cada 30 s. Un teléfono en interiores puede
 * emitir fixes imprecisos en ráfaga, y un aviso por cada uno haría el log
 * inservible justo cuando hace falta leerlo.
 */
const lastLogged = new Map<string, number>();
const REJECT_LOG_INTERVAL_MS = 30_000;

function reject(userId: string, reason: PingRejection, ping: LocationPing): PingResult {
  if (config.isDev) {
    const last = lastLogged.get(userId) ?? 0;
    if (Date.now() - last > REJECT_LOG_INTERVAL_MS) {
      lastLogged.set(userId, Date.now());
      const detail =
        reason === 'inaccurate'
          ? ` (precisión ${ping.accuracy} m, máximo ${config.tracking.maxAccuracyMeters} m — súbelo con TRACKING_MAX_ACCURACY_METERS)`
          : reason === 'invalid_coordinates'
            ? ` (lat ${ping.lat}, lng ${ping.lng})`
            : ' (el usuario no tiene perfil de domiciliario)';
      console.warn(`[Tracking] Ping descartado de ${userId}: ${reason}${detail}`);
    }
  }
  return { accepted: false, reason };
}

/** Une el `Driver` a partir del `User`, con caché corta para no leerlo en cada ping. */
const driverIdCache = new Map<string, { driverId: string; at: number }>();
const DRIVER_CACHE_TTL_MS = 60_000;

async function resolveDriverId(userId: string): Promise<string | null> {
  const cached = driverIdCache.get(userId);
  if (cached && Date.now() - cached.at < DRIVER_CACHE_TTL_MS) return cached.driverId;

  const driver = await Driver.findOne({ userId }).select('_id');
  if (!driver) return null;

  const driverId = driver._id.toString();
  driverIdCache.set(userId, { driverId, at: Date.now() });
  return driverId;
}

/** El pedido que el repartidor está entregando ahora mismo, si hay alguno. */
async function activeOrderIdFor(driverId: string): Promise<string | null> {
  const order = await Order.findOne({
    driverId,
    status: { $in: [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
  })
    .select('_id')
    .sort({ createdAt: -1 });

  return order ? order._id.toString() : null;
}


/**
 * Revisa una posición ya aceptada en busca de señales de manipulación.
 *
 * Los dos detectores existían desde hace tiempo en `security/antifraud.ts`
 * sin que nadie los llamara: la app marcaba `isMocked` y el servidor lo
 * guardaba en cada punto del rastro, pero ese campo no se leía nunca. Un
 * repartidor podía simular el recorrido entero y la bandera quedaba escrita
 * en la base sin que nadie se enterara.
 *
 * Se ejecuta sobre pings aceptados por dos razones: analizar lo que ya se
 * descartó multiplicaría el trabajo sin cambiar ninguna conclusión, y a
 * esta altura ya se sabe que detrás del usuario hay un repartidor real.
 *
 * Nunca interrumpe el seguimiento. Si el antifraude falla, el pedido tiene
 * que seguir viéndose en el mapa: perder la vigilancia es malo, perder la
 * posición del repartidor durante una entrega lo es más. Por eso el error
 * se registra y se traga.
 *
 * Tampoco rechaza la posición sospechosa. Una entrega en curso necesita el
 * punto aunque sea falso —el cliente está mirando el mapa— y descartarlo
 * borraría justamente la evidencia de lo que se quiere demostrar.
 */
async function screenPing(
  userId: string,
  ping: LocationPing,
  previous: LastAccepted | undefined,
  now: number
): Promise<void> {
  try {
    // Una precisión imposiblemente buena delata al simulador, pero el
    // detector lee ese umbral de un número que aquí puede no venir. Sin
    // dato no hay sospecha: mandarle un cero fabricado convertiría "no sé
    // qué precisión tiene" en "precisión perfecta", que es justo la señal
    // que busca.
    const accuracy = typeof ping.accuracy === 'number' ? ping.accuracy : Number.POSITIVE_INFINITY;

    const mock = await antiFraudService.checkMockLocation(
      userId,
      ping.lat,
      ping.lng,
      accuracy,
      ping.isMocked
    );
    if (mock.suspicious && mock.alert) {
      await antiFraudService.raiseAlertOnce({
        ...mock.alert,
        userId,
        type: FraudAlertType.MOCK_LOCATION,
      });
    }

    // El salto se mide contra el último punto *aceptado*, no contra el
    // último recibido: entre ambos hay pings descartados por frecuencia, y
    // usarlos daría intervalos de milisegundos que convierten cualquier
    // movimiento normal en teletransporte.
    if (previous) {
      const seconds = (now - previous.at) / 1000;
      const jump = await antiFraudService.checkLocationVelocity(
        userId,
        ping.lat,
        ping.lng,
        previous.lat,
        previous.lng,
        seconds
      );
      if (jump.suspicious && jump.alert) {
        await antiFraudService.raiseAlertOnce({
          ...jump.alert,
          userId,
          type: FraudAlertType.SUSPICIOUS_LOCATION_CHANGE,
        });
      }
    }
  } catch (err) {
    console.error('[Tracking] Falló la revisión antifraude del ping:', err);
  }
}
/**
 * Recibe una posición del dispositivo y decide qué hacer con ella.
 *
 * Los tres filtros están ordenados de más barato a más caro a propósito:
 * validar coordenadas no cuesta nada, comparar con el último punto es una
 * lectura de un `Map`, y solo lo que sobrevive a ambos llega a MongoDB.
 *
 * Devuelve el resultado en vez de lanzar: un ping descartado es el caso
 * *normal* —la mayoría lo son— y tratarlo como excepción llenaría los logs
 * de ruido y penalizaría el camino más frecuente.
 */
export async function ingestPing(userId: string, ping: LocationPing): Promise<PingResult> {
  if (!isValidCoordinate(ping.lat, ping.lng)) {
    return reject(userId, 'invalid_coordinates', ping);
  }

  // Un fix con 400 m de incertidumbre no dice dónde está el repartidor,
  // dice en qué barrio podría estar. Pintarlo en el mapa haría que el
  // icono saltara entre manzanas y el cliente pensaría que va y viene.
  if (
    typeof ping.accuracy === 'number' &&
    ping.accuracy > config.tracking.maxAccuracyMeters
  ) {
    return reject(userId, 'inaccurate', ping);
  }

  const now = Date.now();
  const previous = lastAccepted.get(userId);

  if (previous) {
    const elapsed = now - previous.at;

    // Tope duro de frecuencia. Protege la base de datos de un cliente mal
    // configurado —o malicioso— que mande a 100 ms.
    if (elapsed < config.tracking.minPersistIntervalMs) {
      return { accepted: false, reason: 'throttled' };
    }


    const moved = haversineMeters(
      { lat: previous.lat, lng: previous.lng },
      { lat: ping.lat, lng: ping.lng }
    );

    // Quieto y con el latido reciente: no hay nada nuevo que contar. El
    // ruido del GPS hace que un teléfono inmóvil "se mueva" unos metros
    // constantemente; sin este filtro se escribiría ese temblor.
    if (moved < config.tracking.minMoveMeters && elapsed < HEARTBEAT_MS) {
      return { accepted: false, reason: 'not_moved' };
    }
  }

  const driverId = await resolveDriverId(userId);
  if (!driverId) return reject(userId, 'unknown_driver', ping);

  const recordedAt = ping.recordedAt ? new Date(ping.recordedAt) : new Date(now);
  const location: LatLng = { lat: ping.lat, lng: ping.lng };

  lastAccepted.set(userId, { lat: ping.lat, lng: ping.lng, at: now });

  await Driver.updateOne(
    { _id: driverId },
    {
      currentLocation: { type: 'Point', coordinates: [ping.lng, ping.lat] },
      lastLocationAt: recordedAt,
      ...(typeof ping.heading === 'number' ? { heading: ping.heading } : {}),
      ...(typeof ping.speed === 'number' ? { speed: ping.speed } : {}),
      ...(typeof ping.accuracy === 'number' ? { locationAccuracy: ping.accuracy } : {}),
      ...(typeof ping.batteryLevel === 'number' ? { batteryLevel: ping.batteryLevel } : {}),
    }
  );

  const orderId = await activeOrderIdFor(driverId);

  // El rastro solo se guarda durante una entrega.
  //
  // Un repartidor conectado sin pedido está trabajando, pero su recorrido
  // no documenta nada: nadie va a reclamar por dónde pasó mientras
  // esperaba. Guardarlo sería acumular el mapa de movimientos de una
  // persona durante meses sin ninguna pregunta que ese dato responda —
  // coste de almacenamiento a cambio de riesgo de privacidad.
  if (orderId) {
    await DriverLocation.create({
      driverId,
      userId,
      orderId,
      location: { type: 'Point', coordinates: [ping.lng, ping.lat] },
      accuracy: ping.accuracy,
      heading: ping.heading,
      speed: ping.speed,
      batteryLevel: ping.batteryLevel,
      isMocked: ping.isMocked ?? false,
      recordedAt,
    });
  }

  await screenPing(userId, ping, previous, now);

  return { accepted: true, driverId, orderId, location, recordedAt };
}

/** Olvida el estado en memoria de un repartidor. Se llama al desconectarse. */
export function forgetDriver(userId: string): void {
  lastAccepted.delete(userId);
  driverIdCache.delete(userId);
  lastLogged.delete(userId);
}

// ── Seguimiento de un pedido ──────────────────────────────────────────

/**
 * Hacia dónde va el repartidor ahora mismo.
 *
 * Un domicilio son dos viajes, no uno, y la pantalla tiene que mostrar el
 * que está ocurriendo. Antes de recoger, la ruta útil es hacia el local;
 * después, hacia el cliente. Dibujar siempre la segunda haría que el
 * cliente viera al repartidor alejándose de él durante la primera mitad
 * del pedido, que es la forma más rápida de generar una llamada a soporte.
 */
export type DeliveryPhase = 'to_business' | 'to_client' | 'idle';

export function deliveryPhase(status: OrderStatus | string): DeliveryPhase {
  switch (status) {
    case OrderStatus.PENDING:
    case OrderStatus.ACCEPTED:
    case OrderStatus.PREPARING:
    case OrderStatus.READY:
      return 'to_business';
    case OrderStatus.PICKED_UP:
    case OrderStatus.ON_WAY:
      return 'to_client';
    default:
      return 'idle';
  }
}

export interface OrderTracking {
  orderId: string;
  status: string;
  phase: DeliveryPhase;
  /** Null mientras no haya repartidor asignado o no haya mandado posición. */
  driver: {
    id: string;
    name: string | null;
    vehicleType: string;
    licensePlate: string | null;
    location: LatLng;
    heading: number | null;
    speed: number | null;
    lastSeenAt: Date | null;
    /** Sin señal reciente: el mapa lo muestra atenuado en vez de mentir. */
    stale: boolean;
  } | null;
  business: { id: string; name: string; location: LatLng | null };
  destination: { address: string; location: LatLng | null };
  /** Ruta de la etapa en curso. Null si falta alguno de los dos extremos. */
  route: RouteLeg | null;
  /** Segundos hasta la entrega, según la etapa actual. */
  etaSeconds: number | null;
  /** Rastro recorrido durante este pedido, para dibujar el avance real. */
  trail: LatLng[];
}

/**
 * Todo lo que una pantalla necesita para dibujar un pedido en el mapa.
 *
 * La autorización no se reimplementa aquí: pasa por `resolveOrderAccess`,
 * la misma función que gobierna el chat, las llamadas y las evidencias.
 * La posición de una persona es dato sensible y no puede depender de que
 * este endpoint se acuerde de comprobar lo mismo que los demás.
 */
export async function getOrderTracking(
  orderId: string,
  user: { _id: Types.ObjectId | string; role: string },
  options: { includeTrail?: boolean } = {}
): Promise<OrderTracking> {
  const { order } = await resolveOrderAccess(orderId, user);

  const [business, driver] = await Promise.all([
    Business.findById(order.businessId).select('name location'),
    order.driverId
      ? Driver.findById(order.driverId)
          .select('currentLocation lastLocationAt heading speed vehicleType licensePlate userId')
          .populate('userId', 'name')
      : null,
  ]);

  const businessLocation = fromGeoPoint(business?.location);
  const destinationLocation = fromGeoPoint(order.deliveryLocation);
  const driverLocation = driver ? fromGeoPoint(driver.currentLocation) : null;

  const phase = deliveryPhase(order.status);
  const lastSeenAt = driver?.lastLocationAt ?? null;
  const stale = lastSeenAt
    ? Date.now() - lastSeenAt.getTime() > config.tracking.staleAfterMs
    : true;

  // El destino de la ruta depende de la etapa, no del pedido.
  const target = phase === 'to_business' ? businessLocation : destinationLocation;

  let route: RouteLeg | null = null;
  if (driverLocation && target && phase !== 'idle') {
    route = await getRoute(driverLocation, target);
  }

  // El ETA suma las dos etapas cuando todavía no ha recogido: al cliente
  // le importa cuándo llega su pedido, no cuándo llega el repartidor al
  // restaurante. Prometer lo segundo sería prometer la mitad del viaje.
  let etaSeconds: number | null = route ? route.durationSeconds : null;
  if (etaSeconds != null && phase === 'to_business' && businessLocation && destinationLocation) {
    const secondLeg = await getRoute(businessLocation, destinationLocation);
    etaSeconds += secondLeg.durationSeconds;
  }

  let trail: LatLng[] = [];
  if (options.includeTrail) {
    const points = await DriverLocation.find({ orderId: order._id })
      .select('location')
      .sort({ recordedAt: 1 })
      .limit(500);
    trail = points
      .map((p) => fromGeoPoint(p.location))
      .filter((p): p is LatLng => p !== null);
  }

  return {
    orderId: order._id.toString(),
    status: order.status,
    phase,
    driver:
      driver && driverLocation
        ? {
            id: driver._id.toString(),
            name: (driver.userId as unknown as { name?: string })?.name ?? null,
            vehicleType: driver.vehicleType,
            licensePlate: driver.licensePlate ?? null,
            location: driverLocation,
            heading: driver.heading ?? null,
            speed: driver.speed ?? null,
            lastSeenAt,
            stale,
          }
        : null,
    // En un mandado, el "origen" es la dirección de recogida que escribió
    // el cliente, no un comercio. El mapa necesita un punto de partida
    // igual: sin él no puede dibujar la primera etapa del viaje.
    business: {
      id: order.businessId ? order.businessId.toString() : '',
      name: business?.name ?? (order.errand ? order.errand.pickupAddress : ''),
      location: businessLocation ?? (order.errand
        ? {
            lat: order.errand.pickupLocation.coordinates[1],
            lng: order.errand.pickupLocation.coordinates[0],
          }
        : null),
    },
    destination: {
      address: order.deliveryAddress,
      location: destinationLocation,
    },
    route,
    etaSeconds,
    trail,
  };
}

// ── Ruta del repartidor ───────────────────────────────────────────────

export interface DriverRoute {
  phase: DeliveryPhase;
  from: LatLng;
  to: LatLng;
  /** Etiqueta de a dónde va, para el encabezado de la pantalla. */
  targetLabel: string;
  targetAddress: string;
  route: RouteLeg;
  /** Metros que el repartidor está desviado del trazado propuesto. */
  offRouteMeters: number | null;
}

/**
 * La ruta que el repartidor debe seguir en la etapa actual.
 *
 * `recalculate` no cambia el cálculo —siempre se rutea desde donde está
 * ahora—; lo que hace es saltarse el caché. Es la diferencia entre "dame
 * la ruta" y "esta ruta ya no me sirve, dame otra": sin esa distinción, un
 * repartidor desviado recibiría durante cinco minutos la misma ruta
 * cacheada que ya no puede seguir.
 */
export async function getDriverRoute(
  orderId: string,
  user: { _id: Types.ObjectId | string; role: string },
  currentLocation?: LatLng
): Promise<DriverRoute> {
  const access = await resolveOrderAccess(orderId, user);
  const { order } = access;

  if (access.participant !== 'driver' && access.participant !== 'admin') {
    throw new AppError('Solo el repartidor asignado puede pedir la ruta de este pedido', 403);
  }

  const phase = deliveryPhase(order.status);
  if (phase === 'idle') {
    throw new AppError('Este pedido ya no está en curso', 409);
  }

  const driver = await Driver.findById(order.driverId).select('currentLocation');
  const from = currentLocation ?? (driver ? fromGeoPoint(driver.currentLocation) : null);
  if (!from) {
    throw new AppError('No tenemos tu ubicación todavía. Activa el GPS y vuelve a intentarlo.', 409);
  }

  const business = await Business.findById(order.businessId).select('name address location');
  const to =
    phase === 'to_business' ? fromGeoPoint(business?.location) : fromGeoPoint(order.deliveryLocation);

  if (!to) {
    throw new AppError(
      phase === 'to_business'
        ? 'El local no tiene coordenadas registradas'
        : 'La dirección de entrega no tiene coordenadas',
      409
    );
  }

  const route = await getRoute(from, to);

  return {
    phase,
    from,
    to,
    targetLabel: phase === 'to_business' ? (business?.name ?? 'El local') : 'Cliente',
    targetAddress: phase === 'to_business' ? (business?.address ?? '') : order.deliveryAddress,
    route,
    offRouteMeters: null,
  };
}

/**
 * Distancia perpendicular de un punto al trazado de una ruta, en metros.
 *
 * Es lo que decide si el repartidor "se salió": comparar contra el punto
 * más cercano del trazado, no contra el destino. Alguien que rodea una
 * manzana para tomar el sentido correcto se acerca poco al destino pero
 * sigue perfectamente sobre la ruta, y no debe recibir un recálculo.
 *
 * Se mide contra los vértices del `LineString`. Mapbox devuelve el trazado
 * lo bastante denso —vértices cada pocos metros en ciudad— para que medir
 * contra vértices y medir contra segmentos den prácticamente lo mismo, y
 * esto se ejecuta por cada ping.
 */
export function distanceToRouteMeters(
  point: LatLng,
  route: { coordinates: [number, number][] }
): number | null {
  if (!route.coordinates?.length) return null;

  let min = Infinity;
  for (const [lng, lat] of route.coordinates) {
    const d = haversineMeters(point, { lat, lng });
    if (d < min) min = d;
  }
  return Math.round(min);
}

// ── Flota en vivo (panel admin) ───────────────────────────────────────

export interface FleetDriver {
  id: string;
  userId: string;
  name: string;
  avatar: string | null;
  phone: string | null;
  status: DriverStatus;
  vehicleType: string;
  licensePlate: string | null;
  location: LatLng | null;
  heading: number | null;
  speed: number | null;
  batteryLevel: number | null;
  lastSeenAt: Date | null;
  stale: boolean;
  activeOrder: { id: string; orderNumber: string; status: string } | null;
}

/**
 * Todos los repartidores que cuentan para la operación, con su estado.
 *
 * Incluye a los `offline` que mandaron posición hace poco a propósito: en
 * el mapa de operaciones importa tanto quién está trabajando como quién
 * acaba de dejar de hacerlo, y un repartidor que desaparece del mapa en el
 * instante en que se desconecta deja al despachador sin saber si terminó
 * su turno o se le murió el teléfono a mitad de una entrega.
 */
export async function getActiveFleet(): Promise<FleetDriver[]> {
  const recentlySeen = new Date(Date.now() - config.tracking.staleAfterMs * 4);

  const drivers = await Driver.find({
    isActive: true,
    $or: [
      { status: { $in: [DriverStatus.AVAILABLE, DriverStatus.BUSY] } },
      { lastLocationAt: { $gte: recentlySeen } },
    ],
  })
    .select(
      'userId status vehicleType licensePlate currentLocation heading speed batteryLevel lastLocationAt'
    )
    .populate('userId', 'name phone avatar');

  if (drivers.length === 0) return [];

  // Una sola consulta para los pedidos de toda la flota. Preguntar por
  // cada repartidor sería N+1 sobre un endpoint que el panel refresca
  // cada pocos segundos.
  const activeOrders = await Order.find({
    driverId: { $in: drivers.map((d) => d._id) },
    status: { $in: [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
  }).select('driverId orderNumber status');

  const orderByDriver = new Map<string, IOrder>();
  for (const order of activeOrders) {
    if (order.driverId) orderByDriver.set(order.driverId.toString(), order);
  }

  const now = Date.now();

  return drivers.map((driver) => {
    const user = driver.userId as unknown as {
      _id: Types.ObjectId;
      name?: string;
      phone?: string;
      avatar?: string;
    };
    const order = orderByDriver.get(driver._id.toString());

    return {
      id: driver._id.toString(),
      userId: user?._id?.toString() ?? '',
      name: user?.name ?? 'Repartidor',
      avatar: user?.avatar ?? null,
      phone: user?.phone ?? null,
      status: driver.status,
      vehicleType: driver.vehicleType,
      licensePlate: driver.licensePlate ?? null,
      location: fromGeoPoint(driver.currentLocation),
      heading: driver.heading ?? null,
      speed: driver.speed ?? null,
      batteryLevel: driver.batteryLevel ?? null,
      lastSeenAt: driver.lastLocationAt ?? null,
      stale: driver.lastLocationAt
        ? now - driver.lastLocationAt.getTime() > config.tracking.staleAfterMs
        : true,
      activeOrder: order
        ? { id: order._id.toString(), orderNumber: order.orderNumber, status: order.status }
        : null,
    };
  });
}

// ── Repartidor más cercano ────────────────────────────────────────────

export interface NearestDriver {
  driverId: string;
  userId: string;
  name: string;
  location: LatLng;
  /** Metros en línea recta. Siempre disponible. */
  straightMeters: number;
  /** Metros por carretera. Cae a estimación si Mapbox no responde. */
  roadMeters: number;
  /** Segundos hasta el punto. El criterio real de asignación. */
  etaSeconds: number;
  source: 'mapbox' | 'estimate';
}

/**
 * Los repartidores que antes llegarían a un punto, ordenados.
 *
 * Es la base de la asignación automática, y está construida en dos pasos a
 * propósito:
 *
 * 1. MongoDB recorta con `$near` sobre el índice `2dsphere` que ya existía
 *    en `Driver`. Barato, ordena por línea recta, sin salir del servidor.
 * 2. Mapbox reordena a los finalistas por tiempo real de viaje.
 *
 * El paso 2 es el que importa: el más cercano en línea recta puede estar
 * al otro lado de un río o de una avenida sin retorno, y el segundo llegar
 * diez minutos antes. Pero pedirle a Mapbox la matriz de *todos* los
 * repartidores de la ciudad en cada pedido sería caro y lento, así que el
 * paso 1 se queda con los pocos que tienen alguna opción.
 *
 * Esta función todavía no asigna nada: devuelve el ranking. Conectarla a
 * la creación del pedido es un cambio de una línea en `order.service.ts`
 * el día que se decida activarlo, y hasta entonces se puede consultar
 * desde el panel para comparar contra la asignación manual.
 */
export async function findNearestDrivers(
  point: LatLng,
  options: { limit?: number; radiusMeters?: number; candidatePool?: number } = {}
): Promise<NearestDriver[]> {
  const {
    limit = 5,
    radiusMeters = config.tracking.nearestRadiusMeters,
    candidatePool = 15,
  } = options;

  if (!isValidCoordinate(point.lat, point.lng)) return [];

  const freshSince = new Date(Date.now() - config.tracking.staleAfterMs);

  const candidates = await Driver.find({
    status: DriverStatus.AVAILABLE,
    isActive: true,
    isApproved: true,
    // Una posición de hace una hora no dice dónde está nadie. Asignar por
    // ella manda el pedido a donde el repartidor *estaba*.
    lastLocationAt: { $gte: freshSince },
    currentLocation: {
      $near: {
        $geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        $maxDistance: radiusMeters,
      },
    },
  })
    .select('userId currentLocation')
    .populate('userId', 'name')
    .limit(candidatePool);

  const usable = candidates
    .map((driver) => ({ driver, location: fromGeoPoint(driver.currentLocation) }))
    .filter((c): c is { driver: (typeof candidates)[number]; location: LatLng } => c.location !== null);

  if (usable.length === 0) return [];

  const durations = await getDurationsToPoint(
    usable.map((c) => c.location),
    point
  );

  return usable
    .map((candidate, index) => {
      const duration = durations[index];
      const user = candidate.driver.userId as unknown as { _id: Types.ObjectId; name?: string };

      return {
        driverId: candidate.driver._id.toString(),
        userId: user?._id?.toString() ?? '',
        name: user?.name ?? 'Repartidor',
        location: candidate.location,
        straightMeters: haversineMeters(candidate.location, point),
        roadMeters: duration?.distanceMeters ?? 0,
        etaSeconds: duration?.durationSeconds ?? Number.MAX_SAFE_INTEGER,
        source: duration?.source ?? ('estimate' as const),
      };
    })
    .sort((a, b) => a.etaSeconds - b.etaSeconds)
    .slice(0, limit);
}

/**
 * El repartidor más cercano al local de un pedido concreto.
 *
 * Envoltorio sobre `findNearestDrivers` con el punto de partida correcto:
 * la asignación se decide por quién llega antes *al restaurante*, no a la
 * dirección del cliente. El viaje al cliente lo hace igual quien sea, pero
 * el primer tramo es el que determina cuánto se enfría la comida.
 */
export async function suggestDriverForOrder(orderId: string): Promise<NearestDriver[]> {
  const order = await Order.findById(orderId).select('businessId');
  if (!order) throw new AppError('Pedido no encontrado', 404);

  const business = await Business.findById(order.businessId).select('location');
  const pickup = fromGeoPoint(business?.location);
  if (!pickup) return [];

  return findNearestDrivers(pickup);
}

/** Config pública de mapas que las apps necesitan para renderizar. */
export function getMapConfig(role?: string) {
  return {
    // El token público viaja a clientes ya autenticados. Se sirve por API y
    // no compilado en la app para poder rotarlo sin publicar una versión
    // nueva en las tiendas — que es la diferencia entre rotar una clave en
    // diez minutos y tardar una semana en revisión.
    accessToken: config.mapbox.accessToken,
    enabled: config.mapbox.enabled,
    style: config.mapbox.style,
    styleDark: config.mapbox.styleDark,
    // Los umbrales de muestreo llegan del servidor para poder ajustarlos
    // en caliente: si la factura de datos se dispara, se sube el intervalo
    // sin tocar la app.
    tracking:
      role === UserRole.DRIVER
        ? {
            minPersistIntervalMs: config.tracking.minPersistIntervalMs,
            minMoveMeters: config.tracking.minMoveMeters,
            maxAccuracyMeters: config.tracking.maxAccuracyMeters,
            /**
             * Cada cuánto reenviar la última posición aunque el GPS calle.
             *
             * Va con margen sobre `HEARTBEAT_MS` porque el servidor
             * descarta como "no se ha movido" cualquier ping quieto que
             * llegue *antes* de ese plazo. Un latido exacto de 30 s caería
             * justo en el borde y la mitad se perdería por décimas.
             */
            heartbeatMs: HEARTBEAT_MS + 5_000,
            staleAfterMs: config.tracking.staleAfterMs,
          }
        : undefined,
  };
}
