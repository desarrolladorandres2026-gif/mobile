import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import app from '../app';
import { orderService } from '../services/order.service';
import { orderEvidenceService } from '../services/orderEvidence.service';
import { orderSecurityService } from '../services/orderSecurity.service';
import { payoutService } from '../services/payout.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { Order, Payout } from '../models';
import {
  OrderCodeKind,
  OrderStatus,
  OrderTimelineAction,
  PaymentStatus,
  PayoutBeneficiary,
  PayoutStatus,
  UserRole,
} from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver,
  makePricingConfig, authHeader,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const JPEG_ALT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);

interface Scenario {
  client: any;
  owner: any;
  business: any;
  driverUser: any;
  driver: any;
  orderId: string;
}

/**
 * Un pedido llevado por HTTP desde que se crea hasta que está listo.
 *
 * Va por la API y no por los servicios a propósito: la mitad de lo que
 * esta prueba comprueba —quién firma cada hito— solo existe si el
 * controlador pasa el actor, y llamar al servicio directamente saltaría
 * justo esa parte.
 */
async function scenario(paymentMethod = 'cash_on_delivery'): Promise<Scenario> {
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
    paymentMethod,
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });

  const orderId = order._id.toString();

  // Un pedido en línea no se puede aceptar hasta que la pasarela confirme
  // el cobro. No es un atajo de la prueba: es la puerta que impide que un
  // comercio cocine para un checkout abandonado.
  if (paymentMethod === 'online') {
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: PaymentStatus.PAID } });
  }

  for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
    const res = await request(app)
      .patch(`/api/v1/orders/${orderId}/status`)
      .set(await authHeader(owner))
      .send({ status });
    expect(res.status).toBe(200);
  }

  const assigned = await request(app)
    .patch(`/api/v1/orders/${orderId}/assign-driver`)
    .set(await authHeader(driverUser))
    .send({});
  expect(assigned.status).toBe(200);

  return { client, owner, business, driverUser, driver, orderId };
}

async function readCode(s: Scenario, kind: OrderCodeKind): Promise<string> {
  const holder = kind === OrderCodeKind.PICKUP ? s.owner : s.client;
  const access = await resolveOrderAccess(s.orderId, holder);
  const view = await orderSecurityService.viewFor(access);
  const code = kind === OrderCodeKind.PICKUP ? view.pickupCode : view.deliveryCode;
  if (!code) throw new Error(`El código de ${kind} no está disponible`);
  return code;
}

/** Recorre el traspaso completo por HTTP: llegadas, fotos y códigos. */
async function runHandover(s: Scenario) {
  await request(app).post(`/api/v1/orders/${s.orderId}/pickup/arrive`).set(await authHeader(s.driverUser)).send({});
  await request(app)
    .post(`/api/v1/orders/${s.orderId}/pickup/evidence`)
    .set(await authHeader(s.driverUser))
    .attach('photo', JPEG, { filename: 'recogida.jpg', contentType: 'image/jpeg' });
  const pickupCode = await readCode(s, OrderCodeKind.PICKUP);
  const picked = await request(app)
    .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
    .set(await authHeader(s.driverUser))
    .send({ code: pickupCode });
  expect(picked.status).toBe(200);

  await request(app)
    .patch(`/api/v1/orders/${s.orderId}/status`)
    .set(await authHeader(s.driverUser))
    .send({ status: OrderStatus.ON_WAY });

  await request(app).post(`/api/v1/orders/${s.orderId}/delivery/arrive`).set(await authHeader(s.driverUser)).send({});
  await request(app)
    .post(`/api/v1/orders/${s.orderId}/delivery/evidence`)
    .set(await authHeader(s.driverUser))
    .attach('photo', JPEG_ALT, { filename: 'entrega.jpg', contentType: 'image/jpeg' });
  const deliveryCode = await readCode(s, OrderCodeKind.DELIVERY);
  const delivered = await request(app)
    .post(`/api/v1/orders/${s.orderId}/delivery/verify`)
    .set(await authHeader(s.driverUser))
    .send({ code: deliveryCode });
  expect(delivered.status).toBe(200);
}

let storedCount = 0;

beforeEach(() => {
  storedCount = 0;
  vi.spyOn(orderEvidenceService as any, 'store').mockImplementation(async (...args: unknown[]) => {
    const orderId = args[1] as string;
    storedCount += 1;
    return {
      publicId: `zipp/order-evidence/${orderId}/foto-${storedCount}`,
      url: `https://res.cloudinary.test/${orderId}-${storedCount}.jpg`,
      width: 800,
      height: 600,
      bytes: 4096,
    };
  });
});

