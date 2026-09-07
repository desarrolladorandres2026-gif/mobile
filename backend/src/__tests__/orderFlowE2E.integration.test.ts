import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Auditoría de integración de punta a punta del traspaso de custodia.
 *
 * A diferencia de `orderFlow.test.ts` —que verifica cada regla por
 * separado, con el pedido colocado a mano en el estado que le interesa a
 * cada caso—, este archivo recorre el ciclo de vida COMPLETO en un único
 * hilo narrativo, exactamente como lo haría cada aplicación real: el
 * cliente pide, el comercio prepara, el domiciliario reclama, recoge y
 * entrega, todo por HTTP contra la app real y la base de datos real (en
 * memoria). Solo se sustituye la subida a Cloudinary, que es la única
 * frontera que de verdad no se puede cruzar en una prueba.
 *
 * El objetivo es que un fallo aquí señale una ruptura en la CADENA, no en
 * una regla aislada: si algo se puede saltar cuando todo lo demás está
 * pasando a su alrededor, es donde de verdad se nota.
 */
import app from '../app';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { OrderSecurity } from '../security/orderSecurity';
import { Notification, Order, OrderEvidence } from '../models';
import { OrderCodeStatus, OrderEvidenceType, OrderStatus, OrderTimelineAction, UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig,
  authHeader,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const JPEG_ALT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 5)]);

let storedCount = 0;

beforeEach(() => {
  storedCount = 0;
  // Único doble del archivo: la red hacia Cloudinary. Todo lo demás —bytes,
  // checksum, control de acceso, Mongo— se ejecuta de verdad.
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

/** Monta el reparto: cliente, comercio con producto, domiciliario con fondo. */
async function setupActors() {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });

  const client = await makeUser({ role: UserRole.CLIENT, name: 'Cliente E2E' });
  const owner = await makeUser({ role: UserRole.BUSINESS, name: 'Dueño E2E' });
  const business = await makeBusiness(owner._id, { name: 'Restaurante E2E' });
  const product = await makeProduct(business._id, { name: 'Bandeja paisa', price: 20000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER, name: 'Domiciliario E2E' });
  const driver = await makeDriver(driverUser._id, { currentFund: 200_000 });

  return { client, owner, business, product, driverUser, driver };
}

