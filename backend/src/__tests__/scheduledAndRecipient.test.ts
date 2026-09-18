import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';
import { isOpenAt } from '../utils/businessHours';

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

  const day = (open: string, close: string, isOpen = true) => ({ open, close, isOpen });
  const everyDay = (d: ReturnType<typeof day>) => ({
    monday: d, tuesday: d, wednesday: d, thursday: d, friday: d, saturday: d, sunday: d,
  });

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    // Abierto las 24 horas: estas pruebas programan a horas relativas a
    // "ahora", y con el horario por defecto (8 a 22) fallarían según a qué
    // hora se corra la suite. El horario tiene sus propias pruebas abajo.
    await Business.updateOne({ _id: business._id }, { schedule: everyDay(day('00:00', '00:00')) });
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

  it('rechaza programar para cuando el negocio no atiende', async () => {
    // Antes solo se miraba el margen: el pedido se activaba solo a su hora
    // y no había nadie en el local para recibirlo.
    await Business.updateOne(
      { _id: business._id },
      { schedule: everyDay(day('08:00', '22:00', false)) }
    );

    await expect(newOrder({ scheduledFor: inHours(3) })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SCHEDULE_CLOSED',
    });
  });
});

/**
 * La regla de horario, con instantes fijos. El servidor corre en UTC y los
 * horarios están en hora de Colombia (UTC−5), así que cada caso se escribe
 * en UTC a propósito: es donde un `getHours()` a secas se equivocaría.
 */
describe('isOpenAt', () => {
  const TZ = 'America/Bogota';
  const bar = {
    monday: { open: '18:00', close: '02:00', isOpen: true },
    tuesday: { open: '18:00', close: '02:00', isOpen: true },
    wednesday: { open: '18:00', close: '02:00', isOpen: true },
    thursday: { open: '18:00', close: '02:00', isOpen: true },
    friday: { open: '18:00', close: '02:00', isOpen: true },
    saturday: { open: '18:00', close: '02:00', isOpen: true },
    sunday: { open: '18:00', close: '02:00', isOpen: false },
  };

  it('lee la hora en Colombia, no la del servidor', () => {
    // Miércoles 16 de septiembre de 2026, 23:00 UTC = 18:00 en Bogotá.
    expect(isOpenAt(bar, new Date('2026-09-16T23:00:00Z'), TZ)).toBe(true);
    // 20:00 UTC = 15:00 en Bogotá: todavía cerrado.
    expect(isOpenAt(bar, new Date('2026-09-16T20:00:00Z'), TZ)).toBe(false);
  });

  it('la madrugada pertenece a la noche anterior cuando el local cruza medianoche', () => {
    // Jueves 17, 06:00 UTC = 01:00 en Bogotá: cola del miércoles.
    expect(isOpenAt(bar, new Date('2026-09-17T06:00:00Z'), TZ)).toBe(true);
    // 08:00 UTC = 03:00 en Bogotá: ya cerró.
    expect(isOpenAt(bar, new Date('2026-09-17T08:00:00Z'), TZ)).toBe(false);
  });

  it('un domingo cerrado no le deja cola al lunes', () => {
    // Lunes 21, 06:00 UTC = 01:00 en Bogotá.
    expect(isOpenAt(bar, new Date('2026-09-21T06:00:00Z'), TZ)).toBe(false);
  });

  it('sin horario, abierto', () => {
    expect(isOpenAt(undefined, new Date('2026-09-17T08:00:00Z'), TZ)).toBe(true);
  });
});
