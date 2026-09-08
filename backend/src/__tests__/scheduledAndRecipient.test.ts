import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Pedidos para otra persona y pedidos programados.
 *
 * El primero resuelve un problema muy concreto: mandarle almuerzo a alguien
 * significaba que el domiciliario llamara al número de quien pagó, que
 * podía estar en otra ciudad, y el pedido se quedaba en la puerta.
 *
 * El segundo tiene una trampa menos obvia: un pedido programado existe
 * desde que se paga, pero aparecer en la cocina doce horas antes solo
 * consigue que lo preparen doce horas antes.
 */
describe('Destinatario y programación', () => {
  let client: any;
  let business: any;
  let product: any;

  const newOrder = (extra: Record<string, unknown> = {}) =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
      ...extra,
    } as never);

  const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
  });

  // ── Para otra persona ──

  it('guarda a quién hay que entregarle y a qué número llamar', async () => {
    const order = await newOrder({
      recipient: { name: 'Mi mamá', phone: '3001234567', note: 'Timbre 2' },
    });

    const saved = await Order.findById(order._id);
    expect(saved!.recipient!.name).toBe('Mi mamá');
    expect(saved!.recipient!.phone).toBe('3001234567');
    expect(saved!.recipient!.note).toBe('Timbre 2');
  });

  it('sin destinatario, el pedido es para quien lo paga', async () => {
    const order = await newOrder();
    const saved = await Order.findById(order._id);
    expect(saved!.recipient).toBeUndefined();
  });

  // ── Programados ──

  it('acepta un pedido para dentro de unas horas', async () => {
    const when = inHours(3);
    const order = await newOrder({ scheduledFor: when });

    const saved = await Order.findById(order._id);
    expect(saved!.scheduledFor!.getTime()).toBe(when.getTime());
    expect(saved!.scheduledActivatedAt).toBeNull();
  });

  it('rechaza programar para dentro de cinco minutos', async () => {
    // Eso no es programar: es pedir ahora con una promesa de puntualidad
    // que nadie firmó.
    await expect(
      newOrder({ scheduledFor: new Date(Date.now() + 5 * 60 * 1000) })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rechaza programar para dentro de un mes', async () => {
    await expect(newOrder({ scheduledFor: inHours(24 * 30) })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('un programado no aparece en la cola del negocio todavía', async () => {
    await newOrder({ scheduledFor: inHours(5) });

    const { orders } = await orderService.getByBusiness(business._id.toString());
    expect(orders).toHaveLength(0);
  });

  it('un pedido normal sí aparece de inmediato', async () => {
    await newOrder();

    const { orders } = await orderService.getByBusiness(business._id.toString());
    expect(orders).toHaveLength(1);
  });

  it('el barrido no activa lo que todavía está lejos', async () => {
    await newOrder({ scheduledFor: inHours(5) });

    expect(await orderService.activateScheduledOrders()).toBe(0);
  });

  it('el barrido activa lo que ya toca preparar', async () => {
    // El negocio declara 30 minutos de preparación; con el colchón de
    // viaje, un pedido para dentro de 40 minutos ya tiene que entrar.
    await Business.updateOne({ _id: business._id }, { deliveryTime: 30 });
    await newOrder({ scheduledFor: new Date(Date.now() + 40 * 60 * 1000) });

    expect(await orderService.activateScheduledOrders()).toBe(1);

    const { orders } = await orderService.getByBusiness(business._id.toString());
    expect(orders).toHaveLength(1);
  });

  it('no lo activa dos veces', async () => {
    await Business.updateOne({ _id: business._id }, { deliveryTime: 30 });
    await newOrder({ scheduledFor: new Date(Date.now() + 40 * 60 * 1000) });

    expect(await orderService.activateScheduledOrders()).toBe(1);
    expect(await orderService.activateScheduledOrders()).toBe(0);
  });

  it('un negocio lento recibe su pedido antes que uno rápido', async () => {
    // El margen sale del tiempo que el propio negocio declara: una
    // pizzería y una droguería no necesitan lo mismo.
    await Business.updateOne({ _id: business._id }, { deliveryTime: 90 });
    await newOrder({ scheduledFor: new Date(Date.now() + 80 * 60 * 1000) });

    expect(await orderService.activateScheduledOrders()).toBe(1);
  });

  it('un programado ya cancelado no se activa', async () => {
    await Business.updateOne({ _id: business._id }, { deliveryTime: 30 });
    const order = await newOrder({ scheduledFor: new Date(Date.now() + 40 * 60 * 1000) });
    await Order.updateOne({ _id: order._id }, { status: OrderStatus.CANCELLED });

    expect(await orderService.activateScheduledOrders()).toBe(0);
  });
});