/** Espera corta a que algo asíncrono (una notificación en segundo plano) aparezca. */
async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await fn();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('Tiempo agotado esperando la condición');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('AUDITORÍA E2E — ciclo de vida completo del pedido', () => {
  it(
    'ASIGNACIÓN → RUTA → LLEGADA → FOTO → CÓDIGO → PAQUETE RECIBIDO → AVISO → ' +
      'RUTA AL CLIENTE → LLEGADA → CÓDIGO → FOTO → ENTREGADO, sin saltos, ' +
      'con custodia y notificación en cada frontera',
    async () => {
      const { client, owner, business, product, driverUser } = await setupActors();

      // ── 0. El cliente pide, como lo haría la app ──────────────────────
      const created = await request(app)
        .post('/api/v1/orders')
        .set(authHeader(client))
        .send({
          businessId: business._id.toString(),
          items: [{ productId: product._id.toString(), quantity: 1 }],
          paymentMethod: 'cash_on_delivery',
          deliveryAddress: 'Calle 5 # 3-21',
          deliveryLatitude: DESTINATION.lat,
          deliveryLongitude: DESTINATION.lng,
        });
      expect(created.status).toBe(201);
      const orderId = created.body.data._id as string;
      const orderNumber = created.body.data.orderNumber as string;
      expect(created.body.data.status).toBe('pending');
      expect(orderNumber).toBeTruthy();

      // Nadie puede validar un código que ni siquiera existe todavía. Este
      // domiciliario ni siquiera es parte del pedido aún (no hay
      // asignación), así que el control de acceso ni le confirma que
      // existe: 404, no 409 — no hay "etapa equivocada" para quien no
      // participa.
      const tooEarly = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: '000000' });
      expect(tooEarly.status).toBe(404);

      // ── 1. El comercio acepta, prepara y alista ───────────────────────
      for (const status of ['accepted', 'preparing', 'ready']) {
        const res = await request(app)
          .patch(`/api/v1/orders/${orderId}/status`)
          .set(authHeader(owner))
          .send({ status });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(status);
      }

      // El cliente NUNCA puede fijar el estado a mano. Aquí la transición
      // "ready → delivered" ya es inválida por sí sola (400); la prueba de
      // verdad —donde el único obstáculo es el rol, no la máquina de
      // estados— viene más abajo, en cuanto "on_way → delivered" sea una
      // transición legítima para cualquier otro actor.
      const clientForcesNow = await request(app)
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(authHeader(client))
        .send({ status: 'delivered' });
      expect(clientForcesNow.status).not.toBe(200);

      // ── 2. ASIGNACIÓN: el domiciliario reclama el pedido ──────────────
      const claimed = await request(app)
        .patch(`/api/v1/orders/${orderId}/assign-driver`)
        .set(authHeader(driverUser));
      expect(claimed.status).toBe(200);
      expect(claimed.body.data.driverId).toBeTruthy();

      // ── 3. RUTA A RECOGIDA: el backend apunta al comercio ─────────────
      const routeToStore = await request(app)
        .post(`/api/v1/tracking/orders/${orderId}/route`)
        .set(authHeader(driverUser))
        .send({ lat: GARZON.lat, lng: GARZON.lng });
      expect(routeToStore.status).toBe(200);
      expect(routeToStore.body.data.phase).toBe('to_business');

      // El comercio ve el código de recogida; el domiciliario, no.
      const businessFlow = await request(app)
        .get(`/api/v1/orders/${orderId}/flow`)
        .set(authHeader(owner));
      const pickupCode = businessFlow.body.data.pickup.code as string;
      expect(pickupCode).toMatch(/^\d{6}$/);

      const driverSeesNothing = await request(app)
        .get(`/api/v1/orders/${orderId}/flow`)
        .set(authHeader(driverUser));
      expect(driverSeesNothing.body.data.pickup.code).toBeNull();

      // SALTO DE ESTADO: el código no sirve sin haber declarado la llegada.
      const skipArrival = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: pickupCode });
      expect(skipArrival.status).toBe(409);
      expect(skipArrival.body.code).toBe('DRIVER_NOT_ARRIVED');

      // ── 4. LLEGADA AL COMERCIO ─────────────────────────────────────────
      const arriveStore = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/arrive`)
        .set(authHeader(driverUser))
        .send({ latitude: GARZON.lat, longitude: GARZON.lng });
      expect(arriveStore.status).toBe(200);
      expect(arriveStore.body.data.arrivedAt).toBeTruthy();

      // SALTO DE ESTADO: llegada declarada, pero todavía sin foto.
      const skipEvidence = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: pickupCode });
      expect(skipEvidence.status).toBe(409);
      expect(skipEvidence.body.code).toBe('EVIDENCE_REQUIRED');

      // ── 5. FOTO DE RECEPCIÓN — obligatoria y vinculada ────────────────
      const pickupEvidence = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/evidence`)
        .set(authHeader(driverUser))
        .field('latitude', String(GARZON.lat))
        .field('longitude', String(GARZON.lng))
        .attach('photo', JPEG, { filename: 'recepcion.jpg', contentType: 'image/jpeg' });
      expect(pickupEvidence.status).toBe(201);

      const pickupEvidenceDoc = await OrderEvidence.findById(pickupEvidence.body.data.id);
      expect(pickupEvidenceDoc).toBeTruthy();
      expect(pickupEvidenceDoc!.orderId.toString()).toBe(orderId);
      expect(pickupEvidenceDoc!.uploadedBy.toString()).toBe(driverUser._id.toString());
      expect(pickupEvidenceDoc!.uploadedByRole).toBe(UserRole.DRIVER);
      expect(pickupEvidenceDoc!.uploadedAt).toBeInstanceOf(Date);
      expect(pickupEvidenceDoc!.location?.coordinates).toEqual([GARZON.lng, GARZON.lat]);

      // Un código incorrecto no avanza el pedido ni se confunde con éxito.
      const wrongPickupCode = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: '999999' });
      expect(wrongPickupCode.status).toBe(400);
      expect(wrongPickupCode.body.code).toBe('CODE_INVALID');

      // ── 6. CÓDIGO DE RECOGIDA correcto → PAQUETE RECIBIDO ─────────────
      const pickupVerify = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: pickupCode, latitude: GARZON.lat, longitude: GARZON.lng });
      expect(pickupVerify.status).toBe(200);
      expect(pickupVerify.body.data.status).toBe(OrderStatus.PICKED_UP);

      // Código de UN SOLO USO: el mismo código no vuelve a servir.
      const reusePickupCode = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code: pickupCode });
      expect(reusePickupCode.status).toBe(409);

      const securityAfterPickup = await OrderSecurity.findOne({ orderId });
      expect(securityAfterPickup!.pickup.status).toBe(OrderCodeStatus.USED);
      expect(securityAfterPickup!.pickup.verifiedBy!.toString()).toBe(driverUser._id.toString());

      // ── 7. AVISO AL CLIENTE — inmediato, no un rato después ───────────
      const clientNotice = await waitUntil(() =>
        Notification.findOne({
          userId: client._id,
          'data.event': 'delivery_code_ready',
        }).exec()
      );
      expect(clientNotice).toBeTruthy();
      expect(clientNotice!.title).toBeTruthy();
      expect(clientNotice!.body).toContain(orderNumber);

      // ── El domiciliario NUNCA conoce el código de entrega de antemano ─
      const driverFlowAfterPickup = await request(app)
        .get(`/api/v1/orders/${orderId}/flow`)
        .set(authHeader(driverUser));
      expect(driverFlowAfterPickup.body.data.delivery.code).toBeNull();

      // ── 8. RUTA AL CLIENTE — cambia sola, sin que nadie la pida a mano ─
      const routeToClient = await request(app)
        .post(`/api/v1/tracking/orders/${orderId}/route`)
        .set(authHeader(driverUser))
        .send({ lat: GARZON.lat, lng: GARZON.lng });
      expect(routeToClient.status).toBe(200);
      expect(routeToClient.body.data.phase).toBe('to_client');
      expect(routeToClient.body.data.targetAddress).toBe('Calle 5 # 3-21');

      // El cliente ya puede ver (y solo él) el código que le dictará al
      // domiciliario en la puerta — antes de recoger, no podía.
      const clientFlow = await request(app)
        .get(`/api/v1/orders/${orderId}/flow`)
        .set(authHeader(client));
      const deliveryCode = clientFlow.body.data.delivery.code as string;
      expect(deliveryCode).toMatch(/^\d{6}$/);

      // El domiciliario declara que va en camino.
      const onWay = await request(app)
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(authHeader(driverUser))
        .send({ status: 'on_way' });
      expect(onWay.status).toBe(200);

      // La prueba definitiva del rol: "on_way → delivered" YA es una
      // transición legítima —el propio domiciliario la usará en un
      // momento— así que si el cliente recibe 403 aquí es exclusivamente
      // porque su rol no lo permite, no porque la máquina de estados lo
      // hubiera rechazado de todas formas.
      const clientForcesAgain = await request(app)
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(authHeader(client))
        .send({ status: 'delivered' });
      expect(clientForcesAgain.status).toBe(403);

      // SALTO DE ESTADO: el código de entrega tampoco sirve sin llegada.
      const skipArrivalDelivery = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/verify`)
        .set(authHeader(driverUser))
        .send({ code: deliveryCode });
      expect(skipArrivalDelivery.status).toBe(409);
      expect(skipArrivalDelivery.body.code).toBe('DRIVER_NOT_ARRIVED');

      // ── 9. LLEGADA AL DESTINO ──────────────────────────────────────────
      const arriveClient = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/arrive`)
        .set(authHeader(driverUser))
        .send({ latitude: DESTINATION.lat, longitude: DESTINATION.lng });
      expect(arriveClient.status).toBe(200);

      const skipDeliveryEvidence = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/verify`)
        .set(authHeader(driverUser))
        .send({ code: deliveryCode });
      expect(skipDeliveryEvidence.status).toBe(409);
      expect(skipDeliveryEvidence.body.code).toBe('EVIDENCE_REQUIRED');

      // ── 10. FOTO DE ENTREGA ─────────────────────────────────────────────
      const deliveryEvidence = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/evidence`)
        .set(authHeader(driverUser))
        .field('latitude', String(DESTINATION.lat))
        .field('longitude', String(DESTINATION.lng))
        .attach('photo', JPEG_ALT, { filename: 'entrega.jpg', contentType: 'image/jpeg' });
      expect(deliveryEvidence.status).toBe(201);

      const deliveryEvidenceDoc = await OrderEvidence.findById(deliveryEvidence.body.data.id);
      expect(deliveryEvidenceDoc!.uploadedBy.toString()).toBe(driverUser._id.toString());
      expect(deliveryEvidenceDoc!.location?.coordinates).toEqual([DESTINATION.lng, DESTINATION.lat]);

      // ── 11. CÓDIGO DE ENTREGA correcto → ENTREGADO ────────────────────
      const wrongDeliveryCode = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/verify`)
        .set(authHeader(driverUser))
        .send({ code: '555555' });
      expect(wrongDeliveryCode.status).toBe(400);

      const deliverRes = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/verify`)
        .set(authHeader(driverUser))
        .send({ code: deliveryCode, latitude: DESTINATION.lat, longitude: DESTINATION.lng });
      expect(deliverRes.status).toBe(200);
      expect(deliverRes.body.data.status).toBe(OrderStatus.DELIVERED);

      // No se finaliza dos veces el mismo pedido.
      const doubleFinish = await request(app)
        .post(`/api/v1/orders/${orderId}/delivery/verify`)
        .set(authHeader(driverUser))
        .send({ code: deliveryCode });
      expect(doubleFinish.status).toBe(409);

      const doubleStatus = await request(app)
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(authHeader(driverUser))
        .send({ status: 'delivered' });
      expect(doubleStatus.status).toBe(400); // transición inválida: ya está entregado

      // ── 12. Estado final y cadena de custodia completa ────────────────
      const finalOrder = await Order.findById(orderId);
      expect(finalOrder!.status).toBe(OrderStatus.DELIVERED);
      expect(finalOrder!.deliveredAt).toBeInstanceOf(Date);
      expect(finalOrder!.pickedUpAt).toBeInstanceOf(Date);

      const timeline = await request(app)
        .get(`/api/v1/orders/${orderId}/timeline`)
        .set(authHeader(client));
      expect(timeline.status).toBe(200);

      const actions: string[] = timeline.body.data.map((e: any) => e.action);
      const expectedSequence = [
        OrderTimelineAction.ACCEPTED, OrderTimelineAction.PREPARING, OrderTimelineAction.READY,
        OrderTimelineAction.DRIVER_ASSIGNED,
        OrderTimelineAction.ARRIVED_PICKUP, OrderTimelineAction.EVIDENCE_PICKUP,
        OrderTimelineAction.CODE_VERIFIED_PICKUP, OrderTimelineAction.PICKED_UP,
        OrderTimelineAction.ON_WAY,
        OrderTimelineAction.ARRIVED_DELIVERY, OrderTimelineAction.EVIDENCE_DELIVERY,
        OrderTimelineAction.CODE_VERIFIED_DELIVERY, OrderTimelineAction.DELIVERED,
      ];
      // Cada hito aparece, y en el orden causal correcto — no solo "todos
      // presentes", sino "en la secuencia que de verdad ocurrió".
      let cursor = -1;
      for (const step of expectedSequence) {
        const idx = actions.indexOf(step, cursor + 1);
        expect(idx, `falta o está desordenado el hito "${step}" en ${JSON.stringify(actions)}`).toBeGreaterThan(cursor);
        cursor = idx;
      }

      // Cada hito real (no derivado) trae quién lo hizo.
      const realEntries = timeline.body.data.filter((e: any) => !e.derived);
      for (const entry of realEntries) {
        expect(entry.actor, `"${entry.action}" no tiene actor`).toBeTruthy();
      }

      // La foto queda accesible por la ruta de evidencias del pedido, para
      // las tres partes que pueden necesitarla en una disputa.
      const evidenceList = await request(app)
        .get(`/api/v1/orders/${orderId}/evidence`)
        .set(authHeader(owner));
      expect(evidenceList.body.data).toHaveLength(1); // el comercio solo ve la de recogida
      expect(evidenceList.body.data[0].type).toBe(OrderEvidenceType.PICKUP);
    },
    30_000
  );
});

