import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import * as emitter from '../sockets/emitter';
import { orderService } from '../services/order.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { config } from '../config';
import { Order, Notification } from '../models';
import { CancelledBy, PaymentMethod, PaymentStatus, UserRole } from '../types';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, authHeader, GARZON, offsetKm,
} from './factories';
import { isActionableForBusiness, isMerchantVisible } from '../utils/merchantVisibility';

const DESTINATION = offsetKm(GARZON, 1);

/**
 * El comercio se entera de un pedido cuando puede aceptarlo, no antes.
 *
 * Antes el anuncio salía al crearse, también para los pedidos en línea sin
 * pagar: la cocina sonaba, el comercio pulsaba Aceptar y recibía un 409. Y
 * cuando el pago por fin entraba, nadie se lo decía. Cubre los cuatro
 * momentos en que sí se anuncia (creación en efectivo, cobro aprobado,
 * cambio a efectivo, activación de un programado) y los dos en que no.
 */

type Emission = { event: string; to: string[]; except: string[]; payload: any };

function fakeIo() {
  const emitted: Emission[] = [];
  const chain = (to: string[], except: string[]): any => ({
    // Acepta una sala o una lista, como el `io.to` real.
    to: (r: string | string[]) => chain([...to, ...(Array.isArray(r) ? r : [r])], except),
    except: (r: string) => chain(to, [...except, r]),
    emit: (event: string, payload: unknown) => { emitted.push({ event, to, except, payload }); return true; },
  });
  return { io: chain([], []), emitted };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('Anuncio de pedidos al comercio', () => {
  let emitted: Emission[];
  let ioSpy: ReturnType<typeof vi.spyOn>;
  let client: any;
  let owner: any;
  let business: any;
  let product: any;

  const autoApprove = config.payments.sandbox.autoApprove;

  beforeEach(async () => {
    // Sin aprobación automática: el cobro se queda pendiente hasta que el
    // test lo apruebe, que es el caso real de PSE y Nequi.
    config.payments.sandbox.autoApprove = false;
    setPaymentProvider(new SandboxPaymentProvider());

    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    client = await makeUser();
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    product = await makeProduct(business._id, { price: 30000 });

    const fake = fakeIo();
    emitted = fake.emitted;
    ioSpy = vi.spyOn(emitter, 'getIO').mockReturnValue(fake.io);
  });

  afterEach(() => {
    config.payments.sandbox.autoApprove = autoApprove;
    ioSpy.mockRestore();
  });

  const create = (extra: Record<string, unknown> = {}) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      ...extra,
    } as never);

  const incoming = () => emitted.filter((e) => e.event === 'order:incoming');
  const ownerNotices = () => Notification.countDocuments({ userId: owner._id, title: 'Nuevo pedido' });

  const pay = async (order: any) => {
    const { intent } = await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });
    await paymentService.applyGatewayStatus(intent.id, 'approved', order.finance.customerTotal, { source: 'webhook' });
  };

  it('en efectivo: se anuncia al crear, completo al dueño y sin márgenes al personal', async () => {
    await create({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY, cashPayment: { needsChange: false } });
    await settle();

    expect(incoming()).toHaveLength(2);
    const toOwner = incoming().find((e) => e.to[0].startsWith('user:'))!;
    const toStaff = incoming().find((e) => e.to[0].startsWith('business:'))!;
    expect(toStaff.except).toEqual(toOwner.to);
    expect(toOwner.payload.finance.driverPayout).toBeDefined();
    expect(toStaff.payload.finance.driverPayout).toBeUndefined();
    expect(await ownerNotices()).toBe(1);
  });

  it('en línea sin pagar: ni se anuncia ni aparece en el tablero', async () => {
    await create();
    await settle();

    expect(incoming()).toHaveLength(0);
    expect(await ownerNotices()).toBe(0);
    expect((await orderService.getByBusiness(business._id.toString())).orders).toHaveLength(0);
  });

  it('en línea: se anuncia una sola vez cuando el cobro se aprueba', async () => {
    const order = await create();
    await pay(order);
    await settle();

    expect(incoming()).toHaveLength(2);
    expect(incoming()[0].payload._id.toString()).toBe(order._id.toString());
    expect(incoming()[0].payload.paymentStatus).toBe(PaymentStatus.PAID);
    expect(await ownerNotices()).toBe(1);
    expect((await orderService.getByBusiness(business._id.toString())).orders).toHaveLength(1);
  });

  it('un cobro que llega con el pedido ya cancelado no anuncia nada', async () => {
    const order = await create();
    const { intent } = await paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });
    // El pedido se cancela antes de que el banco apruebe.
    await orderService.updateStatus(order._id.toString(), 'cancelled' as never, client._id.toString(), UserRole.CLIENT, 'Ya no lo quiero');
    emitted.length = 0;

    await paymentService.applyGatewayStatus(intent.id, 'approved', order.finance.customerTotal, { source: 'webhook' });
    await settle();

    expect(incoming()).toHaveLength(0);
  });

  it('cambiar de línea a efectivo lo anuncia; volver a línea lo retira', async () => {
    const order = await create();
    expect(incoming()).toHaveLength(0);

    await orderService.changePaymentMethod({
      orderId: order._id.toString(),
      clientId: client._id.toString(),
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    });
    await settle();
    expect(incoming()).toHaveLength(2);

    emitted.length = 0;
    await orderService.changePaymentMethod({
      orderId: order._id.toString(),
      clientId: client._id.toString(),
      paymentMethod: PaymentMethod.ONLINE,
    });

    const withdrawn = emitted.find((e) => e.event === 'order:withdrawn');
    expect(withdrawn).toBeDefined();
    expect(withdrawn!.to).toContain(`business:${business._id.toString()}`);
    expect(withdrawn!.payload.orderId).toBe(order._id.toString());
    expect((await orderService.getByBusiness(business._id.toString())).orders).toHaveLength(0);
  });

  it('un programado en efectivo se anuncia al activarse, completo y una sola vez', async () => {
    await Order.deleteMany({});
    const order = await create({
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      cashPayment: { needsChange: false },
      scheduledFor: new Date(Date.now() + 40 * 60 * 1000),
    });
    await settle();
    expect(incoming()).toHaveLength(0);

    expect(await orderService.activateScheduledOrders()).toBe(1);
    await settle();
    expect(incoming()).toHaveLength(2);
    // Antes viajaban tres campos sin `_id` y el panel lo descartaba.
    expect(incoming()[0].payload._id.toString()).toBe(order._id.toString());
    expect(incoming()[0].payload.items).toHaveLength(1);

    expect(await orderService.activateScheduledOrders()).toBe(0);
    expect(incoming()).toHaveLength(2);
  });

  it('un programado en línea activado antes de pagar espera al cobro', async () => {
    const order = await create({ scheduledFor: new Date(Date.now() + 40 * 60 * 1000) });

    await orderService.activateScheduledOrders();
    await settle();
    expect(incoming()).toHaveLength(0);

    await pay(order);
    await settle();
    expect(incoming()).toHaveLength(2);
  });

  describe('eventos de estado', () => {
    const asClient = async (status: string) =>
      request(app)
        .patch(`/api/v1/orders/${order._id}/status`)
        .set(await authHeader(client))
        .send({ status, cancellationReason: 'Me arrepentí' });
    let order: any;

    beforeEach(async () => {
      order = await create({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY, cashPayment: { needsChange: false } });
      await settle();
      emitted.length = 0;
    });

    it('la cancelación del cliente llega a la sala del comercio con negocio y autor', async () => {
      // El controlador emite con `req.app.get('io')`, no con el módulo.
      const fake = fakeIo();
      const original = app.get('io');
      app.set('io', fake.io);
      try {
        expect((await asClient('cancelled')).status).toBe(200);
      } finally {
        app.set('io', original);
      }

      const toBusiness = fake.emitted.find((e) => e.event === 'order:status:changed' && e.to[0].startsWith('business:'))!;
      expect(toBusiness.payload.businessId).toBe(business._id.toString());
      expect(toBusiness.payload.cancelledBy).toBe(CancelledBy.CLIENT);
    });

    it('el rechazo del propio comercio viaja como suyo y no avisa a su dueño', async () => {
      const fake = fakeIo();
      const original = app.get('io');
      app.set('io', fake.io);
      try {
        await request(app)
          .patch(`/api/v1/orders/${order._id}/status`)
          .set(await authHeader(owner))
          .send({ status: 'cancelled', cancellationReason: 'Sin stock' })
          .expect(200);
      } finally {
        app.set('io', original);
      }
      await settle();

      const toBusiness = fake.emitted.find((e) => e.event === 'order:status:changed' && e.to[0].startsWith('business:'))!;
      expect(toBusiness.payload.cancelledBy).toBe(CancelledBy.BUSINESS);
      // Nadie le avisa a alguien de lo que acaba de hacer.
      expect(await Notification.countDocuments({ userId: owner._id, title: 'Pedido cancelado' })).toBe(0);
    });
  });
});

