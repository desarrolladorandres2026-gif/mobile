import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Geocerca del traspaso físico, y la ruta de recogida correcta según el
 * tipo de pedido.
 *
 * Antes de esto, `orderSecurityService` guardaba las coordenadas que
 * mandaba el teléfono para auditoría y nunca las comparaba contra nada —
 * "Llegué" y el código se podían confirmar desde cualquier distancia real
 * del comercio o del cliente. Y `getDriverRoute` asumía que todo pedido
 * tiene un `Business` detrás, lo que rompía la ruta de recogida de todo
 * mandado (`order.kind === 'errand'`).
 *
 * Este archivo prueba las dos cosas por HTTP contra la app real, igual que
 * `orderFlowE2E.integration.test.ts`, porque la validación vive repartida
 * entre el validador (`accuracy`), el controlador (`readLocation`) y el
 * servicio (`enforceGeofence`) — probar solo el servicio dejaría fuera la
 * mitad del cableado.
 */
import app from '../app';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderService } from '../services/order.service';
import { errandService } from '../services/errand.service';
import { validateLocationProximity } from '../utils/geo';
import { OrderSecurity } from '../security/orderSecurity';
import { Order, Business } from '../models';
import { OrderCodeStatus, OrderStatus, PaymentStatus, UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig,
  authHeader,
} from './factories';

// El negocio vive en GARZON. El cliente, a ~2 km — lejos de sobra del
// negocio para que nunca se confundan pickup y dropoff en una prueba.
const DESTINATION = offsetKm(GARZON, 2);
// ~5 km de cualquiera de los dos puntos: fuera de cualquier radio sano.
const FAR_AWAY = offsetKm(GARZON, 5);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 6)]);

let storedCount = 0;
beforeEach(() => {
  storedCount = 0;
  vi.spyOn(orderEvidenceService as any, 'store').mockImplementation(
    async (...args: unknown[]) => {
      const orderId = args[1] as string;
      storedCount += 1;
      return {
        publicId: `zipp/order-evidence/${orderId}/foto-${storedCount}`,
        url: `https://res.cloudinary.test/${orderId}-${storedCount}.jpg`,
        width: 800,
        height: 600,
      };
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Pedido normal, listo y asignado: negocio en GARZON, cliente a 2 km. */
async function readyNormalOrder() {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });

  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id); // GARZON, por defecto de la factory
  const product = await makeProduct(business._id, { price: 20000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 200_000 });

  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  } as never);
  const orderId = order._id.toString();

  for (const status of ['accepted', 'preparing', 'ready']) {
    const res = await request(app)
      .patch(`/api/v1/orders/${orderId}/status`)
      .set(await authHeader(owner))
      .send({ status });
    expect(res.status).toBe(200);
  }

  const assigned = await request(app)
    .patch(`/api/v1/orders/${orderId}/assign-driver`)
    .set(await authHeader(driverUser));
  expect(assigned.status).toBe(200);

  return { client, owner, business, driverUser, driver, orderId };
}

/** Mandado, listo y asignado: recogida a 1 km de GARZON, entrega en GARZON. */
async function readyErrandOrder() {
  await makePricingConfig({ maxDriverCashDebt: 0 });

  const client = await makeUser({ role: UserRole.CLIENT });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 200_000 });
  const pickup = offsetKm(GARZON, 1);

  const order = await errandService.create({
    clientId: client._id.toString(),
    description: 'Recoger un encargo en la tienda',
    pickupAddress: 'Tienda de barrio',
    pickupLatitude: pickup.lat,
    pickupLongitude: pickup.lng,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLatitude: GARZON.lat,
    deliveryLongitude: GARZON.lng,
    estimatedCost: 20000,
    maxCost: 30000,
  } as never);
  const orderId = order._id.toString();

  await Order.updateOne(
    { _id: orderId },
    { status: OrderStatus.READY, paymentStatus: PaymentStatus.PAID }
  );
  const assigned = await request(app)
    .patch(`/api/v1/orders/${orderId}/assign-driver`)
    .set(await authHeader(driverUser));
  expect(assigned.status).toBe(200);

  return { client, driverUser, driver, orderId, pickup };
}

async function pickupCodeFor(orderId: string, owner: any): Promise<string> {
  const res = await request(app).get(`/api/v1/orders/${orderId}/flow`).set(await authHeader(owner));
  return res.body.data.pickup.code as string;
}

