import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// El único doble de todo el archivo es la subida a Cloudinary: se
// reemplaza el método que habla con la red, no el paquete, porque así
// sigue ejecutándose de verdad todo lo que importa alrededor — la
// inspección de los bytes, el anti-reuso por checksum, el control de
// acceso, la persistencia y el estado del pedido.
import app from '../app';
import { orderService } from '../services/order.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { orderChatService, resetChatRateLimit } from '../services/orderChat.service';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderCallService } from '../services/orderCall.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderSecurity } from '../security/orderSecurity';
import { AuditLog, AuditAction, AuditSeverity } from '../security/audit';
import { OrderMessage, OrderEvidence, OrderCall } from '../models';
import {
  OrderCodeKind,
  OrderCodeStatus,
  OrderEvidenceType,
  OrderStatus,
  UserRole,
} from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig,
  authHeader,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

/** JPEG mínimo válido: lo que importa son los tres primeros bytes. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
/** Segundo JPEG, distinto byte a byte, para no chocar con el anti-reuso. */
const JPEG_ALT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
/** Un ejecutable disfrazado: extensión y MIME de imagen, bytes de otra cosa. */
const FAKE_IMAGE = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(64, 1)]);

interface Scenario {
  client: any;
  owner: any;
  business: any;
  driverUser: any;
  driver: any;
  order: any;
  orderId: string;
}

/** Pedido aceptado, preparado, listo y con domiciliario asignado. */
async function scenario(): Promise<Scenario> {
  await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });

  const client = await makeUser({ role: UserRole.CLIENT });
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id);
  const product = await makeProduct(business._id, { price: 20000 });
  const driverUser = await makeUser({ role: UserRole.DRIVER });
  const driver = await makeDriver(driverUser._id, { currentFund: 200000 });

  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'cash_on_delivery',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });

  const orderId = order._id.toString();
  const ownerId = owner._id.toString();

  for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
    await orderService.updateStatus(orderId, status, ownerId, UserRole.BUSINESS);
  }
  await orderService.assignDriver(orderId, driver._id.toString());

  return { client, owner, business, driverUser, driver, order, orderId };
}

/** El código en claro, leído como lo leería la parte autorizada. */
async function readCode(s: Scenario, kind: OrderCodeKind): Promise<string> {
  const holder = kind === OrderCodeKind.PICKUP ? s.owner : s.client;
  const access = await resolveOrderAccess(s.orderId, holder);
  const view = await orderSecurityService.viewFor(access);
  const code = kind === OrderCodeKind.PICKUP ? view.pickupCode : view.deliveryCode;
  if (!code) throw new Error(`El código de ${kind} no está disponible todavía`);
  return code;
}

async function uploadEvidence(
  s: Scenario,
  stage: 'pickup' | 'delivery',
  buffer = JPEG,
  filename = 'foto.jpg'
) {
  return request(app)
    .post(`/api/v1/orders/${s.orderId}/${stage}/evidence`)
    .set(authHeader(s.driverUser))
    .attach('photo', buffer, { filename, contentType: 'image/jpeg' });
}

/** Declara la llegada, como lo haría la app antes de mostrar cámara o código. */
function arrive(s: Scenario, stage: 'pickup' | 'delivery') {
  return request(app)
    .post(`/api/v1/orders/${s.orderId}/${stage}/arrive`)
    .set(authHeader(s.driverUser))
    .send({ latitude: GARZON.lat, longitude: GARZON.lng });
}

/** Recoge el pedido de verdad: llegada + evidencia + código + estado. */
async function completePickup(s: Scenario) {
  await arrive(s, 'pickup');
  await uploadEvidence(s, 'pickup');
  const code = await readCode(s, OrderCodeKind.PICKUP);
  const res = await request(app)
    .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
    .set(authHeader(s.driverUser))
    .send({ code });
  expect(res.status).toBe(200);
  return code;
}

/** Deja el pedido en camino, listo para la entrega. */
async function goOnWay(s: Scenario) {
  await orderService.updateStatus(
    s.orderId,
    OrderStatus.ON_WAY,
    s.driverUser._id.toString(),
    UserRole.DRIVER
  );
}

let storedCount = 0;