describe('Quién ve un pedido: isMerchantVisible / isActionableForBusiness', () => {
  const base = { businessId: 'b1', status: 'pending', paymentMethod: 'cash_on_delivery', paymentStatus: 'pending_cash' };

  it('efectivo pendiente: visible y aceptable', () => {
    expect(isMerchantVisible(base)).toBe(true);
    expect(isActionableForBusiness(base)).toBe(true);
  });

  it('en línea: visible solo cuando está pagado o devuelto', () => {
    const online = { ...base, paymentMethod: 'online' };
    expect(isMerchantVisible({ ...online, paymentStatus: 'pending' })).toBe(false);
    expect(isMerchantVisible({ ...online, paymentStatus: 'failed' })).toBe(false);
    expect(isMerchantVisible({ ...online, paymentStatus: 'paid' })).toBe(true);
    expect(isMerchantVisible({ ...online, paymentStatus: 'refunded' })).toBe(true);
  });

  it('programado: visible solo una vez activado', () => {
    const scheduled = { ...base, scheduledFor: new Date() };
    expect(isMerchantVisible(scheduled)).toBe(false);
    expect(isMerchantVisible({ ...scheduled, scheduledActivatedAt: new Date() })).toBe(true);
  });

  it('un mandado o un pedido sin negocio nunca es del comercio', () => {
    expect(isMerchantVisible({ ...base, kind: 'errand' })).toBe(false);
    expect(isMerchantVisible({ ...base, businessId: null })).toBe(false);
  });

  it('aceptable exige además que siga pendiente', () => {
    expect(isActionableForBusiness({ ...base, status: 'accepted' })).toBe(false);
  });
});
