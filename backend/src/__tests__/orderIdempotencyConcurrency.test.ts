import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Product, Order, PlatformPricingConfig } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import * as emitter from '../sockets/emitter';
import { pricingService } from '../services/pricing.service';
import { pricingConfigService } from '../services/pricingConfig.service';
import { couponService } from '../services/coupon.service';
import { ledgerService } from '../services/ledger.service';
import {
  makeUser, makeBusiness, makeProduct, makePricingConfig, makeCoupon, authHeader, GARZON,
} from './factories';

/**
 * Idempotencia y concurrencia del alta de pedidos.
 *
 * `orderService.create` ya tenía las dos piezas: la clave idempotente con
 * índice único y la reserva de stock condicionada dentro de la escritura.
 * Lo que no estaba probado es cómo se comportan **juntas** cuando algo sale
 * mal después de reservar. La reserva ocurre antes de crear el pedido, así
 * que cada salida por error posterior —el pedido gemelo que ganó la
 * carrera, el cupón que se agotó, los libros que fallaron— tiene que
 * devolver lo apartado. Si no, las unidades desaparecen sin que ningún
 * pedido las tenga y el negocio ve su carta apagarse sola.
 *
 * El invariante que se comprueba en todas: el stock final es el inicial
 * menos lo que tienen los pedidos vivos, y nunca es negativo.
 */