/**
 * Deja un pedido en `ready`, con domiciliario asignado, llegada declarada y
 * evidencia de recogida ya subida — a un solo `POST .../pickup/verify` de
 * distancia. Es el punto de partida que comparten las dos pruebas de abajo:
 * ninguna de las dos quiere repetir el montaje completo del pedido para
 * llegar al momento que de verdad les interesa poner a prueba.
 */
async function readyForPickupCode() {
  const { client, owner, business, product, driverUser } = await setupActors();

  const created = await request(app)
    .post('/api/v1/orders')
    .set(authHeader(client))
    .send({
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });
  const orderId = created.body.data._id as string;

  for (const status of ['accepted', 'preparing', 'ready']) {
    await request(app)
      .patch(`/api/v1/orders/${orderId}/status`)
      .set(authHeader(owner))
      .send({ status });
  }

  await request(app).patch(`/api/v1/orders/${orderId}/assign-driver`).set(authHeader(driverUser));
  await request(app)
    .post(`/api/v1/orders/${orderId}/pickup/arrive`)
    .set(authHeader(driverUser))
    .send({ latitude: GARZON.lat, longitude: GARZON.lng });
  await request(app)
    .post(`/api/v1/orders/${orderId}/pickup/evidence`)
    .set(authHeader(driverUser))
    .attach('photo', JPEG, { filename: 'recepcion.jpg', contentType: 'image/jpeg' });

  const businessFlow = await request(app)
    .get(`/api/v1/orders/${orderId}/flow`)
    .set(authHeader(owner));
  const code = businessFlow.body.data.pickup.code as string;

  return { orderId, client, owner, driverUser, code };
}

