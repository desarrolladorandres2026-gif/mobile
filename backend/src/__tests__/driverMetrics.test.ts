import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Order, Driver, DriverOffer } from '../models';
import { DriverStatus, UserRole, OrderStatus, PaymentMethod } from '../types';
import { Types } from 'mongoose';
import {
  authHeader, makeUser, makeDriver, makeBusiness, makeProduct, makePricingConfig,
  GARZON, offsetKm,
} from './factories';
import {
  startDispatch, declineOffer, annotateDecline, stopDispatch, sweepExpiredOffers,
  setDispatchEnabled,
} from '../services/dispatch.service';
import { orderService } from '../services/order.service';
import { forgetDriver } from '../services/tracking.service';
import { driverService } from '../services/driver.service';

/**
 * El libro de ofertas y las métricas que salen de él.
 *
 * Antes, `stopDispatch` borraba `order.dispatch` al asignar y la
 * plataforma se quedaba sin poder contestar a quién le había ofrecido cada
 * pedido. Estas pruebas cubren las dos mitades: que quede constancia de
 * cada final, y —sobre todo— que el número que sale de ahí sea justo.
 *
 * Lo segundo importa más que lo primero. Una tasa de aceptación que
 * castiga por perder una carrera que no se podía ganar es peor que no
 * tener tasa: se ve objetiva y no lo es.
 */

async function scenario(driverCount = 3) {
  await makePricingConfig();

  const ownerUser = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(ownerUser._id, { lat: GARZON.lat, lng: GARZON.lng });
  const product = await makeProduct(business._id);

  const drivers = [];
  for (let i = 0; i < driverCount; i++) {
    const user = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(user._id, { isApproved: true, isActive: true });
    const at = offsetKm(GARZON, 0.3 * (i + 1));
    await Driver.updateOne(
      { _id: driver._id },
      {
        status: DriverStatus.AVAILABLE,
        currentLocation: { type: 'Point', coordinates: [at.lng, at.lat] },
        lastLocationAt: new Date(),
      }
    );
    drivers.push({ user, driver });
  }

  return { ownerUser, business, product, drivers };
}

async function readyOrder(ctx: Awaited<ReturnType<typeof scenario>>) {
  const client = await makeUser({ role: UserRole.CLIENT });

  const created = await orderService.create({
    clientId: client._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLongitude: GARZON.lng,
    deliveryLatitude: GARZON.lat,
  });

  // Se coloca en READY por escritura directa: pasar por `updateStatus`
  // dispararía el reparto y estas pruebas necesitan arrancarlo ellas.
  await Order.updateOne({ _id: created._id }, { status: OrderStatus.READY });
  const order = (await Order.findById(created._id))!;

  return { order, client };
}

