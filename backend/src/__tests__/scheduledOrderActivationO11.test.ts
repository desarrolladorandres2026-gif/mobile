import { describe, it, expect, beforeEach } from 'vitest';
import { Order, Business } from '../models';
import { UserRole, PaymentMethod } from '../types';
import { orderService } from '../services/order.service';
import { dispatchService, setDispatchEnabled, runSweepOnce } from '../services/dispatch.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * O11 — un pedido programado tiene que activarse aunque el reparto
 * automático esté apagado.
 *
 * Activar un programado (sacarlo de PENDING con `scheduledActivatedAt`
 * puesto, avisar al comercio) no es lo mismo que asignarlo a un
 * domiciliario. Antes las dos cosas vivían detrás del mismo interruptor
 * (`dispatch.cascade`), así que un operador apagando el reparto — por
 * ejemplo, mientras arregla un problema — dejaba también congelados todos
 * los pedidos programados de la noche.
 */
describe('Activación de pedidos programados independiente del reparto automático (O11)', () => {
  let client: any;
  let business: any;
  let product: any;

  beforeEach(async () => {
    await makePricingConfig();
    client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    await Business.updateOne(
      { _id: business._id },
      {
        deliveryTime: 30,
        schedule: {
          monday: { open: '00:00', close: '00:00', isOpen: true },
          tuesday: { open: '00:00', close: '00:00', isOpen: true },
          wednesday: { open: '00:00', close: '00:00', isOpen: true },
          thursday: { open: '00:00', close: '00:00', isOpen: true },
          friday: { open: '00:00', close: '00:00', isOpen: true },
          saturday: { open: '00:00', close: '00:00', isOpen: true },
          sunday: { open: '00:00', close: '00:00', isOpen: true },
        },
      }
    );
    product = await makeProduct(business._id);
  });

  const newScheduledOrder = () =>
    orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
      scheduledFor: new Date(Date.now() + 40 * 60 * 1000), // dentro del margen (30 min prep + 15)
    } as never);

  it('con el reparto automático APAGADO, activateScheduledOrders() sigue sacando el pedido de PENDING', async () => {
    setDispatchEnabled(false);
    const order = await newScheduledOrder();

    expect(await orderService.activateScheduledOrders()).toBe(1);

    const saved = await Order.findById(order._id);
    expect(saved!.scheduledActivatedAt).not.toBeNull();

    const { orders } = await orderService.getByBusiness(business._id.toString());
    expect(orders).toHaveLength(1);
  });

  it('runSweepOnce() activa el programado aunque el interruptor esté apagado, y no dispara la cascada de ofertas', async () => {
    setDispatchEnabled(false);
    const order = await newScheduledOrder();

    await runSweepOnce();

    const saved = await Order.findById(order._id);
    expect(saved!.scheduledActivatedAt).not.toBeNull();
    // Apagado, no se le ofrece a nadie: activar no es asignar.
    expect(await dispatchService.currentOffer(order._id.toString())).toEqual([]);
  });

  it('con el reparto automático ENCENDIDO también se activa (no es un caso especial)', async () => {
    setDispatchEnabled(true);
    const order = await newScheduledOrder();

    await runSweepOnce();

    const saved = await Order.findById(order._id);
    expect(saved!.scheduledActivatedAt).not.toBeNull();
  });
});
