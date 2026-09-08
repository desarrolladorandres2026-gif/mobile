import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Order, User } from '../models';
import { OrderStatus, UserRole, PaymentMethod } from '../types';
import { campaignService } from '../services/campaign.service';
import { orderService } from '../services/order.service';
import { makeUser, makeBusiness, makeProduct, makePricingConfig, GARZON } from './factories';

/**
 * Envíos dirigidos.
 *
 * Mandarle a todo el mundo la promoción de una pizzería es la forma más
 * rápida de que la gente apague las notificaciones de ZIPP — y entonces se
 * pierde también el aviso de que su pedido va en camino, que es el que de
 * verdad importa.
 *
 * Buena parte de estas pruebas cubre a quién NO se le manda.
 */
describe('Campañas segmentadas', () => {
  let business: any;
  let product: any;

  const orderFor = async (userId: string, status = OrderStatus.DELIVERED, when?: Date) => {
    const order = await orderService.create({
      clientId: userId,
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: PaymentMethod.ONLINE,
      deliveryAddress: 'Cra 1 #2-3',
      deliveryLongitude: GARZON.lng,
      deliveryLatitude: GARZON.lat,
    });

    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { status, ...(when ? { createdAt: when } : {}) } }
    );
    return order;
  };

  /** Cliente que aceptó recibir comunicaciones comerciales. */
  const optedIn = async () => {
    const user = await makeUser({ role: UserRole.CLIENT });
    await User.updateOne({ _id: user._id }, { marketingConsent: true });
    return user;
  };

  beforeEach(async () => {
    await makePricingConfig();
    const owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id, { lat: GARZON.lat, lng: GARZON.lng });
    product = await makeProduct(business._id);
  });

  it('sin segmento alcanza a los clientes que dieron permiso', async () => {
    await optedIn();
    await optedIn();

    expect(await campaignService.preview({})).toBe(2);
  });

  it('NUNCA alcanza a quien no dio permiso', async () => {
    await optedIn();
    // No es una preferencia negociable: es la ley y es lo correcto.
    await makeUser({ role: UserRole.CLIENT });

    expect(await campaignService.preview({})).toBe(1);
  });

  it('no alcanza a cuentas desactivadas', async () => {
    const user = await optedIn();
    await User.updateOne({ _id: user._id }, { isActive: false });

    expect(await campaignService.preview({})).toBe(0);
  });

  it('segmenta por quienes compraron en un negocio', async () => {
    const comprador = await optedIn();
    await optedIn(); // no compró aquí

    await orderFor(comprador._id.toString());

    const reach = await campaignService.resolve({
      boughtFromBusinessId: business._id.toString(),
    });

    expect(reach).toEqual([comprador._id.toString()]);
  });

  it('solo cuenta las compras entregadas, no las canceladas', async () => {
    const user = await optedIn();
    await orderFor(user._id.toString(), OrderStatus.CANCELLED);

    const reach = await campaignService.resolve({
      boughtFromBusinessId: business._id.toString(),
    });

    expect(reach).toHaveLength(0);
  });

  it('segmenta por clientes frecuentes', async () => {
    const frecuente = await optedIn();
    const ocasional = await optedIn();

    await orderFor(frecuente._id.toString());
    await orderFor(frecuente._id.toString());
    await orderFor(frecuente._id.toString());
    await orderFor(ocasional._id.toString());

    const reach = await campaignService.resolve({ minDeliveredOrders: 3 });
    expect(reach).toEqual([frecuente._id.toString()]);
  });

  it('segmenta por inactividad: quien no pide desde hace tiempo', async () => {
    const dormido = await optedIn();
    const activo = await optedIn();

    const hace60dias = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await orderFor(dormido._id.toString(), OrderStatus.DELIVERED, hace60dias);
    await orderFor(activo._id.toString());

    const reach = await campaignService.resolve({ inactiveForDays: 30 });

    expect(reach).toContain(dormido._id.toString());
    expect(reach).not.toContain(activo._id.toString());
  });

  it('combina segmentos: compró aquí y lleva tiempo sin volver', async () => {
    const objetivo = await optedIn();
    const volvio = await optedIn();

    const hace60dias = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await orderFor(objetivo._id.toString(), OrderStatus.DELIVERED, hace60dias);
    await orderFor(volvio._id.toString(), OrderStatus.DELIVERED, hace60dias);
    await orderFor(volvio._id.toString());

    const reach = await campaignService.resolve({
      boughtFromBusinessId: business._id.toString(),
      inactiveForDays: 30,
    });

    expect(reach).toEqual([objetivo._id.toString()]);
  });

  it('un negocio que no existe da error, no un envío a todo el mundo', async () => {
    await expect(
      campaignService.resolve({ boughtFromBusinessId: '507f1f77bcf86cd799439011' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('el preview no manda nada', async () => {
    const { pushService } = await import('../services/push.service');
    const spy = vi.spyOn(pushService, 'sendToUser').mockResolvedValue(undefined);

    await optedIn();
    await campaignService.preview({});

    // Enseñar el alcance antes de pulsar el botón es la diferencia entre
    // una herramienta y una escopeta.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('un token muerto no aborta la campaña entera', async () => {
    const { pushService } = await import('../services/push.service');
    const spy = vi
      .spyOn(pushService, 'sendToUser')
      .mockRejectedValueOnce(new Error('token inválido'))
      .mockResolvedValue(undefined);

    await optedIn();
    await optedIn();

    const result = await campaignService.send(
      {},
      { title: 'Hola', body: 'Prueba' }
    );

    expect(result.targeted).toBe(2);
    expect(result.sent).toBe(1);
    spy.mockRestore();
  });
});