describe('Línea de tiempo del pedido', () => {
  it('registra los trece hitos del recorrido, cada uno con su actor', async () => {
    const s = await scenario();
    await runHandover(s);

    const res = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(s.owner));

    expect(res.status).toBe(200);
    const actions = res.body.data.map((entry: any) => entry.action);

    // El recorrido completo que pide el negocio, en orden.
    expect(actions).toEqual([
      OrderTimelineAction.CREATED,
      OrderTimelineAction.ACCEPTED,
      OrderTimelineAction.PREPARING,
      OrderTimelineAction.READY,
      OrderTimelineAction.DRIVER_ASSIGNED,
      OrderTimelineAction.ARRIVED_PICKUP,
      OrderTimelineAction.EVIDENCE_PICKUP,
      OrderTimelineAction.CODE_VERIFIED_PICKUP,
      OrderTimelineAction.PICKED_UP,
      OrderTimelineAction.ON_WAY,
      OrderTimelineAction.ARRIVED_DELIVERY,
      OrderTimelineAction.EVIDENCE_DELIVERY,
      OrderTimelineAction.CODE_VERIFIED_DELIVERY,
      OrderTimelineAction.DELIVERED,
    ]);

    const accepted = res.body.data.find(
      (entry: any) => entry.action === OrderTimelineAction.ACCEPTED
    );
    expect(accepted.actor.id).toBe(s.owner._id.toString());
    expect(accepted.actor.name).toBe(s.owner.name);
    expect(accepted.derived).toBe(false);

    const created = res.body.data.find(
      (entry: any) => entry.action === OrderTimelineAction.CREATED
    );
    expect(created.actor.id).toBe(s.client._id.toString());
  });

  it('marca como derivados los hitos que solo existen como fecha en el pedido', async () => {
    const s = await scenario();

    // Un pedido anterior a la bitácora: se borran sus eventos y solo
    // quedan las marcas de tiempo del documento.
    const { OrderEvent } = await import('../security/orderSecurity');
    await OrderEvent.deleteMany({ orderId: s.orderId });

    const res = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(s.owner));

    expect(res.status).toBe(200);
    const actions = res.body.data.map((entry: any) => entry.action);

    // `acceptedAt` y `preparedAt` siguen en el pedido: la historia se
    // reconstruye, pero sin firmar a nadie.
    expect(actions).toContain(OrderTimelineAction.CREATED);
    expect(actions).toContain(OrderTimelineAction.ACCEPTED);
    expect(actions).toContain(OrderTimelineAction.PREPARING);
    expect(res.body.data.every((entry: any) => entry.derived)).toBe(true);
    expect(res.body.data.every((entry: any) => entry.actor === null)).toBe(true);
  });

  it('deja la telemetría del actor solo para administración', async () => {
    const s = await scenario();
    const admin = await makeUser({ role: UserRole.ADMIN });

    const asBusiness = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(s.owner));
    const asAdmin = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(admin));

    expect(asBusiness.body.data.every((e: any) => e.forensics === undefined)).toBe(true);
    expect(asAdmin.body.data.some((e: any) => e.forensics?.ip)).toBe(true);
  });

  it('registra el intento fallido de código como incidencia', async () => {
    const s = await scenario();
    await request(app).post(`/api/v1/orders/${s.orderId}/pickup/arrive`).set(await authHeader(s.driverUser)).send({});
    await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/evidence`)
      .set(await authHeader(s.driverUser))
      .attach('photo', JPEG, { filename: 'recogida.jpg', contentType: 'image/jpeg' });

    const failed = await request(app)
      .post(`/api/v1/orders/${s.orderId}/pickup/verify`)
      .set(await authHeader(s.driverUser))
      .send({ code: '000000' });
    expect(failed.status).toBe(400);

    const res = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(s.owner));

    const incident = res.body.data.find(
      (entry: any) => entry.action === OrderTimelineAction.CODE_FAILED_PICKUP
    );
    expect(incident).toBeTruthy();
    expect(incident.incident).toBe(true);
    // El motivo sí; el código tecleado jamás.
    expect(JSON.stringify(incident)).not.toContain('000000');
  });

  it('no se la entrega a quien no participa en el pedido', async () => {
    const s = await scenario();
    const stranger = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .get(`/api/v1/orders/${s.orderId}/timeline`)
      .set(await authHeader(stranger));

    // 404 y no 403: distinguirlos convertiría el endpoint en un oráculo
    // para enumerar pedidos ajenos.
    expect(res.status).toBe(404);
  });
});

describe('Extracto de liquidación del comercio', () => {
  it('desglosa venta, comisión y ajustes con los mismos números del pedido', async () => {
    const s = await scenario();
    await runHandover(s);

    const res = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement`)
      .set(await authHeader(s.owner));

    expect(res.status).toBe(200);
    const { data } = res.body;

    const order = await orderService.getById(s.orderId);
    const finance = order.finance;

    // La identidad que pide el negocio: VENTA − COMISIÓN ± AJUSTES = NETO.
    const week = data.weeks[0];
    expect(week.productSubtotal).toBe(finance.productSubtotal);
    expect(week.merchantCommission).toBe(finance.merchantCommission);
    expect(week.netAmount).toBe(
      week.productSubtotal - week.merchantCommission - week.merchantFundedDiscount
    );
    expect(week.netAmount).toBe(finance.businessPayout);
  });

  it('cuenta en la próxima liquidación lo que aún no se ha pagado', async () => {
    const s = await scenario('online');

    const before = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement`)
      .set(await authHeader(s.owner));

    const order = await orderService.getById(s.orderId);
    expect(before.body.data.nextSettlement.orderCount).toBe(1);
    expect(before.body.data.nextSettlement.netAmount).toBe(order.finance.businessPayout);
    expect(before.body.data.outstanding).toBe(order.finance.businessPayout);
  });

  it('enlaza cada venta con la liquidación que la pagó, en los dos sentidos', async () => {
    const s = await scenario('online');

    // El dinero ya entró por la pasarela, así que los payouts nacieron
    // liquidables; `release` los alcanzaría igual y aquí no haría nada.
    await payoutService.release(s.orderId);
    const { settlement } = await payoutService.settle({
      beneficiary: PayoutBeneficiary.BUSINESS,
      businessId: s.business._id.toString(),
      createdBy: s.owner._id.toString(),
      reference: 'TRF-PRUEBA',
    });
    expect(settlement).toBeTruthy();

    // Liquidación → pedidos.
    const lines = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement/lines`)
      .query({ settlementId: settlement!._id.toString() })
      .set(await authHeader(s.owner));

    expect(lines.status).toBe(200);
    expect(lines.body.data).toHaveLength(1);

    const line = lines.body.data[0];
    expect(line.orderId).toBe(s.orderId);
    expect(line.payoutStatus).toBe(PayoutStatus.SETTLED);

    // Pedido → liquidación: la fila lleva el identificador del lote.
    expect(line.settlementId).toBe(settlement!._id.toString());

    // El total del encabezado sale del mismo pipeline que las filas.
    expect(lines.body.meta.totals.netAmount).toBe(line.netAmount);
    expect(settlement!.netAmount).toBe(line.netAmount);
  });

  it('descuenta del neto lo que una reversión se llevó', async () => {
    const s = await scenario('online');
    const order = await orderService.getById(s.orderId);

    await payoutService.reverse(s.orderId, { business: 5000 });

    const lines = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement/lines`)
      .set(await authHeader(s.owner));

    const line = lines.body.data[0];
    expect(line.reversedAmount).toBe(5000);
    expect(line.netAmount).toBe(order.finance.businessPayout - 5000);
    expect(lines.body.meta.totals.netAmount).toBe(line.netAmount);
  });

  it('no deja que un comercio lea las cuentas de otro', async () => {
    const s = await scenario();
    const otherOwner = await makeUser({ role: UserRole.BUSINESS });

    const res = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement`)
      .set(await authHeader(otherOwner));

    expect(res.status).toBe(403);
  });

  it('ignora un estado de payout inventado en la consulta', async () => {
    const s = await scenario('online');

    const res = await request(app)
      .get(`/api/v1/businesses/${s.business._id}/statement/lines`)
      .query({ status: 'settled,__proto__,pagado' })
      .set(await authHeader(s.owner));

    // Solo sobrevive `settled`, y ese pedido todavía no lo está.
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);

    const all = await Payout.countDocuments({ businessId: s.business._id });
    expect(all).toBeGreaterThan(0);
  });
});
