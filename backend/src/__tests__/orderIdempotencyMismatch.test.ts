import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Order } from '../models';
import { PaymentMethod, UserRole } from '../types';
import { orderService, hashOrderPayload } from '../services/order.service';
import { setIO, emitDriverLocation, evictClientFromDriverTracking } from '../sockets/emitter';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

describe('M6: la clave idempotente exige el mismo contenido', () => {
  let client: any;
  let business: any;
  let product: any;
  let other: any;

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id);
    product = await makeProduct(business._id);
    other = await makeProduct(business._id);
  });

  const input = (extra: Record<string, unknown> = {}) => ({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 1 #2-3',
    deliveryLongitude: GARZON.lng,
    deliveryLatitude: GARZON.lat,
    idempotencyKey: 'clave-m6',
    ...extra,
  });

  it('mismo payload: devuelve el pedido existente (réplica) y guarda la huella', async () => {
    const first = await orderService.create(input());
    expect(first.idempotencyHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await orderService.create(input());
    expect(String(again._id)).toBe(String(first._id));
    expect(await Order.countDocuments({ idempotencyKey: 'clave-m6' })).toBe(1);
  });

  it('payload distinto con la misma clave: 409 IDEMPOTENCY_MISMATCH con el orderId existente, sin pedido nuevo', async () => {
    const first = await orderService.create(input());
    const variants: Array<Record<string, unknown>> = [
      { items: [{ productId: other._id.toString(), quantity: 1 }] },
      { items: [{ productId: product._id.toString(), quantity: 2 }] },
      { paymentMethod: PaymentMethod.CASH_ON_DELIVERY },
      { deliveryLatitude: GARZON.lat + 0.01 },
      { deliveryAddress: 'Otra dirección 9' },
      { tip: 1000 },
    ];
    for (const v of variants) {
      await expect(orderService.create(input(v))).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_MISMATCH',
        details: { orderId: String(first._id) },
      });
    }
    expect(await Order.countDocuments({ idempotencyKey: 'clave-m6' })).toBe(1);
  });

  it('pedido antiguo sin huella: se trata como coincidencia', async () => {
    const first = await orderService.create(input());
    await Order.collection.updateOne({ _id: first._id }, { $unset: { idempotencyHash: '' } });
    const again = await orderService.create(input({ paymentMethod: PaymentMethod.ONLINE, tip: 0 }));
    expect(String(again._id)).toBe(String(first._id));
  });

  it('la huella ignora el orden de los extras y el total esperado', () => {
    const a = hashOrderPayload(input({ items: [{ productId: 'p', quantity: 1, selectedExtras: [{ groupId: 'g', optionId: 'a' }, { groupId: 'g', optionId: 'b' }] }] }) as any);
    const b = hashOrderPayload(input({ expectedTotal: 5, items: [{ productId: 'p', quantity: 1, selectedExtras: [{ groupId: 'g', optionId: 'b' }, { groupId: 'g', optionId: 'a' }] }] }) as any);
    expect(a).toBe(b);
  });
});

describe('M5: seguimiento del repartidor', () => {
  afterEach(() => setIO(null as any));

  it('la sala driver:tracking no recibe orderId ni batería; la sala del pedido no recibe batería', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    setIO({ to } as any);
    emitDriverLocation('drv1', { accepted: true, orderId: 'ord1', driverId: 'prof', location: { lat: 1, lng: 2 }, recordedAt: new Date() } as any, { batteryLevel: 80, heading: 10 });
    const sent = (room: string) => (to.mock.calls as any[]).findIndex((c) => c[0] === room);
    const tracking = emit.mock.calls[sent('driver:tracking:drv1')][1];
    expect(tracking).not.toHaveProperty('orderId');
    expect(tracking).not.toHaveProperty('batteryLevel');
    expect(tracking.location).toEqual({ lat: 1, lng: 2 });
    const orderRoom = emit.mock.calls[sent('order:ord1')][1];
    expect(orderRoom.orderId).toBe('ord1');
    expect(orderRoom).not.toHaveProperty('batteryLevel');
    const fleet = emit.mock.calls[sent('admin:fleet')][1];
    expect(fleet.batteryLevel).toBe(80);
  });

  it('evictClientFromDriverTracking saca solo los sockets de ese cliente', async () => {
    const leaveMine = vi.fn();
    const leaveOther = vi.fn();
    setIO({
      in: () => ({
        fetchSockets: async () => [
          { data: { userId: 'cli1' }, leave: leaveMine },
          { data: { userId: 'cli2' }, leave: leaveOther },
        ],
      }),
    } as any);
    await evictClientFromDriverTracking('drv1', 'cli1');
    expect(leaveMine).toHaveBeenCalledWith('driver:tracking:drv1');
    expect(leaveOther).not.toHaveBeenCalled();
  });
});
