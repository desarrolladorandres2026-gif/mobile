import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as emitter from '../sockets/emitter';
import { orderService, UNACCEPTED_ORDER_MS } from '../services/order.service';
import { refundService } from '../services/refund.service';
import { config } from '../config';
import { Order, Product } from '../models';
import { CancellationReason, CancelledBy, OrderStatus, PaymentMethod, PaymentStatus, RefundKind, UserRole } from '../types';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON, offsetKm } from './factories';

const DESTINATION = offsetKm(GARZON, 1);

/**
 * Un pedido que el comercio podía aceptar y nunca aceptó no puede quedarse
 * en PENDING con el dinero del cliente y el stock reservado.
 */
describe('Pedidos que el comercio nunca aceptó', () => {
  let client: any;
  let owner: any;
  let business: any;
  let product: any;
  let ioSpy: ReturnType<typeof vi.spyOn>;

  const autoApprove = config.payments.sandbox.autoApprove;
  const later = () => new Date(Date.now() + UNACCEPTED_ORDER_MS + 60_000);

  beforeEach(async () => {
    config.payments.sandbox.autoApprove = false;
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    client = await makeUser();
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
    product = await makeProduct(business._id, { price: 30000 });
    await Product.updateOne({ _id: product._id }, { stock: 10 });

    const chain = (): any => ({ to: () => chain(), except: () => chain(), emit: () => true });
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
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      cashPayment: { needsChange: false },
      deliveryAddress: 'Cra 10 #5-23',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
      ...extra,
    } as never);

  const stock = async () => (await Product.findById(product._id))!.stock;

  it('cancela el pedido en efectivo sin aceptar pasado el corte y devuelve el stock', async () => {
    const order = await create();
    expect(await stock()).toBe(9);

    expect(await orderService.cancelUnacceptedOrders(later())).toBe(1);

    const saved = await Order.findById(order._id);
    expect(saved!.status).toBe(OrderStatus.CANCELLED);
    expect(saved!.cancelledBy).toBe(CancelledBy.SYSTEM);
    // Queda atribuido al comercio en las métricas, no como «otro motivo».
    expect(saved!.cancellationCode).toBe(CancellationReason.BUSINESS_NO_RESPONSE);
    expect(await stock()).toBe(10);
  });

  it('no toca un pedido reciente', async () => {
    await create();
    expect(await orderService.cancelUnacceptedOrders(new Date())).toBe(0);
  });

  it('no toca un pedido que el comercio ya aceptó', async () => {
    const order = await create();
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.ACCEPTED });
    expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.ACCEPTED);
  });

  it('pedido pagado en línea: cancela y pide el reembolso completo con clave idempotente', async () => {
    const order = await create({ paymentMethod: PaymentMethod.ONLINE, cashPayment: undefined });
    await Order.updateOne({ _id: order._id }, { paymentStatus: PaymentStatus.PAID });

    const refund = vi.spyOn(refundService, 'issue').mockResolvedValue({} as never);
    try {
      expect(await orderService.cancelUnacceptedOrders(later())).toBe(1);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.CANCELLED);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: order._id.toString(),
          kind: RefundKind.FULL,
          idempotencyKey: `cancel:${order._id}`,
        })
      );
    } finally {
      refund.mockRestore();
    }
  });

  it('no toca un pedido en línea sin pagar: de ese se ocupa el barrido de abandonados', async () => {
    const order = await create({ paymentMethod: PaymentMethod.ONLINE, cashPayment: undefined });
    expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
  });

  it('no toca un programado que todavía no se activa', async () => {
    const order = await create();
    await Order.updateOne(
      { _id: order._id },
      { scheduledFor: new Date(Date.now() + 24 * 60 * 60_000), scheduledActivatedAt: null }
    );
    expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);
    expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
  });

  it('un programado cuenta desde que se activó, no desde que se creó', async () => {
    const order = await create();
    const activatedAt = new Date(Date.now() + UNACCEPTED_ORDER_MS); // se activó "hace 1 minuto" respecto a later()
    await Order.updateOne(
      { _id: order._id },
      { scheduledFor: new Date(Date.now() + 60 * 60_000), scheduledActivatedAt: activatedAt }
    );
    expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);

    const afterCutoff = new Date(activatedAt.getTime() + UNACCEPTED_ORDER_MS + 60_000);
    expect(await orderService.cancelUnacceptedOrders(afterCutoff)).toBe(1);
  });

  it('un segundo barrido no vuelve a cancelar ni a devolver stock', async () => {
    await create();
    await orderService.cancelUnacceptedOrders(later());
    expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);
    expect(await stock()).toBe(10);
  });

  it('un 409 (el comercio acepta en el último segundo) no es un fallo ni cancela', async () => {
    const order = await create();
    const original = orderService.updateStatus.bind(orderService);
    const spy = vi.spyOn(orderService, 'updateStatus').mockImplementation(async (...args: any[]) => {
      // El comercio acepta justo antes de que el barrido reclame la transición.
      await Order.updateOne({ _id: order._id }, { status: OrderStatus.ACCEPTED });
      return (original as any)(...args);
    });
    try {
      expect(await orderService.cancelUnacceptedOrders(later())).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.ACCEPTED);
    } finally {
      spy.mockRestore();
    }
  });
});
