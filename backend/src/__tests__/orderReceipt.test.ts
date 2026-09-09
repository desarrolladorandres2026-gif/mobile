import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { orderService } from '../services/order.service';
import { UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, authHeader,
  makePricingConfig,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

/**
 * El comprobante de un pedido.
 *
 * `orderController.receipt` enseñaba `comisionZipp`, `subsidioZipp` y
 * `subsidioComercio` a **cualquier cliente** que abriera su propio
 * comprobante — el margen interno de la plataforma sobre ese pedido
 * concreto, un dato que ni el propio comercio ve en su carta. El endpoint
 * llevaba sin un solo consumidor desde que se escribió, así que nadie lo
 * había ejercitado nunca para notarlo.
 */
describe('GET /api/v1/orders/:id/receipt', () => {
  async function createOrder() {
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    const client = await makeUser({ role: UserRole.CLIENT });
    const owner = await makeUser({ role: UserRole.BUSINESS });
    const business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    return { client, order };
  }

  it('no enseña el margen interno de la plataforma al cliente', async () => {
    const { client, order } = await createOrder();

    const res = await request(app)
      .get(`/api/v1/orders/${order._id}/receipt`)
      .set(authHeader(client))
      .expect(200);

    // Sí ve lo que pagó.
    expect(res.body.data.totalPagado).toBeGreaterThan(0);
    expect(res.body.data.valorProductos).toBe(20000);

    // No ve cuánto se queda ZIPP ni quién financió el descuento.
    expect(res.body.data.comisionZipp).toBeUndefined();
    expect(res.body.data.subsidioZipp).toBeUndefined();
    expect(res.body.data.subsidioComercio).toBeUndefined();
  });

  it('sí enseña el desglose completo al admin', async () => {
    const { order } = await createOrder();
    const admin = await makeUser({ role: UserRole.ADMIN });

    const res = await request(app)
      .get(`/api/v1/orders/${order._id}/receipt`)
      .set(authHeader(admin))
      .expect(200);

    expect(res.body.data.comisionZipp).toBeDefined();
  });

  it('rechaza a un cliente que no es dueño del pedido', async () => {
    const { order } = await createOrder();
    const stranger = await makeUser({ role: UserRole.CLIENT });

    await request(app)
      .get(`/api/v1/orders/${order._id}/receipt`)
      .set(authHeader(stranger))
      .expect(403);
  });
});
