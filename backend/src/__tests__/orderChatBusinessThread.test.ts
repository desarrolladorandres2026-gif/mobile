import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import app from '../app';
import { orderService } from '../services/order.service';
import { orderChatService, resetChatRateLimit } from '../services/orderChat.service';
import { resolveOrderAccess } from '../services/orderAccess.service';
import { OrderMessage } from '../models';
import { OrderStatus, UserRole } from '../types';
import {
  GARZON, offsetKm, makeUser, makeBusiness, makeProduct, makeDriver, makePricingConfig, authHeader,
  counterAuthHeader,
} from './factories';

const DESTINATION = offsetKm(GARZON, 2);

/**
 * El comercio habla con el domiciliario en un hilo propio.
 *
 * La auditoría de 2026-10-01 (MEDIO 5) sacó al comercio de la conversación del
 * cliente con el domiciliario, y eso se mantiene: el cliente puede estar
 * contando dónde vive. Lo que cambia es que ahora hay un segundo hilo,
 * `business_driver`, que el cliente nunca ve.
 */
describe('Chat comercio ↔ domiciliario', () => {
  let client: any;
  let owner: any;
  let business: any;
  let driverUser: any;
  let orderId: string;

  beforeEach(async () => {
    resetChatRateLimit();
    await makePricingConfig({ cashOnDeliveryEnabled: true, cashOnDeliveryMaxAmount: 1_000_000 });
    client = await makeUser({ role: UserRole.CLIENT });
    owner = await makeUser({ role: UserRole.BUSINESS });
    business = await makeBusiness(owner._id);
    const product = await makeProduct(business._id, { price: 20000 });
    driverUser = await makeUser({ role: UserRole.DRIVER });
    const driver = await makeDriver(driverUser._id, { currentFund: 200000 });

    const order = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 5 # 3-21',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });
    orderId = order._id.toString();
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      await orderService.updateStatus(orderId, status, owner._id.toString(), UserRole.BUSINESS);
    }
    await orderService.assignDriver(orderId, driver._id.toString());
  });

  const post = async (who: any, body: Record<string, unknown>, header?: Record<string, string>) =>
    request(app)
      .post(`/api/v1/orders/${orderId}/chat/messages`)
      .set(header ?? (await authHeader(who)))
      .send(body);

  const read = async (who: any, channel?: string, header?: Record<string, string>) =>
    request(app)
      .get(`/api/v1/orders/${orderId}/chat${channel ? `?channel=${channel}` : ''}`)
      .set(header ?? (await authHeader(who)));

  it('el comercio le escribe al domiciliario y este lo lee en su hilo', async () => {
    const sent = await post(owner, { message: 'El pedido está listo en la barra' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.channel).toBe('business_driver');
    expect(sent.body.data.senderRole).toBe(UserRole.BUSINESS);

    const driverView = await read(driverUser, 'business_driver');
    expect(driverView.status).toBe(200);
    expect(driverView.body.data.map((m: any) => m.message)).toEqual(['El pedido está listo en la barra']);
  });

  it('el cliente nunca ve el hilo del comercio, pida lo que pida', async () => {
    await post(owner, { message: 'Dile que suba por la puerta lateral' });

    for (const channel of [undefined, 'client_driver', 'business_driver']) {
      const res = await read(client, channel);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  });

  it('el comercio no ve la conversación del cliente aunque pida ese hilo', async () => {
    await post(client, { message: 'Vivo sola, toque fuerte' });

    for (const channel of [undefined, 'client_driver', 'business_driver']) {
      const res = await read(owner, channel);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  });

  it('el comercio no puede elegir el hilo del cliente al escribir', async () => {
    const sent = await post(owner, { message: 'Hola', channel: 'client_driver' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.channel).toBe('business_driver');

    const clientView = await read(client);
    expect(clientView.body.data).toEqual([]);
  });

  it('el cliente tampoco puede escribir en el hilo del comercio', async () => {
    const sent = await post(client, { message: 'Hola', channel: 'business_driver' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.channel).toBe('client_driver');

    const businessView = await read(owner);
    expect(businessView.body.data).toEqual([]);
  });

  it('el domiciliario sin elegir hilo escribe al del cliente: la app ya instalada sigue igual', async () => {
    const sent = await post(driverUser, { message: 'Voy en camino' });
    expect(sent.body.data.channel).toBe('client_driver');

    expect((await read(client)).body.data).toHaveLength(1);
    expect((await read(owner)).body.data).toEqual([]);
  });

  it('el domiciliario le responde al comercio eligiendo su hilo', async () => {
    await post(owner, { message: '¿Ya vienes?' });
    const reply = await post(driverUser, { message: 'Llego en dos minutos', channel: 'business_driver' });
    expect(reply.body.data.channel).toBe('business_driver');

    const businessView = await read(owner);
    expect(businessView.body.data.map((m: any) => m.message)).toEqual(['¿Ya vienes?', 'Llego en dos minutos']);
    expect((await read(client)).body.data).toEqual([]);
  });

  it('el mostrador del comercio también escribe y lee su hilo', async () => {
    const header = await counterAuthHeader(owner);
    const sent = await post(owner, { message: 'Desde el mostrador' }, header);
    expect(sent.status).toBe(201);

    const view = await read(owner, undefined, header);
    expect(view.body.data).toHaveLength(1);
  });

  it('el acuse de lectura es por hilo: leer el del comercio no marca el del cliente', async () => {
    await post(client, { message: 'Soy yo' });
    await post(owner, { message: 'Del comercio' });

    // El domiciliario abre solo el hilo del comercio.
    await request(app)
      .post(`/api/v1/orders/${orderId}/chat/read`)
      .set(await authHeader(driverUser))
      .send({ channel: 'business_driver' });

    const messages = await OrderMessage.find({ orderId }).sort({ createdAt: 1 });
    expect(messages[0].channel).toBe('client_driver');
    expect(messages[0].readAt).toBeNull();
    expect(messages[1].channel).toBe('business_driver');
    expect(messages[1].readAt).toBeTruthy();
  });

  it('el estado del pedido cuenta los no leídos de cada hilo para el domiciliario', async () => {
    await post(client, { message: 'Uno' });
    await post(owner, { message: 'Dos' });
    await post(owner, { message: 'Tres' });

    const state = await request(app)
      .get(`/api/v1/orders/${orderId}/flow`)
      .set(await authHeader(driverUser));
    expect(state.body.data.chat.unread).toBe(1);
    expect(state.body.data.chat.unreadBusiness).toBe(2);
  });

  it('los mensajes de antes del campo `channel` cuentan como del cliente', async () => {
    await OrderMessage.collection.insertOne({
      orderId: (await resolveOrderAccess(orderId, owner)).order._id,
      senderId: client._id,
      senderRole: UserRole.CLIENT,
      message: 'Anterior',
      readAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect((await read(client)).body.data.map((m: any) => m.message)).toEqual(['Anterior']);
    expect((await read(owner)).body.data).toEqual([]);
  });

  it('un comercio ajeno al pedido recibe 404, igual que si no existiera', async () => {
    const strangerOwner = await makeUser({ role: UserRole.BUSINESS });
    await makeBusiness(strangerOwner._id);

    expect((await read(strangerOwner)).status).toBe(404);
    expect((await post(strangerOwner, { message: 'Hola' })).status).toBe(404);
    expect(await OrderMessage.countDocuments({ orderId })).toBe(0);
  });

  it('quien solo puede mirar el pedido no escribe en nombre del local', async () => {
    const access = await resolveOrderAccess(orderId, owner);
    const viewOnly = { ...access, businessPermissions: access.businessPermissions?.filter((p) => p !== 'orders:manage') };

    await expect(orderChatService.send(viewOnly as never, 'Hola')).rejects.toMatchObject({ statusCode: 403 });
    expect(await OrderMessage.countDocuments({ orderId })).toBe(0);
  });

  it('el hilo del comercio también se cierra antes de que haya domiciliario', async () => {
    const product = await makeProduct(business._id, { price: 15000 });
    const other = await orderService.create({
      clientId: client._id.toString(),
      businessId: business._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1 }],
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Calle 8',
      deliveryLatitude: DESTINATION.lat,
      deliveryLongitude: DESTINATION.lng,
    });

    const res = await request(app)
      .post(`/api/v1/orders/${other._id.toString()}/chat/messages`)
      .set(await authHeader(owner))
      .send({ message: '¿Hay alguien?' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHAT_NO_DRIVER');
  });

  it('el administrador lee los dos hilos pero no escribe', async () => {
    await post(client, { message: 'Cliente' });
    await post(owner, { message: 'Comercio' });
    const admin = await makeUser({ role: UserRole.ADMIN });

    expect((await read(admin, 'client_driver')).body.data.map((m: any) => m.message)).toEqual(['Cliente']);
    expect((await read(admin, 'business_driver')).body.data.map((m: any) => m.message)).toEqual(['Comercio']);
    expect((await post(admin, { message: 'Soporte' })).status).toBe(403);
  });
});
