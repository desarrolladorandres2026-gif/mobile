import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Driver, DriverLocation, Order } from '../models';
import { OrderStatus, UserRole } from '../types';
import {
  ingestPing,
  forgetDriver,
  deliveryPhase,
  distanceToRouteMeters,
  findNearestDrivers,
  getMapConfig,
  HEARTBEAT_MS,
} from '../services/tracking.service';
import { estimateRoute, clearRouteCache } from '../services/mapbox.service';
import { haversineMeters } from '../utils/geo';
import { makeUser, makeDriver, makeBusiness, GARZON, offsetKm } from './factories';

/**
 * El filtro de ingesta de posiciones.
 *
 * Es la pieza que decide cuántas veces al día se escribe en la base por
 * cada repartidor, así que un fallo aquí no se ve como un error: se ve
 * como una factura. Estas pruebas fijan el contrato.
 */
describe('ingestPing: filtro de posiciones', () => {
  let driverUser: any;
  let driver: any;

  beforeEach(async () => {
    driverUser = await makeUser({ role: UserRole.DRIVER });
    driver = await makeDriver(driverUser._id);
    // El estado del filtro vive en memoria del módulo, no en Mongo, así
    // que el `afterEach` global que limpia colecciones no lo toca. Sin
    // esto, una prueba heredaría el último punto de la anterior.
    forgetDriver(driverUser._id.toString());
  });

  afterEach(() => {
    forgetDriver(driverUser._id.toString());
    vi.useRealTimers();
  });

  it('acepta el primer punto y lo escribe en el repartidor', async () => {
    const result = await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
      accuracy: 8,
      heading: 90,
      speed: 5,
      batteryLevel: 74,
    });

    expect(result.accepted).toBe(true);

    const saved = await Driver.findById(driver._id);
    expect(saved!.currentLocation.coordinates).toEqual([GARZON.lng, GARZON.lat]);
    expect(saved!.lastLocationAt).toBeInstanceOf(Date);
    expect(saved!.heading).toBe(90);
    expect(saved!.batteryLevel).toBe(74);
  });

  it('rechaza coordenadas inválidas sin tocar la base', async () => {
    // (0,0) es Null Island: casi siempre un marcador de posición, nunca
    // una entrega real. Si entrara al índice 2dsphere ensuciaría cualquier
    // búsqueda de cercanía posterior.
    const result = await ingestPing(driverUser._id.toString(), { lat: 0, lng: 0 });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_coordinates');

    const saved = await Driver.findById(driver._id);
    expect(saved!.lastLocationAt).toBeUndefined();
  });

  it('rechaza un fix demasiado impreciso', async () => {
    const result = await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
      accuracy: 450,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('inaccurate');
  });

  it('descarta un segundo punto que llega demasiado pronto', async () => {
    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    // Mismo instante, a 2 km de distancia: da igual cuánto se haya movido,
    // el tope de frecuencia protege la base de un cliente mal configurado.
    const far = offsetKm(GARZON, 2);
    const result = await ingestPing(driverUser._id.toString(), far);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('throttled');
  });

  it('descarta el temblor del GPS de un teléfono quieto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    // Pasa el tope de frecuencia, pero el "movimiento" son 3 metros: es
    // ruido del sensor, no un desplazamiento.
    vi.setSystemTime(start + 6000);
    const result = await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat + 0.000027,
      lng: GARZON.lng,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('not_moved');
  });

  it('acepta un punto quieto pasado el latido, para no darlo por perdido', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    // Sigue sin moverse, pero han pasado 35 s. Sin este caso, un
    // repartidor almorzando desaparecería del panel como "sin señal"
    // teniendo el GPS perfectamente vivo.
    vi.setSystemTime(start + 35_000);
    const result = await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(result.accepted).toBe(true);
  });

  it('acepta un desplazamiento real pasado el intervalo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    vi.setSystemTime(start + 6000);
    const moved = offsetKm(GARZON, 0.3);
    const result = await ingestPing(driverUser._id.toString(), moved);

    expect(result.accepted).toBe(true);
    expect(result.location).toEqual({ lat: moved.lat, lng: moved.lng });
  });

  it('no guarda rastro cuando el repartidor no lleva ningún pedido', async () => {
    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    // El recorrido de alguien esperando pedidos no documenta nada y sí
    // acumula el mapa de movimientos de una persona. Se descarta a
    // propósito.
    expect(await DriverLocation.countDocuments()).toBe(0);
  });

  it('guarda el rastro durante una entrega, atado al pedido', async () => {
    const ownerUser = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(ownerUser._id);
    const clientUser = await makeUser({ role: UserRole.CLIENT });

    const order = await Order.create({
      clientId: clientUser._id,
      businessId: business._id,
      driverId: driver._id,
      items: [],
      status: OrderStatus.ON_WAY,
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 5 # 10-20',
      deliveryLocation: { type: 'Point', coordinates: [GARZON.lng, GARZON.lat] },
      city: 'Test',
      // El dinero no le importa a esta prueba, pero el esquema lo exige:
      // un pedido sin importes no es un pedido.
      subtotal: 20000,
      deliveryFee: 4000,
      discount: 0,
      tip: 0,
      tax: 0,
      platformCommission: 2000,
      businessPayout: 18000,
      driverPayout: 4000,
      total: 24000,
    });

    await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
      accuracy: 10,
    });

    const trail = await DriverLocation.find({ orderId: order._id });
    expect(trail).toHaveLength(1);
    expect(trail[0].driverId.toString()).toBe(driver._id.toString());
  });

  it('rechaza a un usuario que no tiene perfil de repartidor', async () => {
    const stranger = await makeUser({ role: UserRole.CLIENT });
    const result = await ingestPing(stranger._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unknown_driver');
    forgetDriver(stranger._id.toString());
  });
});