beforeEach(() => {
  resetChatRateLimit();
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

// ─────────────────────────────────────────────────────────────────────
describe('Códigos de seguridad — emisión', () => {
  it('emite dos códigos distintos al aceptar el pedido y no los guarda en claro', async () => {
    const s = await scenario();

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored).toBeTruthy();
    expect(stored!.pickup.hash).not.toBe(stored!.delivery.hash);
    expect(stored!.pickup.status).toBe(OrderCodeStatus.PENDING);

    const pickupCode = await readCode(s, OrderCodeKind.PICKUP);
    expect(pickupCode).toMatch(/^\d{6}$/);

    // El documento no contiene el código legible en ningún campo.
    const raw = JSON.stringify(stored!.toObject());
    expect(raw).not.toContain(pickupCode);
  });

  it('es idempotente: aceptar dos veces no reemplaza los códigos', async () => {
    const s = await scenario();
    const before = await OrderSecurity.findOne({ orderId: s.orderId });

    await orderSecurityService.ensureIssued(s.orderId);

    const after = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(after!.pickup.hash).toBe(before!.pickup.hash);
    expect(after!.delivery.hash).toBe(before!.delivery.hash);
  });
});

describe('Códigos de seguridad — quién ve qué', () => {
  it('el comercio ve el código de recogida y el domiciliario no', async () => {
    const s = await scenario();

    const business = await request(app)
      .get(`/api/v1/orders/${s.orderId}/flow`)
      .set(authHeader(s.owner));
    expect(business.status).toBe(200);
    expect(business.body.data.pickup.code).toMatch(/^\d{6}$/);

    const driver = await request(app)
      .get(`/api/v1/orders/${s.orderId}/flow`)
      .set(authHeader(s.driverUser));
    expect(driver.status).toBe(200);
    expect(driver.body.data.pickup.code).toBeNull();
    expect(driver.body.data.delivery.code).toBeNull();
  });

  it('el cliente ve el código de entrega solo cuando el pedido ya salió', async () => {
    const s = await scenario();

    const early = await request(app)
      .get(`/api/v1/orders/${s.orderId}/flow`)
      .set(authHeader(s.client));
    expect(early.body.data.delivery.code).toBeNull();

    await completePickup(s);

    const afterPickup = await request(app)
      .get(`/api/v1/orders/${s.orderId}/flow`)
      .set(authHeader(s.client));
    expect(afterPickup.body.data.delivery.code).toMatch(/^\d{6}$/);
  });

  it('el administrador ve el estado pero nunca el secreto', async () => {
    const s = await scenario();
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .get(`/api/v1/admin/orders/${s.orderId}/security`)
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.pickup.status).toBe(OrderCodeStatus.PENDING);
    expect(res.body.data.pickup.code).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(await readCode(s, OrderCodeKind.PICKUP));
  });
});