describe('Pedidos — idempotencia y concurrencia', () => {
  let client: any;
  let owner: any;
  let business: any;

  const input = (product: any, extra: Record<string, unknown> = {}, who: any = client) => ({
    clientId: who._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLongitude: GARZON.lng,
    deliveryLatitude: GARZON.lat,
    ...extra,
  });

  const httpBody = (product: any, extra: Record<string, unknown> = {}) => ({
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: 'online',
    deliveryAddress: 'Calle 5 # 3-21',
    deliveryLatitude: GARZON.lat + 0.01,
    deliveryLongitude: GARZON.lng,
    ...extra,
  });

  const stockOf = async (product: any) => (await Product.findById(product._id))!.stock;

  /** Unidades que tienen apartadas los pedidos que siguen vivos. */
  const unitsInLiveOrders = async (product: any) => {
    const orders = await Order.find({ status: { $ne: OrderStatus.CANCELLED }, 'items.productId': product._id });
    return orders.reduce(
      (sum, o) => sum + o.items.filter((i) => i.productId.equals(product._id)).reduce((s, i) => s + i.quantity, 0),
      0
    );
  };

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── F-1: stock que no vuelve ──────────────────────────────────────

  it('F-1a: si el gemelo con la misma clave gana la carrera, la reserva del perdedor vuelve', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 5 });

    // Reproduce la carrera de forma determinista: entre la comprobación
    // previa de la clave y el `Order.create`, el gemelo ya guardó su pedido.
    // Es exactamente lo que pasa cuando la red reintenta y las dos
    // peticiones llegan a la vez.
    const realQuote = pricingService.quote.bind(pricingService);
    let twinInserted = false;
    vi.spyOn(pricingService, 'quote').mockImplementation(async (args) => {
      const quote = await realQuote(args);
      if (!twinInserted) {
        twinInserted = true;
        await orderService.create(input(product, { idempotencyKey: 'reintento-red' }));
      }
      return quote;
    });

    const order = await orderService.create(input(product, { idempotencyKey: 'reintento-red' }));

    expect(await Order.countDocuments()).toBe(1);
    expect((await Order.findOne())!._id.equals(order._id)).toBe(true);
    // Una sola unidad apartada: la del pedido que existe.
    expect(await stockOf(product)).toBe(4);
  });

  it('F-1b: si el cupón se agota entre cotizar y canjear, la reserva vuelve', async () => {
    const product = await makeProduct(business._id, { price: 20000 });
    await Product.updateOne({ _id: product._id }, { stock: 3 });
    await makeCoupon({ code: 'ULTIMO', value: 10 });
    vi.spyOn(couponService, 'redeem').mockResolvedValueOnce(false);

    await expect(orderService.create(input(product, { couponCode: 'ULTIMO' }))).rejects.toMatchObject({ statusCode: 409 });

    expect(await Order.countDocuments()).toBe(0);
    expect(await stockOf(product)).toBe(3);
  });

  it('F-1c: si los libros fallan y el pedido se deshace, la reserva vuelve', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 2 });
    vi.spyOn(ledgerService, 'recordOrderPlaced').mockRejectedValueOnce(new Error('Libro mayor caído'));

    await expect(orderService.create(input(product))).rejects.toThrow('Libro mayor caído');

    expect(await Order.countDocuments()).toBe(0);
    expect(await stockOf(product)).toBe(2);
  });

  it('F-1d: la última unidad reservada y devuelta vuelve también a la carta', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 1 });
    vi.spyOn(ledgerService, 'recordOrderPlaced').mockRejectedValueOnce(new Error('Libro mayor caído'));

    await expect(orderService.create(input(product))).rejects.toThrow();

    const saved = await Product.findById(product._id);
    expect(saved!.stock).toBe(1);
    // Al reservarla llegó a cero y se apagó sola; si el pedido no salió,
    // tiene que volver a ofrecerse.
    expect(saved!.isAvailable).toBe(true);
  });

  // ── F-2: la clave es de quien la usa ──────────────────────────────

  it('F-2 / SEC-05: la clave de otro cliente nunca devuelve su pedido', async () => {
    const product = await makeProduct(business._id);
    const other = await makeUser({ role: UserRole.CLIENT });

    const mine = await request(app).post('/api/v1/orders').set(await authHeader(client))
      .send(httpBody(product, { idempotencyKey: 'clave-compartida' })).expect(201);

    const theirs = await request(app).post('/api/v1/orders').set(await authHeader(other))
      .send(httpBody(product, { idempotencyKey: 'clave-compartida' }));

    expect(theirs.status).toBe(409);
    expect(theirs.body.data?._id).toBeUndefined();
    expect(JSON.stringify(theirs.body)).not.toContain(mine.body.data._id);
    expect(await Order.countDocuments({ clientId: other._id })).toBe(0);
  });

  // ── F-3: la réplica no vuelve a sonar en la cocina ────────────────

  it('F-3 / O-04: el doble envío crea un pedido y avisa al comercio una sola vez', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 10 });

    // Cada emisión recuerda a qué salas fue, a cuáles no y con qué forma.
    const emitted: { event: string; to: string[]; except: string[]; payload: any }[] = [];
    const chain = (to: string[], except: string[]): any => ({
      to: (r: string) => chain([...to, r], except),
      except: (r: string) => chain(to, [...except, r]),
      emit: (event: string, payload: unknown) => { emitted.push({ event, to, except, payload }); return true; },
    });
    // El anuncio al comercio sale por el `io` del módulo de sockets, no por
    // `req.app`: se espía ese.
    const ioSpy = vi.spyOn(emitter, 'getIO').mockReturnValue(chain([], []));

    // El pedido en línea no se anuncia al crearse (espera al cobro): para
    // probar que la réplica no vuelve a sonar hace falta uno aceptable ya,
    // o sea en efectivo.
    await PlatformPricingConfig.updateMany({}, { cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    pricingConfigService.invalidate();

    try {
      const body = httpBody(product, { idempotencyKey: 'doble-toque', paymentMethod: 'cash_on_delivery', cashPayment: { needsChange: false } });
      const first = await request(app).post('/api/v1/orders').set(await authHeader(client)).send(body).expect(201);
      const second = await request(app).post('/api/v1/orders').set(await authHeader(client)).send(body).expect(201);

      expect(second.body.data._id).toBe(first.body.data._id);
      expect(await Order.countDocuments()).toBe(1);
      expect(await stockOf(product)).toBe(9);

      // Un aviso para el dueño y uno para su personal (sin el dueño), y
      // ninguno más por la réplica.
      const incoming = emitted.filter((e) => e.event === 'order:incoming');
      expect(incoming).toHaveLength(2);
      const owner = incoming.find((e) => e.to[0].startsWith('user:'))!;
      const staff = incoming.find((e) => e.to[0].startsWith('business:'))!;
      expect(staff.except).toEqual(owner.to);

      // El personal no ve el pago al domiciliario ni el margen de ZIPP.
      expect(owner.payload.finance.driverPayout).toBeDefined();
      expect(staff.payload.finance.businessPayout).toBe(owner.payload.finance.businessPayout);
      expect(staff.payload.finance.driverPayout).toBeUndefined();
      expect(staff.payload.finance.platformGrossRevenue).toBeUndefined();
      expect(staff.payload.driverPayout).toBeUndefined();
    } finally {
      ioSpy.mockRestore();
    }
  });

  // ── F-4: tope de adicionales por línea ────────────────────────────

  it('F-4 / SEC-08: una línea con más de 50 adicionales se rechaza en la validación', async () => {
    const product = await makeProduct(business._id, { extras: [{ name: 'Queso extra', price: 3000 }] });
    const selectedExtras = Array.from({ length: 51 }, () => ({ name: 'Queso extra' }));

    const res = await request(app).post('/api/v1/orders/quote').set(await authHeader(client))
      .send(httpBody(product, { items: [{ productId: product._id.toString(), quantity: 1, selectedExtras }] }));

    expect(res.status).toBe(400);
  });

  // ── Concurrencia ──────────────────────────────────────────────────

  it('O-05 / CON-03: dos peticiones simultáneas con la misma clave crean un pedido y reservan una vez', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 5 });

    const body = httpBody(product, { idempotencyKey: 'timeout-red' });
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => request(app).post('/api/v1/orders').set(await authHeader(client)).send(body))
    );

    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Nunca un 5xx: una respuesta que no es el pedido tiene que ser un rechazo controlado.
    expect(results.every((r) => r.status < 500)).toBe(true);
    expect(new Set(ok.map((r) => r.body.data._id)).size).toBe(1);
    expect(await Order.countDocuments()).toBe(1);
    expect(await stockOf(product)).toBe(4);
  });

  it('CON-02: el mismo usuario desde dos dispositivos por la última unidad: uno la lleva, el otro 409', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 1 });

    const results = await Promise.all([
      request(app).post('/api/v1/orders').set(await authHeader(client)).send(httpBody(product, { idempotencyKey: 'telefono' })),
      request(app).post('/api/v1/orders').set(await authHeader(client)).send(httpBody(product, { idempotencyKey: 'tableta' })),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf(product)).toBe(0);
    expect(await Order.countDocuments()).toBe(1);
  });

  it('CON-06: ráfaga de 20 pedidos contra 5 unidades: exactamente 5 salen y el stock no baja de cero', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 5 });
    const clients = await Promise.all(Array.from({ length: 20 }, () => makeUser({ role: UserRole.CLIENT })));

    const results = await Promise.allSettled(clients.map((c) => orderService.create(input(product, {}, c))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => r.reason?.statusCode === 409)).toBe(true);
    expect(await stockOf(product)).toBe(0);
    expect(await Product.countDocuments({ stock: { $lt: 0 } })).toBe(0);
    expect(await unitsInLiveOrders(product)).toBe(5);
  });

  it('CON-05: cancelar mientras otro reserva deja el stock coherente, y la doble cancelación devuelve una vez', async () => {
    const product = await makeProduct(business._id);
    await Product.updateOne({ _id: product._id }, { stock: 2 });
    const other = await makeUser({ role: UserRole.CLIENT });

    const first = await orderService.create(input(product));
    const cancel = () => orderService.updateStatus(
      first._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Me arrepentí'
    );

    await Promise.allSettled([
      cancel(),
      cancel(),
      orderService.create(input(product, {}, other)),
      orderService.create(input(product, {}, other)),
    ]);

    const stock = await stockOf(product);
    expect(stock).toBeGreaterThanOrEqual(0);
    expect(stock! + (await unitsInLiveOrders(product))).toBe(2);
  });
});
