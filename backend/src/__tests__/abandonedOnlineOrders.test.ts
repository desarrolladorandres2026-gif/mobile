import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as emitter from '../sockets/emitter';
import { orderService, ABANDONED_ONLINE_ORDER_MS } from '../services/order.service';
import { refundService } from '../services/refund.service';
import { paymentService, setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { config } from '../config';
import { Order, Payment, Product, LedgerEntry } from '../models';
import { CancelledBy, LedgerEventType, OrderStatus, PaymentMethod, PaymentStatus, PaymentType, UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

const DESTINATION = offsetKm(GARZON, 1);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/**
 * Un checkout que nadie paga no puede retener stock para siempre, y un cobro
 * que entra en mal momento no puede quedarse dentro de un pedido cerrado.
 */
describe('Pedidos en línea abandonados y carreras del cobro', () => {
  let client: any;
  let owner: any;
  let business: any;
  let product: any;
  let ioSpy: ReturnType<typeof vi.spyOn>;
  let announced: string[];

  const autoApprove = config.payments.sandbox.autoApprove;
  const later = () => new Date(Date.now() + ABANDONED_ONLINE_ORDER_MS + 60_000);

  beforeEach(async () => {
    config.payments.sandbox.autoApprove = false;
    setPaymentProvider(new SandboxPaymentProvider());
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    client = await makeUser();
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    product = await makeProduct(business._id, { price: 30000 });
    await Product.updateOne({ _id: product._id }, { stock: 10 });

    announced = [];
    const chain = (): any => ({
      to: () => chain(),
      except: () => chain(),
      emit: (event: string) => { if (event === 'order:incoming') announced.push(event); return true; },
    });
    ioSpy = vi.spyOn(emitter, 'getIO').mockReturnValue(chain());
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

  const stock = async () => (await Product.findById(product._id))!.stock;

  const initiate = (order: any) =>
    paymentService.initiate({
      orderId: order._id.toString(),
      userId: client._id.toString(),
      amount: order.finance.customerTotal,
      description: 'Prueba',
      customer: { name: 'Cliente', phone: '3101234567' },
    });

  describe('barrido de abandonados', () => {
    it('cancela el pedido sin pagar pasado el corte y devuelve el stock', async () => {
      const order = await create();
      expect(await stock()).toBe(9);

      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(1);

      const saved = await Order.findById(order._id);
      expect(saved!.status).toBe(OrderStatus.CANCELLED);
      expect(saved!.cancelledBy).toBe(CancelledBy.SYSTEM);
      expect(saved!.paymentStatus).toBe(PaymentStatus.FAILED);
      expect(await stock()).toBe(10);
    });

    it('no toca un pedido reciente', async () => {
      await create();
      expect(await orderService.cancelAbandonedOnlineOrders(new Date())).toBe(0);
    });

    it('no toca un pedido ya pagado', async () => {
      const order = await create();
      await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.PAID });
      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
    });

    it('no toca un pedido en efectivo', async () => {
      await create({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY, cashPayment: { needsChange: false } });
      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
    });

    it('espera si el cobro sigue en vuelo en la pasarela', async () => {
      const order = await create();
      await initiate(order);
      // Con `transactionId` propio de la pasarela, el barrido de cobros
      // todavía lo está consultando.
      await Payment.updateOne({ orderId: order._id }, { status: PaymentStatus.PENDING, transactionId: 'gw-en-vuelo' });

      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
    });

    it('respeta el enlace de pago todavía vigente: el corte cuenta desde el último intento', async () => {
      const order = await create();
      await initiate(order); // el intento se acaba de crear, su enlace sigue pagable
      // Sin transacción propia de la pasarela: solo cuenta la vigencia del enlace.
      const attempt = await Payment.findOne({ orderId: order._id });
      await Payment.updateOne({ _id: attempt!._id }, { status: PaymentStatus.PENDING, transactionId: attempt!.reference });

      // Pasó el corte desde que se creó el pedido, pero no la vigencia del enlace.
      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);

      // Con el enlace ya caducado, sí se cierra.
      const expired = new Date(Date.now() + (config.payments.wompi.checkoutExpiryMinutes + 10) * 60_000);
      expect(await orderService.cancelAbandonedOnlineOrders(expired)).toBe(1);
    });

    it('no cancela un pedido cuyo cobro ya está reclamado como pagado', async () => {
      const order = await create();
      await Payment.create({
        orderId: order._id, userId: client._id, amount: order.finance!.customerTotal,
        status: PaymentStatus.PAID, type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE,
        reference: 'ref-reclamado', transactionId: 'gw-reclamado',
      } as never);
      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
    });

    it('los pedidos en vuelo no impiden cancelar a los abandonados (no se atasca)', async () => {
      const inFlight = await create();
      await Payment.create({
        orderId: inFlight._id, userId: client._id, amount: 1000, status: PaymentStatus.PENDING,
        type: PaymentType.ORDER_PAYMENT, method: PaymentMethod.ONLINE, reference: 'r1', transactionId: 'gw-1',
      } as never);
      const abandoned = await create();

      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(1);
      expect((await Order.findById(abandoned._id))!.status).toBe(OrderStatus.CANCELLED);
      expect((await Order.findById(inFlight._id))!.status).toBe(OrderStatus.PENDING);
    });

    it('no avisa al comercio de un pedido que nunca vio', async () => {
      await create();
      await orderService.cancelAbandonedOnlineOrders(later());
      await settle();
      expect(announced).toHaveLength(0);
    });

    it('un segundo barrido no vuelve a cancelar ni a devolver stock', async () => {
      await create();
      await orderService.cancelAbandonedOnlineOrders(later());
      expect(await orderService.cancelAbandonedOnlineOrders(later())).toBe(0);
      expect(await stock()).toBe(10);
    });
  });

  describe('un cobro que llega tarde no se queda dentro de un pedido cerrado', () => {
    it('intento anulado por cambio a efectivo que el banco aprueba tarde: se retiene', async () => {
      const order = await create();
      const { intent } = await initiate(order);

      await orderService.changePaymentMethod({
        orderId: order._id.toString(),
        clientId: client._id.toString(),
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      });
      await settle();
      announced.length = 0;

      await paymentService.applyGatewayStatus(intent.id, 'approved', order.finance.customerTotal, { source: 'webhook' });
      await settle();

      const saved = await Order.findById(order._id);
      // Sigue siendo un pedido en efectivo: no se marca pagado en línea.
      expect(saved!.paymentStatus).toBe(PaymentStatus.PENDING_CASH);
      const flagged = await Payment.findOne({ orderId: order._id, 'metadata.requiresReview': true });
      expect(flagged).not.toBeNull();
      // Nada que liberar ni que anunciar al comercio por ese cobro.
      expect(announced).toHaveLength(0);
      expect(await LedgerEntry.countDocuments({ orderId: order._id, eventType: LedgerEventType.PAYMENT_CAPTURED })).toBe(0);
    });

    it('si la cancelación llega cuando el cobro ya entró, se reembolsa en vez de pisar PAID', async () => {
      const order = await create();
      // La base ya dice PAID, pero quien cancela trabaja con una copia vieja.
      await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.PAID });
      const stale = await Order.findById(order._id);
      stale!.paymentStatus = PaymentStatus.PENDING;

      const refund = vi.spyOn(refundService, 'issue').mockResolvedValue({} as never);
      try {
        await (orderService as any).onCancelled(stale);
        expect(refund).toHaveBeenCalledTimes(1);
        expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
      } finally {
        refund.mockRestore();
      }
    });
  });
});