/** Deja el pedido en `ready`, con llegada y evidencia de recogida ya registradas. */
async function arrivedAtStoreWithEvidence(orderId: string, driverUser: any) {
  const arrive = await request(app)
    .post(`/api/v1/orders/${orderId}/pickup/arrive`)
    .set(await authHeader(driverUser))
    .send({ latitude: GARZON.lat, longitude: GARZON.lng });
  expect(arrive.status).toBe(200);

  const evidence = await request(app)
    .post(`/api/v1/orders/${orderId}/pickup/evidence`)
    .set(await authHeader(driverUser))
    .field('latitude', String(GARZON.lat))
    .field('longitude', String(GARZON.lng))
    .attach('photo', JPEG, { filename: 'recepcion.jpg', contentType: 'image/jpeg' });
  expect(evidence.status).toBe(201);
}

// ── A/B/K/L: la ruta de recogida usa el pickup correcto ──────────────

describe('getDriverRoute (vía /tracking/orders/:id/route): pickup correcto según el tipo de pedido', () => {
  it('A. pedido normal en fase to_business apunta a business.location', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const res = await request(app)
      .post(`/api/v1/tracking/orders/${orderId}/route`)
      .set(await authHeader(driverUser))
      .send({ lat: GARZON.lat, lng: GARZON.lng });

    expect(res.status).toBe(200);
    expect(res.body.data.phase).toBe('to_business');
    expect(res.body.data.to.lat).toBeCloseTo(GARZON.lat, 3);
    expect(res.body.data.to.lng).toBeCloseTo(GARZON.lng, 3);
  });

  it('B. mandado en fase to_business apunta a errand.pickupLocation, nunca a Business', async () => {
    const { orderId, driverUser, pickup } = await readyErrandOrder();

    const res = await request(app)
      .post(`/api/v1/tracking/orders/${orderId}/route`)
      .set(await authHeader(driverUser))
      .send({ lat: GARZON.lat, lng: GARZON.lng });

    expect(res.status).toBe(200);
    expect(res.body.data.phase).toBe('to_business');
    expect(res.body.data.to.lat).toBeCloseTo(pickup.lat, 3);
    expect(res.body.data.to.lng).toBeCloseTo(pickup.lng, 3);
  });

  it('pickup sin coordenadas registradas → error controlado (409), no un crash', async () => {
    const { orderId, driverUser, business } = await readyNormalOrder();
    await Business.updateOne({ _id: business._id }, { $unset: { location: 1 } });

    const res = await request(app)
      .post(`/api/v1/tracking/orders/${orderId}/route`)
      .set(await authHeader(driverUser))
      .send({ lat: GARZON.lat, lng: GARZON.lng });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/coordenadas/i);
  });

  it('K/L. tras recoger, la ruta cambia sola a to_client con destino = deliveryLocation', async () => {
    const { orderId, driverUser, owner } = await readyNormalOrder();

    await arrivedAtStoreWithEvidence(orderId, driverUser);
    const code = await pickupCodeFor(orderId, owner);
    const verify = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/verify`)
      .set(await authHeader(driverUser))
      .send({ code, latitude: GARZON.lat, longitude: GARZON.lng });
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe(OrderStatus.PICKED_UP);

    const res = await request(app)
      .post(`/api/v1/tracking/orders/${orderId}/route`)
      .set(await authHeader(driverUser))
      .send({ lat: GARZON.lat, lng: GARZON.lng });

    expect(res.status).toBe(200);
    expect(res.body.data.phase).toBe('to_client');
    expect(res.body.data.to.lat).toBeCloseTo(DESTINATION.lat, 3);
    expect(res.body.data.to.lng).toBeCloseTo(DESTINATION.lng, 3);
  });
});

// ── C/D/E/F: llegada dentro/fuera del radio ───────────────────────────

describe('Geofence: "Llegué" (arrive) dentro/fuera de radio', () => {
  it('C. pickup arrive dentro del radio del negocio → 200', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: GARZON.lat, longitude: GARZON.lng });

    expect(res.status).toBe(200);
  });

  it('D. pickup arrive lejos del negocio → 409 DRIVER_TOO_FAR', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DRIVER_TOO_FAR');
  });

  it('E. delivery arrive dentro del radio del cliente → 200', async () => {
    const { orderId, driverUser, owner } = await readyNormalOrder();
    await arrivedAtStoreWithEvidence(orderId, driverUser);
    const code = await pickupCodeFor(orderId, owner);
    await request(app).post(`/api/v1/orders/${orderId}/pickup/verify`).set(await authHeader(driverUser))
      .send({ code, latitude: GARZON.lat, longitude: GARZON.lng });
    await request(app).patch(`/api/v1/orders/${orderId}/status`).set(await authHeader(driverUser))
      .send({ status: 'on_way' });

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/delivery/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: DESTINATION.lat, longitude: DESTINATION.lng });

    expect(res.status).toBe(200);
  });

  it('F. delivery arrive lejos del cliente → 409 DRIVER_TOO_FAR', async () => {
    const { orderId, driverUser, owner } = await readyNormalOrder();
    await arrivedAtStoreWithEvidence(orderId, driverUser);
    const code = await pickupCodeFor(orderId, owner);
    await request(app).post(`/api/v1/orders/${orderId}/pickup/verify`).set(await authHeader(driverUser))
      .send({ code, latitude: GARZON.lat, longitude: GARZON.lng });
    await request(app).patch(`/api/v1/orders/${orderId}/status`).set(await authHeader(driverUser))
      .send({ status: 'on_way' });

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/delivery/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DRIVER_TOO_FAR');
  });

  it('mandado: pickup arrive también se mide contra errand.pickupLocation', async () => {
    const { orderId, driverUser, pickup } = await readyErrandOrder();

    const far = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: GARZON.lat, longitude: GARZON.lng }); // GARZON está a 1 km del pickup del mandado
    expect(far.status).toBe(409);
    expect(far.body.code).toBe('DRIVER_TOO_FAR');

    const near = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: pickup.lat, longitude: pickup.lng });
    expect(near.status).toBe(200);
  });
});

// ── G/H: código + GPS ─────────────────────────────────────────────────

describe('Geofence: validar el código según el GPS', () => {
  it('G. código correcto + GPS lejos del negocio → RECHAZA y no consume el código', async () => {
    const { orderId, driverUser, owner } = await readyNormalOrder();
    const code = await pickupCodeFor(orderId, owner);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/verify`)
      .set(await authHeader(driverUser))
      .send({ code, latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DRIVER_TOO_FAR');

    const security = await OrderSecurity.findOne({ orderId });
    expect(security!.pickup.status).toBe(OrderCodeStatus.PENDING);

    const stillReady = await Order.findById(orderId);
    expect(stillReady!.status).toBe(OrderStatus.READY);
  });

  it('H. código correcto + GPS dentro del radio → PERMITE y avanza a picked_up', async () => {
    const { orderId, driverUser, owner } = await readyNormalOrder();
    await arrivedAtStoreWithEvidence(orderId, driverUser);
    const code = await pickupCodeFor(orderId, owner);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/verify`)
      .set(await authHeader(driverUser))
      .send({ code, latitude: GARZON.lat, longitude: GARZON.lng });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(OrderStatus.PICKED_UP);
  });
});

// ── I/J: la geocerca no reemplaza las puertas que ya existían ────────

describe('Geofence: no interfiere con la máquina de estados ni con la idempotencia existentes', () => {
  it('I. estado incorrecto → RECHAZA por etapa, incluso con el GPS exacto', async () => {
    const { orderId, driverUser } = await readyNormalOrder();
    // El pedido nunca llegó a "ready": simula que la asignación ocurrió
    // (o se forzó) mientras el comercio todavía preparaba.
    await Order.updateOne({ _id: orderId }, { status: OrderStatus.PREPARING });

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: GARZON.lat, longitude: GARZON.lng });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_WRONG_STAGE');
  });

  it('J. doble "Llegué" con buen GPS → idempotente, conserva el primer arrivedAt', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const first = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: GARZON.lat, longitude: GARZON.lng });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: GARZON.lat, longitude: GARZON.lng });
    expect(second.status).toBe(200);
    expect(second.body.data.arrivedAt).toBe(first.body.data.arrivedAt);
  });

  it('sin coordenadas del teléfono (GPS apagado) → no bloquea, mismo comportamiento que antes de esta validación', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({});

    expect(res.status).toBe(200);
  });
});

// ── Precisión GPS ──────────────────────────────────────────────────────

describe('Geofence: precisión del GPS', () => {
  it('una precisión insuficiente pide mejorar la ubicación, no acepta a ciegas', async () => {
    const { orderId, driverUser } = await readyNormalOrder();

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      // Exactamente sobre el negocio, pero con un margen de error enorme:
      // ese fix no prueba nada por sí solo.
      .send({ latitude: GARZON.lat, longitude: GARZON.lng, accuracy: 500 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCATION_ACCURACY_TOO_LOW');
  });

  it('una precisión moderada amplía la tolerancia en vez de rechazar de más', async () => {
    const { orderId, driverUser } = await readyNormalOrder();
    // ~200 m del negocio: por encima del radio (150 m) a secas, pero
    // dentro de radio + precisión declarada (150 + 80 = 230 m).
    const nearby = offsetKm(GARZON, 0.2);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/pickup/arrive`)
      .set(await authHeader(driverUser))
      .send({ latitude: nearby.lat, longitude: nearby.lng, accuracy: 80 });

    expect(res.status).toBe(200);
  });

  it('no rechaza solo por una imprecisión ligera: sin tolerancia, esa misma distancia sí fallaría', async () => {
    const nearby = offsetKm(GARZON, 0.2);
    const result = validateLocationProximity(nearby, GARZON, { radiusMeters: 150 });
    expect(result.status).toBe('too_far');
  });
});