describe('Libro de ofertas y métricas del domiciliario', () => {
  let ctx: Awaited<ReturnType<typeof scenario>>;

  beforeEach(async () => {
    setDispatchEnabled(true);
    ctx = await scenario(3);
  });

  afterEach(() => {
    setDispatchEnabled(false);
    for (const { driver } of ctx.drivers) forgetDriver(driver._id.toString());
  });

  it('deja constancia de la oferta que el pedido ya no guarda', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const registered = await DriverOffer.find({ orderId: order._id });
    expect(registered).toHaveLength(1);
    expect(registered[0].outcome).toBe('pending');
    expect(registered[0].round).toBe(1);
  });

  it('registra el rechazo con su motivo', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const first = (await Order.findById(order._id))!.dispatch!.offeredDriverIds![0].toString();
    await declineOffer(order._id.toString(), first, 'low_pay');

    const row = await DriverOffer.findOne({ orderId: order._id, driverId: first });
    expect(row?.outcome).toBe('declined');
    expect(row?.declineReason).toBe('low_pay');
    expect(row?.respondedAt).toBeTruthy();
  });

  it('un rechazo sin motivo se registra igual', async () => {
    // El motivo es opcional: quien conduce tiene medio segundo. Lo que no
    // puede perderse es el rechazo en sí.
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const first = (await Order.findById(order._id))!.dispatch!.offeredDriverIds![0].toString();
    await declineOffer(order._id.toString(), first);

    const row = await DriverOffer.findOne({ orderId: order._id, driverId: first });
    expect(row?.outcome).toBe('declined');
    expect(row?.declineReason).toBeFalsy();
  });

  it('anota el motivo cuando llega después de haber soltado el pedido', async () => {
    /**
     * El caso real, y el que se rompió al escribirlo la primera vez.
     *
     * La app suelta el pedido primero —hay una cocina esperando— y pregunta
     * el motivo después. Para cuando llega la respuesta, `declineOffer` ya
     * no sirve: sale por su propia puerta al no encontrar al domiciliario
     * entre los candidatos, porque acaba de quitarlo él mismo. Mandar el
     * motivo como un segundo `declineOffer` lo perdía en silencio.
     */
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const first = (await Order.findById(order._id))!.dispatch!.offeredDriverIds![0].toString();

    // Primero suelta, sin motivo. Como hace la app.
    await declineOffer(order._id.toString(), first);
    // Y luego explica.
    await annotateDecline(order._id.toString(), first, 'too_far');

    const row = await DriverOffer.findOne({ orderId: order._id, driverId: first });
    expect(row?.outcome).toBe('declined');
    expect(row?.declineReason).toBe('too_far');
  });

  it('anotar un motivo no puede convertir en rechazo lo que no lo fue', async () => {
    // La red de seguridad del endpoint: solo escribe sobre filas que ya
    // están en `declined`.
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const first = (await Order.findById(order._id))!.dispatch!.offeredDriverIds![0].toString();
    await annotateDecline(order._id.toString(), first, 'low_pay');

    const row = await DriverOffer.findOne({ orderId: order._id, driverId: first });
    expect(row?.outcome).toBe('pending');
    expect(row?.declineReason).toBeFalsy();
  });

  it('quien acepta queda como aceptación y los demás como perdida', async () => {
    // El corazón de la justicia del número. En una ronda ancha el mismo
    // pedido se ofrece a tres y solo uno puede quedárselo: los otros dos no
    // lo ignoraron, se lo ganó otro.
    const { order } = await readyOrder(ctx);
    const id = order._id.toString();

    // Ronda ancha: se registran tres ofertas para el mismo pedido.
    await DriverOffer.insertMany(
      ctx.drivers.map(({ driver }) => ({
        driverId: driver._id,
        orderId: order._id,
        round: 2,
        etaSeconds: 120,
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
        outcome: 'pending',
      }))
    );

    const ganador = ctx.drivers[1].driver._id.toString();
    await stopDispatch(id, ganador);

    const rows = await DriverOffer.find({ orderId: order._id });
    expect(rows.find((r) => r.driverId.toString() === ganador)?.outcome).toBe('accepted');
    expect(rows.filter((r) => r.outcome === 'taken_by_other')).toHaveLength(2);
  });

  it('la oferta que vence sin respuesta queda como vencida', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    // Se adelanta el reloj de la ronda en curso.
    await Order.updateOne({ _id: order._id }, { 'dispatch.expiresAt': new Date(Date.now() - 1000) });
    await sweepExpiredOffers();

    const row = await DriverOffer.findOne({ orderId: order._id, round: 1 });
    expect(row?.outcome).toBe('expired');
  });

  describe('la tasa de aceptación', () => {
    const offerRow = (driverId: any, outcome: string, round: number, respondedAfterMs?: number) => {
      const offeredAt = new Date(Date.now() - 60_000);
      return {
        driverId,
        orderId: new Types.ObjectId(),
        round,
        etaSeconds: 120,
        offeredAt,
        expiresAt: new Date(offeredAt.getTime() + 45_000),
        outcome,
        ...(respondedAfterMs !== undefined
          ? { respondedAt: new Date(offeredAt.getTime() + respondedAfterMs) }
          : {}),
      };
    };

    it('no cuenta las ofertas que se llevó otro', async () => {
      // Si contaran, un domiciliario con 2 aceptadas y 8 perdidas saldría
      // al 20 % sin haber hecho nada mal.
      const { driver, user } = ctx.drivers[0];
      await DriverOffer.insertMany([
        offerRow(driver._id, 'accepted', 1, 3000),
        offerRow(driver._id, 'accepted', 2, 3000),
        ...Array.from({ length: 8 }, (_, i) => offerRow(driver._id, 'taken_by_other', i + 3)),
      ]);

      const metrics = await driverService.getPerformance(user._id.toString());

      expect(metrics.acceptanceRate).toBe(100);
      expect(metrics.offers.takenByOther).toBe(8);
    });

    it('sí cuenta las vencidas: se le enseñó y no contestó', async () => {
      const { driver, user } = ctx.drivers[0];
      await DriverOffer.insertMany([
        offerRow(driver._id, 'accepted', 1, 3000),
        offerRow(driver._id, 'expired', 2),
        offerRow(driver._id, 'declined', 3, 5000),
        offerRow(driver._id, 'accepted', 4, 3000),
      ]);

      const metrics = await driverService.getPerformance(user._id.toString());
      expect(metrics.acceptanceRate).toBe(50);
    });

    it('sin ofertas devuelve null, no cero', async () => {
      // Un 0 % a alguien que acaba de entrar sería una calumnia, y es lo
      // que se ve si se divide entre cero sin pensarlo.
      const metrics = await driverService.getPerformance(ctx.drivers[0].user._id.toString());
      expect(metrics.acceptanceRate).toBeNull();
    });

    it('pondera el tiempo de respuesta por número de ofertas', async () => {
      // 20 aceptaciones de 2 s y 2 rechazos de 40 s. Promediar las dos
      // medias daría 21 s; lo que de verdad pasó está cerca de 5 s.
      const { driver, user } = ctx.drivers[0];
      await DriverOffer.insertMany([
        ...Array.from({ length: 20 }, (_, i) => offerRow(driver._id, 'accepted', i + 1, 2000)),
        ...Array.from({ length: 2 }, (_, i) => offerRow(driver._id, 'declined', i + 21, 40_000)),
      ]);

      const metrics = await driverService.getPerformance(user._id.toString());
      expect(metrics.avgResponseSeconds).toBeLessThan(10);
    });

    it('dice explícitamente que no afecta al reparto', async () => {
      // Va en la respuesta del servidor y no solo en la pantalla: si algún
      // día deja de ser verdad, esta línea tiene que cambiar con ello.
      const metrics = await driverService.getPerformance(ctx.drivers[0].user._id.toString());
      expect(metrics.affectsDispatch).toBe(false);
    });
  });

  it('el endpoint solo lo ve un domiciliario', async () => {
    await request(app)
      .get('/api/v1/drivers/metrics')
      .set(await authHeader(await makeUser()))
      .expect(403);

    await request(app)
      .get('/api/v1/drivers/metrics')
      .set(await authHeader(ctx.drivers[0].user))
      .expect(200);
  });
});