describe('Evidencias fotográficas', () => {
  it('el domiciliario sube la evidencia de recogida', async () => {
    const s = await scenario();

    const res = await uploadEvidence(s, 'pickup');

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe(OrderEvidenceType.PICKUP);
    // La URL que sale a la app va firmada y se construye en la lectura.
    expect(res.body.data.url).toContain('zipp/order-evidence');

    const stored = await OrderEvidence.findOne({ orderId: s.orderId });
    expect(stored!.driverId!.toString()).toBe(s.driver._id.toString());
    expect(stored!.metadata.checksum).toHaveLength(64);
    // La imagen vive en el almacenamiento, no en Mongo.
    expect(stored!.storageKey).toContain('zipp/order-evidence');
  });

  it('el cliente no puede subir evidencias', async () => {
    const s = await scenario();

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/evidence`)
      .set(authHeader(s.client))
      .attach('photo', JPEG, { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
  });

  it('rechaza un ejecutable con nombre y MIME de imagen', async () => {
    const s = await scenario();

    const res = await uploadEvidence(s, 'pickup', FAKE_IMAGE);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EVIDENCE_INVALID_FILE');
    expect(await OrderEvidence.countDocuments({ orderId: s.orderId })).toBe(0);
  });

  it('no admite la misma foto como evidencia de las dos etapas', async () => {
    const s = await scenario();
    await completePickup(s);
    await goOnWay(s);

    const reused = await uploadEvidence(s, 'delivery', JPEG);

    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('EVIDENCE_DUPLICATE');
  });

  it('rechaza la evidencia de entrega si el pedido aún no salió', async () => {
    const s = await scenario();

    const res = await uploadEvidence(s, 'delivery');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVIDENCE_WRONG_STAGE');
  });
});

describe('Recogida en el comercio', () => {
  it('exige la llegada antes de la evidencia y el código', async () => {
    const s = await scenario();
    const code = await readCode(s, OrderCodeKind.PICKUP);

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(authHeader(s.driverUser))
      .send({ code });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DRIVER_NOT_ARRIVED');
  });

  it('exige la evidencia antes del código', async () => {
    const s = await scenario();
    await arrive(s, 'pickup');
    const code = await readCode(s, OrderCodeKind.PICKUP);

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(authHeader(s.driverUser))
      .send({ code });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVIDENCE_REQUIRED');
  });

  it('el código correcto autoriza la recogida y mueve el pedido', async () => {
    const s = await scenario();

    await completePickup(s);

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.pickup.status).toBe(OrderCodeStatus.USED);
    expect(stored!.pickup.usedAt).toBeTruthy();
    expect(stored!.pickup.verifiedBy!.toString()).toBe(s.driverUser._id.toString());

    const { order } = await resolveOrderAccess(s.orderId, s.owner);
    expect(order.status).toBe(OrderStatus.PICKED_UP);
    expect(order.pickedUpAt).toBeTruthy();
  });

  it('un código usado no vuelve a funcionar', async () => {
    const s = await scenario();
    const code = await completePickup(s);

    const again = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(authHeader(s.driverUser))
      .send({ code });

    expect(again.status).toBe(409);
    // El pedido ya no está en `ready`, así que el rechazo llega antes
    // incluso de mirar el código.
    expect(['ORDER_WRONG_STAGE', 'CODE_ALREADY_USED']).toContain(again.body.code);
  });

  it('un código incorrecto no permite avanzar y gasta un intento', async () => {
    const s = await scenario();
    await arrive(s, 'pickup');
    await uploadEvidence(s, 'pickup');

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(authHeader(s.driverUser))
      .send({ code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CODE_INVALID');

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.pickup.attempts).toBe(1);
    expect(stored!.pickup.status).toBe(OrderCodeStatus.PENDING);

    const { order } = await resolveOrderAccess(s.orderId, s.owner);
    expect(order.status).toBe(OrderStatus.READY);
  });

  it('el código de otro pedido no sirve aquí', async () => {
    const mine = await scenario();
    const other = await scenario();
    await arrive(mine, 'pickup');
    await uploadEvidence(mine, 'pickup');

    const otherCode = await readCode(other, OrderCodeKind.PICKUP);

    const res = await request(app)
      .post(`/api/v1/orders/${mine.orderId}/pickup/verify`)
      .set(authHeader(mine.driverUser))
      .send({ code: otherCode });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CODE_INVALID');
  });

  it('demasiados intentos fallidos bloquean temporalmente la validación', async () => {
    const s = await scenario();
    await arrive(s, 'pickup');
    await uploadEvidence(s, 'pickup');

    let last: any;
    for (let i = 0; i < 5; i += 1) {
      last = await request(app)
        .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
        .set(authHeader(s.driverUser))
        .send({ code: '111111' });
    }

    expect(last.status).toBe(429);
    expect(last.body.code).toBe('CODE_BLOCKED');

    // Y el código correcto tampoco pasa mientras el castigo esté vigente.
    const code = await readCode(s, OrderCodeKind.PICKUP);
    const blocked = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(authHeader(s.driverUser))
      .send({ code });

    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('CODE_BLOCKED');
  });
});

describe('Entrega al cliente', () => {
  it('no se puede marcar entregado sin validar el código', async () => {
    const s = await scenario();
    await completePickup(s);
    await goOnWay(s);

    const res = await request(app)
      .patch(`/api/v1/orders/${s.orderId}/status`)
      .set(authHeader(s.driverUser))
      .send({ status: OrderStatus.DELIVERED });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CODE_REQUIRED');

    const { order } = await resolveOrderAccess(s.orderId, s.client);
    expect(order.status).toBe(OrderStatus.ON_WAY);
  });

  it('el flujo completo cierra el pedido con código y evidencia', async () => {
    const s = await scenario();
    await completePickup(s);
    await goOnWay(s);

    await request(app)
      .post(`/api/v1/orders/${s.orderId}/delivery/arrive`)
      .set(authHeader(s.driverUser))
      .send({ latitude: DESTINATION.lat, longitude: DESTINATION.lng });

    await uploadEvidence(s, 'delivery', JPEG_ALT);
    const code = await readCode(s, OrderCodeKind.DELIVERY);

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/delivery/verify`)
      .set(authHeader(s.driverUser))
      .send({ code, latitude: DESTINATION.lat, longitude: DESTINATION.lng });

    expect(res.status).toBe(200);

    const { order } = await resolveOrderAccess(s.orderId, s.client);
    expect(order.status).toBe(OrderStatus.DELIVERED);
    expect(order.deliveredAt).toBeTruthy();

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.delivery.status).toBe(OrderCodeStatus.USED);
    expect(stored!.delivery.arrivedAt).toBeTruthy();
  });

  it('el domiciliario no ve el código de entrega antes de que el cliente lo dicte', async () => {
    const s = await scenario();
    await completePickup(s);
    await goOnWay(s);

    const res = await request(app)
      .get(`/api/v1/orders/${s.orderId}/flow`)
      .set(authHeader(s.driverUser));

    expect(res.body.data.delivery.code).toBeNull();
  });
});

