import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Order, Driver } from '../models';
import { OrderStatus, DriverStatus, UserRole, PaymentMethod } from '../types';
import {
  startDispatch,
  offerNextRound,
  declineOffer,
  canClaim,
  stopDispatch,
  sweepExpiredOffers,
  setDispatchEnabled,
  dispatchService,
} from '../services/dispatch.service';
import { orderService } from '../services/order.service';
import { forgetDriver } from '../services/tracking.service';
import {
  makeUser, makeDriver, makeBusiness, makeProduct, makePricingConfig,
  GARZON, offsetKm,
} from './factories';

/**
 * El reparto automático.
 *
 * Hasta ahora el pedido se lo quedaba quien pulsara primero. La cascada
 * cambia eso por un orden —el más cercano tiene un turno propio— y ese
 * orden solo significa algo si nadie puede saltárselo. Estas pruebas
 * cubren las dos mitades: que la oferta avance sola cuando nadie responde,
 * y que mientras tanto el pedido no se lo pueda llevar otro.
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

    // Cada uno un poco más lejos que el anterior, para que el ranking por
    // cercanía tenga un orden previsible que las pruebas puedan afirmar.
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
  const clientUser = await makeUser({ role: UserRole.CLIENT });

  const created = await orderService.create({
    clientId: clientUser._id.toString(),
    businessId: ctx.business._id.toString(),
    items: [{ productId: ctx.product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLongitude: GARZON.lng,
    deliveryLatitude: GARZON.lat,
  });

  // Se coloca en READY por escritura directa en vez de recorrer los
  // estados: pasar por `updateStatus` dispararía el reparto automático y
  // estas pruebas necesitan arrancarlo ellas para poder observarlo.
  await Order.updateOne({ _id: created._id }, { status: OrderStatus.READY });
  const order = (await Order.findById(created._id))!;

  return { order, clientUser };
}

describe('Reparto automático: la cascada', () => {
  let ctx: Awaited<ReturnType<typeof scenario>>;

  beforeEach(async () => {
    // El reparto viene apagado de fábrica hasta que la app del domiciliario
    // sepa mostrar una oferta. Estas pruebas lo encienden a mano porque son
    // justamente las que describen qué hace cuando está encendido.
    setDispatchEnabled(true);
    ctx = await scenario();
    ctx.drivers.forEach((d) => forgetDriver(d.user._id.toString()));
  });

  afterEach(() => {
    setDispatchEnabled(false);
    vi.useRealTimers();
    ctx?.drivers.forEach((d) => forgetDriver(d.user._id.toString()));
  });

  it('la primera ronda se la ofrece a uno solo: el más cercano', async () => {
    const { order } = await readyOrder(ctx);

    await startDispatch(order._id.toString());

    const saved = await Order.findById(order._id);
    expect(saved!.dispatch!.round).toBe(1);
    expect(saved!.dispatch!.offeredDriverIds).toHaveLength(1);
    expect(saved!.dispatch!.offeredDriverIds[0].toString()).toBe(
      ctx.drivers[0].driver._id.toString()
    );
  });

  it('la segunda ronda abre el pedido a tres', async () => {
    const { order } = await readyOrder(ctx);

    await startDispatch(order._id.toString());
    await offerNextRound(order._id.toString());

    const saved = await Order.findById(order._id);
    expect(saved!.dispatch!.round).toBe(2);
    expect(saved!.dispatch!.offeredDriverIds.length).toBeGreaterThan(1);
  });

  it('nadie que no tenga la oferta puede quedarse el pedido', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const saved = await Order.findById(order._id);
    const outsider = ctx.drivers[2].driver._id.toString();

    expect(canClaim(saved!, outsider)).toBe(false);
    expect(canClaim(saved!, ctx.drivers[0].driver._id.toString())).toBe(true);
  });

  it('una oferta vencida deja de retener el pedido', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const saved = await Order.findById(order._id);
    const outsider = ctx.drivers[2].driver._id.toString();
    expect(canClaim(saved!, outsider)).toBe(false);

    // Pasada la ventana, el pedido vuelve a ser de quien lo tome: entre que
    // expira y que el barrido pasa hay unos segundos, y en ese hueco es
    // mejor que se lo lleve alguien a que no se lo lleve nadie.
    vi.setSystemTime(start + 60_000);
    expect(canClaim(saved!, outsider)).toBe(true);
  });

  it('un pedido sin reparto en curso lo puede tomar cualquiera', async () => {
    const { order } = await readyOrder(ctx);
    const saved = await Order.findById(order._id);

    expect(saved!.dispatch).toBeUndefined();
    expect(canClaim(saved!, ctx.drivers[2].driver._id.toString())).toBe(true);
  });

  it('rechazar libera el pedido sin esperar al reloj', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const first = ctx.drivers[0].driver._id.toString();
    await declineOffer(order._id.toString(), first);

    const saved = await Order.findById(order._id);
    // Avanzó de ronda sin que pasara el tiempo, y quien dijo que no queda
    // apuntado para no volver a molestarle en este ciclo.
    expect(saved!.dispatch!.round).toBe(2);
    expect(saved!.dispatch!.declinedDriverIds.map(String)).toContain(first);
    expect(saved!.dispatch!.offeredDriverIds.map(String)).not.toContain(first);
  });

  it('el barrido avanza las rondas vencidas y no toca las vivas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    // Todavía dentro de la ventana: el barrido no debe hacer nada.
    expect(await sweepExpiredOffers()).toBe(0);
    expect((await Order.findById(order._id))!.dispatch!.round).toBe(1);

    vi.setSystemTime(start + dispatchService.ROUNDS[0].windowMs + 1000);
    expect(await sweepExpiredOffers()).toBe(1);
    expect((await Order.findById(order._id))!.dispatch!.round).toBe(2);
  });

  it('agotadas las rondas empieza otra vuelta y olvida los rechazos', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());
    await declineOffer(order._id.toString(), ctx.drivers[0].driver._id.toString());

    // Avanza hasta que la cascada se desborde. Se comprueba el ciclo en vez
    // de contar rondas para que la prueba siga valiendo si mañana la
    // cascada tiene cuatro escalones en vez de tres.
    let saved = await Order.findById(order._id);
    for (let i = 0; i < dispatchService.ROUNDS.length + 2; i++) {
      if (saved!.dispatch!.cycle > 0) break;
      await offerNextRound(order._id.toString());
      saved = await Order.findById(order._id);
    }

    expect(saved!.dispatch!.cycle).toBe(1);
    expect(saved!.dispatch!.round).toBe(0);
    // Quien dijo que no hace tres minutos puede haber terminado su entrega.
    expect(saved!.dispatch!.declinedDriverIds).toHaveLength(0);
  });

  it('asignar domiciliario cierra el reparto', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    await orderService.assignDriver(
      order._id.toString(),
      ctx.drivers[0].driver._id.toString(),
      { userId: ctx.drivers[0].user._id.toString(), role: UserRole.DRIVER }
    );

    const saved = await Order.findById(order._id);
    expect(saved!.driverId!.toString()).toBe(ctx.drivers[0].driver._id.toString());
    expect(saved!.dispatch).toBeUndefined();
  });

  it('un domiciliario fuera de turno recibe un 409 y no se queda el pedido', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const outsider = ctx.drivers[2];

    await expect(
      orderService.assignDriver(order._id.toString(), outsider.driver._id.toString(), {
        userId: outsider.user._id.toString(),
        role: UserRole.DRIVER,
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    const saved = await Order.findById(order._id);
    expect(saved!.driverId).toBeFalsy();
  });

  it('un administrador puede asignar por encima de la cascada', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const outsider = ctx.drivers[2];
    const adminUser = await makeUser({ role: UserRole.ADMIN });

    await orderService.assignDriver(order._id.toString(), outsider.driver._id.toString(), {
      userId: adminUser._id.toString(),
      role: UserRole.ADMIN,
    });

    const saved = await Order.findById(order._id);
    expect(saved!.driverId!.toString()).toBe(outsider.driver._id.toString());
  });

  it('el reparto se detiene al parar el pedido', async () => {
    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());
    await stopDispatch(order._id.toString());

    expect((await Order.findById(order._id))!.dispatch).toBeUndefined();
    expect(await sweepExpiredOffers()).toBe(0);
  });

  it('no ofrece un pedido que ya tiene domiciliario', async () => {
    const { order } = await readyOrder(ctx);
    await Order.updateOne({ _id: order._id }, { driverId: ctx.drivers[0].driver._id });

    await startDispatch(order._id.toString());

    const saved = await Order.findById(order._id);
    expect(saved!.dispatch?.round ?? 0).toBe(0);
  });
});

/**
 * La oferta por notificación.
 *
 * El socket solo llega a una app viva y en primer plano; un domiciliario
 * conduciendo tiene el teléfono bloqueado en el bolsillo, que es justo
 * cuando está disponible. Sin push, la cascada reserva el pedido durante
 * minuto y medio para gente que no se entera — y ese era el motivo real de
 * que `DISPATCH_ENABLED` siguiera apagado en producción.
 */