describe('getMapConfig: el ritmo del latido lo manda el servidor', () => {
  it('le da al domiciliario un latido más largo que el umbral de "no se ha movido"', () => {
    const config = getMapConfig(UserRole.DRIVER);

    // Si el latido del cliente fuera igual o menor que HEARTBEAT_MS, el
    // servidor rechazaría los latidos por "not_moved" y el domiciliario
    // desaparecería del mapa estando quieto — el fallo que este mecanismo
    // existe para evitar.
    expect(config.tracking!.heartbeatMs).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('late bastante antes de que el servidor dé al domiciliario por perdido', () => {
    const config = getMapConfig(UserRole.DRIVER);
    expect(config.tracking!.heartbeatMs).toBeLessThan(config.tracking!.staleAfterMs);
  });

  it('no expone los umbrales de muestreo a quien no es domiciliario', () => {
    // Un cliente no reporta posición: darle estos números sería filtrar
    // cómo se vigila a los domiciliarios sin ninguna razón.
    expect(getMapConfig(UserRole.CLIENT).tracking).toBeUndefined();
  });
});

describe('deliveryPhase: hacia dónde va el repartidor', () => {
  it('apunta al local mientras el pedido no se ha recogido', () => {
    expect(deliveryPhase(OrderStatus.PENDING)).toBe('to_business');
    expect(deliveryPhase(OrderStatus.ACCEPTED)).toBe('to_business');
    expect(deliveryPhase(OrderStatus.PREPARING)).toBe('to_business');
    expect(deliveryPhase(OrderStatus.READY)).toBe('to_business');
  });

  it('apunta al cliente una vez recogido', () => {
    expect(deliveryPhase(OrderStatus.PICKED_UP)).toBe('to_client');
    expect(deliveryPhase(OrderStatus.ON_WAY)).toBe('to_client');
  });

  it('no propone ruta para un pedido terminado', () => {
    expect(deliveryPhase(OrderStatus.DELIVERED)).toBe('idle');
    expect(deliveryPhase(OrderStatus.CANCELLED)).toBe('idle');
  });
});

describe('estimateRoute: la plataforma funciona sin Mapbox', () => {
  beforeEach(() => clearRouteCache());

  it('devuelve una ruta usable y se declara estimación', () => {
    const to = offsetKm(GARZON, 3);
    const route = estimateRoute(GARZON, to);

    expect(route.source).toBe('estimate');
    expect(route.geometry.coordinates).toHaveLength(2);
    expect(route.durationSeconds).toBeGreaterThan(0);
  });

  it('corrige la línea recta por el rodeo de las calles', () => {
    const to = offsetKm(GARZON, 3);
    const straight = haversineMeters(GARZON, to);
    const route = estimateRoute(GARZON, to);

    // Nunca debe prometer menos distancia que la línea recta: sería
    // prometer un atajo que no existe.
    expect(route.distanceMeters).toBeGreaterThan(straight);
  });
});

describe('distanceToRouteMeters: detección de desvío', () => {
  const route = {
    coordinates: [
      [GARZON.lng, GARZON.lat],
      [GARZON.lng, GARZON.lat + 0.009],
      [GARZON.lng, GARZON.lat + 0.018],
    ] as [number, number][],
  };

  it('da casi cero sobre el trazado', () => {
    expect(distanceToRouteMeters({ lat: GARZON.lat + 0.009, lng: GARZON.lng }, route)).toBeLessThan(5);
  });

  it('mide contra el punto más cercano del trazado, no contra el destino', () => {
    // A la altura del primer vértice pero desplazado al este. Está lejos
    // del destino y aun así perfectamente sobre la ruta: quien rodea una
    // manzana para tomar el sentido correcto no debe recibir un recálculo.
    const aside = { lat: GARZON.lat, lng: GARZON.lng + 0.0009 };
    const measured = distanceToRouteMeters(aside, route);

    expect(measured).not.toBeNull();
    expect(measured!).toBeLessThan(150);
  });

  it('devuelve null si la ruta viene vacía', () => {
    expect(distanceToRouteMeters(GARZON, { coordinates: [] })).toBeNull();
  });
});

describe('findNearestDrivers: base de la asignación automática', () => {
  it('ignora a quien no ha reportado posición recientemente', async () => {
    const staleUser = await makeUser({ role: UserRole.DRIVER });
    const staleDriver = await makeDriver(staleUser._id);
    // Posición de hace dos horas: dice dónde estaba, no dónde está.
    // Asignarle un pedido por ella lo manda al sitio equivocado.
    await Driver.updateOne(
      { _id: staleDriver._id },
      { lastLocationAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }
    );

    const nearby = await findNearestDrivers(GARZON);
    expect(nearby.map((d) => d.driverId)).not.toContain(staleDriver._id.toString());
  });

  it('encuentra a un repartidor disponible con posición fresca', async () => {
    const freshUser = await makeUser({ role: UserRole.DRIVER });
    const freshDriver = await makeDriver(freshUser._id);
    await Driver.updateOne({ _id: freshDriver._id }, { lastLocationAt: new Date() });

    const nearby = await findNearestDrivers(GARZON);

    expect(nearby.map((d) => d.driverId)).toContain(freshDriver._id.toString());
    expect(nearby[0].etaSeconds).toBeGreaterThanOrEqual(0);
  });

  it('devuelve lista vacía ante un punto sin coordenadas válidas', async () => {
    expect(await findNearestDrivers({ lat: 0, lng: 0 })).toEqual([]);
  });
});