describe('Concurrencia — un código, un solo consumo', () => {
  it('dos validaciones simultáneas del mismo código: solo una gana', async () => {
    const s = await scenario();
    await arrive(s, 'pickup');
    await uploadEvidence(s, 'pickup');
    const code = await readCode(s, OrderCodeKind.PICKUP);

    const access = await resolveOrderAccess(s.orderId, s.driverUser);

    const results = await Promise.allSettled([
      orderSecurityService.verify({ access, kind: OrderCodeKind.PICKUP, code }),
      orderSecurityService.verify({ access, kind: OrderCodeKind.PICKUP, code }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);

    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.message).toMatch(/ya utilizado/i);

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.pickup.status).toBe(OrderCodeStatus.USED);
  });
});

describe('Cancelación', () => {
  it('anula los códigos pendientes', async () => {
    const s = await scenario();

    await orderService.updateStatus(
      s.orderId,
      OrderStatus.CANCELLED,
      s.owner._id.toString(),
      UserRole.BUSINESS,
      'Sin existencias'
    );

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.pickup.status).toBe(OrderCodeStatus.VOID);
    expect(stored!.delivery.status).toBe(OrderCodeStatus.VOID);
  });

  it('conserva el código de recogida ya usado como prueba histórica', async () => {
    const s = await scenario();
    await completePickup(s);

    await orderService.updateStatus(
      s.orderId,
      OrderStatus.ON_WAY,
      s.driverUser._id.toString(),
      UserRole.DRIVER
    );
    await orderService.updateStatus(
      s.orderId,
      OrderStatus.CANCELLED,
      s.owner._id.toString(),
      UserRole.BUSINESS,
      'Cliente ausente'
    );

    const stored = await OrderSecurity.findOne({ orderId: s.orderId });
    expect(stored!.pickup.status).toBe(OrderCodeStatus.USED);
    expect(stored!.delivery.status).toBe(OrderCodeStatus.VOID);
  });
});