describe('reparto: aviso al teléfono', () => {
  let ctx: Awaited<ReturnType<typeof scenario>>;

  /**
   * Solo las push de oferta.
   *
   * Marcar un pedido como listo ya manda su propio aviso de cambio de
   * estado, así que el espía ve dos clases de mensaje. Sin este filtro las
   * pruebas afirmaban sobre la push equivocada — y pasaban o fallaban por
   * el motivo equivocado, que es peor que no tenerlas.
   */
  const offerPushes = (spy: { mock: { calls: any[][] } }) =>
    spy.mock.calls.filter(([, message]) => message?.data?.kind === 'order:offer');

  beforeEach(async () => {
    setDispatchEnabled(true);
    ctx = await scenario(3);
  });

  afterEach(() => {
    setDispatchEnabled(false);
    for (const { driver } of ctx.drivers) forgetDriver(driver._id.toString());
    vi.restoreAllMocks();
  });

  it('manda una push al domiciliario al que se le ofrece', async () => {
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    // La primera ronda es exclusiva del más cercano: una sola push.
    expect(offerPushes(spy)).toHaveLength(1);

    const [userId, message] = offerPushes(spy)[0];
    expect(userId).toBe(ctx.drivers[0].user._id.toString());
    expect(message.data).toMatchObject({
      kind: 'order:offer',
      orderId: order._id.toString(),
    });
  });

  it('la push lleva la oferta entera, no solo el id', async () => {
    // Con la app cerrada el socket no entregó nada: esta push es lo único
    // que la app tiene para levantar la hoja con su reloj y sus botones.
    // Un id suelto solo serviría para abrir un pedido que aún no es suyo.
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const { data } = offerPushes(spy)[0][1];
    expect(data).toMatchObject({
      orderNumber: order.orderNumber,
      round: 1,
    });
    expect(typeof (data as any).etaSeconds).toBe('number');
    expect(Date.parse((data as any).expiresAt as string)).toBeGreaterThan(Date.now());
  });

  it('la push caduca con la ronda', async () => {
    // Una oferta entregada cinco minutos tarde manda al domiciliario a una
    // pantalla sin nada que aceptar. Vencido el plazo, FCM la descarta.
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    const message = offerPushes(spy)[0][1];
    expect(message.ttlSeconds).toBe(dispatchService.ROUNDS[0].windowMs / 1000);
  });

  it('va por su propio canal de Android', async () => {
    // Quien silencia los avisos de promociones no puede silenciar con
    // ellos lo único que le da de comer.
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());

    expect(offerPushes(spy)[0][1].channelId).toBe('offers');
  });

  it('avisa a todos los candidatos de una ronda ancha', async () => {
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    const { order } = await readyOrder(ctx);
    await startDispatch(order._id.toString());
    spy.mockClear();

    // Segunda ronda: los tres mejores.
    await offerNextRound(order._id.toString());

    expect(offerPushes(spy).length).toBeGreaterThan(1);
  });

  it('un fallo de la push no tumba el reparto', async () => {
    // `sendToUser` no lanza nunca, pero el reparto no puede depender de esa
    // promesa: si algún día lanza, el pedido tiene que ofrecerse igual.
    const { pushService } = await import('../services/push.service');
    vi.spyOn(pushService, 'sendToUser').mockRejectedValue(new Error('Expo caído'));

    const { order } = await readyOrder(ctx);
    await expect(startDispatch(order._id.toString())).resolves.not.toThrow();

    const saved = await Order.findById(order._id);
    expect(saved!.dispatch?.offeredDriverIds).toHaveLength(1);
  });
});