describe('AUDITORÍA E2E — resiliencia bajo condiciones reales', () => {
  it(
    'dos peticiones HTTP simultáneas con el mismo código: exactamente una recoge el pedido',
    async () => {
      const { orderId, driverUser, code } = await readyForPickupCode();

      // Dos dispositivos —o el mismo, con doble toque— mandando la misma
      // petición de verdad en paralelo por la red, no dos llamadas
      // secuenciales a un servicio. Es la forma en la que esta condición de
      // carrera ocurriría fuera de una prueba.
      const [first, second] = await Promise.all([
        request(app)
          .post(`/api/v1/orders/${orderId}/pickup/verify`)
          .set(authHeader(driverUser))
          .send({ code }),
        request(app)
          .post(`/api/v1/orders/${orderId}/pickup/verify`)
          .set(authHeader(driverUser))
          .send({ code }),
      ]);

      const statuses = [first.status, second.status].sort();
      // Una gana (200) y la otra pierde con un rechazo — nunca las dos
      // ganan, y ninguna se queda en un limbo (5xx) que sugiera corrupción.
      expect(statuses[0]).toBe(200);
      expect([400, 409]).toContain(statuses[1]);

      const order = await Order.findById(orderId);
      expect(order!.status).toBe(OrderStatus.PICKED_UP);
      expect(order!.pickedUpAt).toBeInstanceOf(Date);

      const security = await OrderSecurity.findOne({ orderId });
      expect(security!.pickup.status).toBe(OrderCodeStatus.USED);

      // Un solo hito de "código validado" en la bitácora, no dos — la
      // petición perdedora no dejó rastro de haber avanzado nada.
      const timeline = await request(app)
        .get(`/api/v1/orders/${orderId}/timeline`)
        .set(authHeader(driverUser));
      const verifiedCount = timeline.body.data.filter(
        (e: any) => e.action === OrderTimelineAction.CODE_VERIFIED_PICKUP
      ).length;
      expect(verifiedCount).toBe(1);
    },
    15_000
  );

  it(
    'si el avance de estado falla después de validar el código, el código se libera y no queda corrupción',
    async () => {
      const { orderId, driverUser, code } = await readyForPickupCode();

      const { orderService } = await import('../services/order.service');
      // Simula el hueco real que el propio servicio documenta: el código se
      // consume, y justo antes de que el pedido cambie de estado, la
      // escritura falla (una conexión que se cae, un timeout de Mongo). No
      // se sustituye nada del flujo de seguridad — solo se hace fallar, una
      // única vez, el paso que viene después de consumir el código.
      // `mockImplementationOnce` solo cubre la próxima llamada: en cuanto
      // se consume, `vi.spyOn` vuelve a delegar en la implementación real
      // por sí solo, sin que haga falta restaurarlo a mano para el reintento.
      vi.spyOn(orderService, 'updateStatus').mockImplementationOnce(async () => {
        throw new Error('Fallo de red simulado: la escritura no llegó a Mongo');
      });

      const failed = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code });

      // La petición no puede reportar éxito: algo se rompió a mitad de camino.
      expect(failed.status).toBeGreaterThanOrEqual(500);

      // El pedido se queda exactamente donde estaba — no "medio recogido".
      const stuck = await Order.findById(orderId);
      expect(stuck!.status).toBe(OrderStatus.READY);
      expect(stuck!.pickedUpAt).toBeFalsy();

      // Y el código, que se había marcado USED antes del fallo, vuelve a
      // estar disponible: la anomalía no deja al domiciliario con un
      // código válido convertido en inservible para siempre.
      const releasedSecurity = await OrderSecurity.findOne({ orderId });
      expect(releasedSecurity!.pickup.status).toBe(OrderCodeStatus.PENDING);
      expect(releasedSecurity!.pickup.usedAt).toBeNull();

      // Con el fallo ya no presente, el MISMO código —liberado, no uno
      // nuevo— completa la recogida sin que haga falta reemitir nada.
      const retried = await request(app)
        .post(`/api/v1/orders/${orderId}/pickup/verify`)
        .set(authHeader(driverUser))
        .send({ code });
      expect(retried.status).toBe(200);

      const recovered = await Order.findById(orderId);
      expect(recovered!.status).toBe(OrderStatus.PICKED_UP);

      // Y el intento anulado quedó dicho en la bitácora — no desaparece,
      // porque es justo la clase de anomalía que soporte necesita ver.
      const timeline = await request(app)
        .get(`/api/v1/orders/${orderId}/timeline`)
        .set(authHeader(driverUser));
      const verifiedEntries = timeline.body.data.filter(
        (e: any) => e.action === OrderTimelineAction.CODE_VERIFIED_PICKUP
      );
      // Se registró la validación del intento anulado y la del que sí
      // completó la recogida: la bitácora cuenta la anomalía, no la oculta.
      expect(verifiedEntries.length).toBe(2);

      vi.restoreAllMocks();
    },
    15_000
  );
});