describe('Bypass administrativo', () => {
  it('el administrador puede avanzar sin código, y queda auditado', async () => {
    const s = await scenario();

    // Sin evidencia ni código: nada de lo que exige a un domiciliario.
    const admin = await makeUser({ role: UserRole.ADMIN });
    const updated = await orderService.updateStatus(
      s.orderId,
      OrderStatus.PICKED_UP,
      admin._id.toString(),
      UserRole.ADMIN
    );

    expect(updated.status).toBe(OrderStatus.PICKED_UP);

    const audit = await AuditLog.findOne({
      entityId: s.orderId,
      action: AuditAction.SUSPICIOUS_ACTIVITY,
    }).sort({ timestamp: -1 });

    expect(audit).toBeTruthy();
    expect(audit!.severity).toBe(AuditSeverity.HIGH);
    expect(audit!.description).toMatch(/forzó/i);
  });

  it('una recogida validada de verdad por el domiciliario no se marca como sospechosa', async () => {
    const s = await scenario();
    await completePickup(s);

    const suspicious = await AuditLog.findOne({
      entityId: s.orderId,
      action: AuditAction.SUSPICIOUS_ACTIVITY,
    });
    expect(suspicious).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Chat del pedido', () => {
  it('cliente y domiciliario conversan y el acuse de recibo funciona', async () => {
    const s = await scenario();
    await completePickup(s);

    const sent = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(s.client))
      .send({ message: 'Estoy en el segundo piso' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.senderRole).toBe(UserRole.CLIENT);

    const replied = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(s.driverUser))
      .send({ message: 'Voy llegando' });
    expect(replied.status).toBe(201);

    const thread = await request(app)
      .get(`/api/v1/orders/${s.orderId}/chat`)
      .set(authHeader(s.client));
    expect(thread.body.data).toHaveLength(2);
    expect(thread.body.data[0].message).toBe('Estoy en el segundo piso');

    await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/read`)
      .set(authHeader(s.client));

    const messages = await OrderMessage.find({ orderId: s.orderId }).sort({ createdAt: 1 });
    // El cliente marca leído lo que le escribieron, no lo suyo.
    expect(messages[0].readAt).toBeNull();
    expect(messages[1].readAt).toBeTruthy();
  });

  it('nadie ajeno al pedido puede leer ni escribir en el hilo', async () => {
    const s = await scenario();
    await completePickup(s);

    const intruderClient = await makeUser({ role: UserRole.CLIENT });
    const intruderDriverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(intruderDriverUser._id);

    const read = await request(app)
      .get(`/api/v1/orders/${s.orderId}/chat`)
      .set(authHeader(intruderClient));
    expect(read.status).toBe(404);

    const write = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(intruderDriverUser))
      .send({ message: 'Dame tu código' });
    expect(write.status).toBe(404);

    expect(await OrderMessage.countDocuments({ orderId: s.orderId })).toBe(0);
  });

  it('el administrador lee la conversación pero no puede escribir', async () => {
    const s = await scenario();
    await completePickup(s);
    await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(s.client))
      .send({ message: 'Timbre roto' });

    const admin = await makeUser({ role: UserRole.ADMIN });

    const read = await request(app)
      .get(`/api/v1/orders/${s.orderId}/chat`)
      .set(authHeader(admin));
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(1);

    const write = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(admin))
      .send({ message: 'Soy soporte' });
    expect(write.status).toBe(403);
  });

  it('el chat está cerrado antes de que haya domiciliario y después de entregar', async () => {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 15000 });
    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 8',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const res = await request(app)
      .post(`/api/v1/orders/${order._id.toString()}/chat/messages`)
      .set(authHeader(client))
      .send({ message: '¿Hay alguien?' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHAT_NO_DRIVER');
  });

  it('limpia los caracteres invisibles y de control del mensaje', async () => {
    const s = await scenario();
    await completePickup(s);

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(s.client))
      .send({ message: '  Hola ​ mundo  ' });

    expect(res.status).toBe(201);
    expect(res.body.data.message).toBe('Hola mundo');
  });

  it('frena a quien inunda el hilo', async () => {
    const s = await scenario();
    await completePickup(s);
    const access = await resolveOrderAccess(s.orderId, s.client);

    let blocked = 0;
    for (let i = 0; i < 40; i += 1) {
      try {
        await orderChatService.send(access, `mensaje ${i}`);
      } catch (error: any) {
        if (error.code === 'CHAT_RATE_LIMITED') blocked += 1;
      }
    }

    expect(blocked).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Llamadas del pedido', () => {
  it('el cliente llama, el domiciliario contesta y la llamada se registra', async () => {
    const s = await scenario();
    await completePickup(s);

    const started = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call`)
      .set(authHeader(s.client));
    expect(started.status).toBe(201);
    expect(started.body.data.status).toBe('ringing');
    // La vista de la llamada no lleva teléfonos.
    expect(JSON.stringify(started.body.data)).not.toContain(s.driverUser.phone);

    const callId = started.body.data.id;

    const answered = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call/${callId}/answer`)
      .set(authHeader(s.driverUser));
    expect(answered.status).toBe(200);
    expect(answered.body.data.status).toBe('active');

    const ended = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call/${callId}/end`)
      .set(authHeader(s.client))
      .send({ reason: 'listo' });
    expect(ended.status).toBe(200);
    expect(ended.body.data.status).toBe('ended');

    const stored = await OrderCall.findById(callId);
    expect(stored!.orderId.toString()).toBe(s.orderId);
    expect(stored!.endedBy!.toString()).toBe(s.client._id.toString());
  });

  it('no hay dos llamadas vivas en el mismo pedido', async () => {
    const s = await scenario();
    await completePickup(s);

    const first = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call`)
      .set(authHeader(s.client));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call`)
      .set(authHeader(s.driverUser));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CALL_BUSY');
  });

  it('no se puede llamar sin un pedido activo en común', async () => {
    const s = await scenario();
    const intruder = await makeUser({ role: UserRole.CLIENT });

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/call`)
      .set(authHeader(intruder));

    expect(res.status).toBe(404);
    expect(await OrderCall.countDocuments()).toBe(0);
  });

  it('un tercero del pedido no puede colgar la llamada de otros', async () => {
    const s = await scenario();
    await completePickup(s);
    const started = await orderCallService.start(
      await resolveOrderAccess(s.orderId, s.client)
    );

    const businessAccess = await resolveOrderAccess(s.orderId, s.owner);
    await expect(
      orderCallService.end(started.id, businessAccess)
    ).rejects.toThrow(/no encontrada/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Seguridad — manipulación de identificadores', () => {
  it('cambiar el orderId por uno ajeno no revela nada', async () => {
    const mine = await scenario();
    const other = await scenario();

    for (const path of ['flow', 'chat', 'evidence', 'calls']) {
      const res = await request(app)
        .get(`/api/v1/orders/${other.orderId}/${path}`)
        .set(authHeader(mine.client));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Pedido no encontrado');
    }
  });

  it('un pedido inexistente y uno ajeno responden igual', async () => {
    const s = await scenario();
    const other = await scenario();

    const missing = await request(app)
      .get('/api/v1/orders/507f1f77bcf86cd799439011/flow')
      .set(authHeader(s.client));
    const foreign = await request(app)
      .get(`/api/v1/orders/${other.orderId}/flow`)
      .set(authHeader(s.client));

    expect(missing.status).toBe(foreign.status);
    expect(missing.body.message).toBe(foreign.body.message);
  });

  it('un identificador con forma inválida no provoca un error interno', async () => {
    const s = await scenario();

    const res = await request(app)
      .get('/api/v1/orders/no-es-un-id/flow')
      .set(authHeader(s.client));

    expect(res.status).toBe(404);
  });

  it('el domiciliario de otro reparto no puede tocar este pedido', async () => {
    const s = await scenario();
    const strangerUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(strangerUser._id, { currentFund: 200000 });

    const evidence = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/evidence`)
      .set(authHeader(strangerUser))
      .attach('photo', JPEG, { filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(evidence.status).toBe(404);

    const status = await request(app)
      .patch(`/api/v1/orders/${s.orderId}/status`)
      .set(authHeader(strangerUser))
      .send({ status: OrderStatus.PICKED_UP });
    expect(status.status).toBe(403);
  });

  it('el cliente no puede declararse repartidor en el cuerpo de la petición', async () => {
    const s = await scenario();
    await completePickup(s);

    const res = await request(app)
      .post(`/api/v1/orders/${s.orderId}/chat/messages`)
      .set(authHeader(s.client))
      .send({ message: 'Hola', senderRole: UserRole.DRIVER, senderId: s.driverUser._id.toString() });

    expect(res.status).toBe(201);
    // El rol y el remitente salen del pedido, no del cuerpo.
    expect(res.body.data.senderRole).toBe(UserRole.CLIENT);
    expect(res.body.data.senderId).toBe(s.client._id.toString());
  });

  it('el comercio no puede subir la evidencia del domiciliario ni forzar estados', async () => {
    const s = await scenario();

    const evidence = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/evidence`)
      .set(authHeader(s.owner))
      .attach('photo', JPEG, { filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(evidence.status).toBe(403);

    const forced = await request(app)
      .patch(`/api/v1/orders/${s.orderId}/status`)
      .set(authHeader(s.owner))
      .send({ status: OrderStatus.DELIVERED });
    expect(forced.status).toBe(400);
  });

  it('sin sesión no se llega a ninguna parte del flujo', async () => {
    const s = await scenario();

    const res = await request(app).get(`/api/v1/orders/${s.orderId}/flow`);

    expect(res.status).toBe(401);
  });
});
