import { describe, it, expect } from 'vitest';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import express from 'express';
import app from '../app';
import {
  paymentInitiateRateLimiter,
  paymentStatusRateLimiter,
  paymentWebhookRateLimiter,
} from '../middlewares';
import paymentRoutes from '../routes/payment.routes';
import { orderService } from '../services/order.service';
import { setPaymentProvider, SandboxPaymentProvider } from '../services/payments';
import { Payment } from '../models';
import { PaymentMethod, OrderStatus, UserRole } from '../types';
import {
  makeUser,
  makeBusiness,
  makeProduct,
  makePricingConfig,
  authHeader,
  GARZON,
  offsetKm,
} from './factories';

const DESTINATION = offsetKm(GARZON, 1);

/**
 * End-to-end cover for the payment routes: authentication, ownership,
 * validation and rate-limit wiring, driven through the real HTTP layer
 * rather than calling PaymentService directly. Everything in
 * payment-hardening.test.ts exercises the service in isolation — this file
 * is what proves the controller and `validate(initiatePaymentSchema)` are
 * actually on the route and actually enforce what they claim to.
 */

async function scenario() {
  await makePricingConfig();
  const client = await makeUser();
  const owner = await makeUser({ role: UserRole.BUSINESS });
  const business = await makeBusiness(owner._id, { commissionRateBps: 1000 });
  const product = await makeProduct(business._id, { price: 30000 });

  const order = await orderService.create({
    clientId: client._id.toString(),
    businessId: business._id.toString(),
    items: [{ productId: product._id.toString(), quantity: 1 }],
    paymentMethod: PaymentMethod.ONLINE,
    deliveryAddress: 'Cra 10 #5-23',
    deliveryLatitude: DESTINATION.lat,
    deliveryLongitude: DESTINATION.lng,
  });

  return { client, owner, order };
}

describe('POST /api/v1/payments/orders/:orderId/pay', () => {
  setPaymentProvider(new SandboxPaymentProvider());

  it('rechaza pagar el pedido de otro usuario', async () => {
    const { order } = await scenario();
    const otro = await makeUser();

    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(otro))
      .send({});

    expect(res.status).toBe(403);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('ignora por completo el monto manipulado y cobra el real del pedido', async () => {
    const { client, order } = await scenario();

    // El controlador nunca lee `req.body.amount` — siempre pasa a
    // PaymentService el total que el propio servidor calculó para el
    // pedido (`order.finance.customerTotal`). No es que un monto distinto
    // se detecte y se rechace: ni siquiera llega a compararse. Un monto de
    // 1 peso, o de cien millones, tiene exactamente el mismo efecto: cero.
    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({ amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(order.finance.customerTotal);

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment!.amount).toBe(order.finance.customerTotal);
  });

  it('el chequeo de monto de PaymentService sigue ahí como defensa en profundidad', async () => {
    // Aunque el controlador HTTP nunca reenvía `amount`, PaymentService.
    // initiate() igual lo rechazaría si algún otro futuro llamador (un panel
    // de administración, una tarea interna) sí lo hiciera y no coincidiera
    // con el total real. Se prueba directamente contra el servicio porque
    // el controlador actual no da forma de ejercitar esta rama por HTTP.
    const { client, order } = await scenario();
    const { paymentService } = await import('../services/payments');

    await expect(
      paymentService.initiate({
        orderId: order._id.toString(),
        userId: client._id.toString(),
        amount: 1,
        description: 'Prueba',
        customer: { name: 'Cliente', phone: '3101234567' },
      })
    ).rejects.toThrow(/no coincide con el total/i);

    expect(await Payment.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('cobra exactamente el monto real del pedido cuando no se manda amount', async () => {
    const { client, order } = await scenario();

    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(order.finance.customerTotal);
  });

  it('rechaza un segundo cobro de un pedido ya pagado', async () => {
    const { client, order } = await scenario();

    const first = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});
    expect(first.status).toBe(201);
    // El sandbox aprueba de inmediato al crear el intento.
    expect(first.body.data.status).toBe('approved');

    const second = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/ya fue pagado/i);
  });

  it('rechaza pagar un pedido cancelado', async () => {
    const { client, order } = await scenario();
    await orderService.updateStatus(
      order._id.toString(),
      OrderStatus.CANCELLED,
      client._id.toString(),
      UserRole.CLIENT,
      'Ya no lo quiero'
    );

    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cancelado/i);
  });

  it('rechaza un redirectUrl que no está en la lista blanca', async () => {
    const { client, order } = await scenario();

    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({ redirectUrl: 'https://evil.com/phish' });

    expect(res.status).toBe(400);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('acepta el deep link propio de la app como redirectUrl', async () => {
    const { client, order } = await scenario();

    const res = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({ redirectUrl: 'zipp://payment-result' });

    expect(res.status).toBe(201);
  });

  it('exige autenticación', async () => {
    const { order } = await scenario();
    const res = await request(app).post(`/api/v1/payments/orders/${order._id}/pay`).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/payments/status/:transactionId', () => {
  it('rechaza consultar el pago de otro usuario', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await scenario();
    const otro = await makeUser();

    const pay = await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});

    const res = await request(app)
      .get(`/api/v1/payments/status/${pay.body.data.transactionId}`)
      .set(authHeader(otro));

    expect(res.status).toBe(403);
  });

  it('rechaza una referencia con formato inválido antes de tocar la base de datos', async () => {
    const { client } = await scenario();
    const res = await request(app)
      .get('/api/v1/payments/status/$where:1')
      .set(authHeader(client));
    expect(res.status).toBe(400);
  });
});

describe('Referencia de pago duplicada', () => {
  it('el índice único impide dos pagos con la misma referencia', async () => {
    const { client, order } = await scenario();
    setPaymentProvider(new SandboxPaymentProvider());

    await request(app)
      .post(`/api/v1/payments/orders/${order._id}/pay`)
      .set(authHeader(client))
      .send({});

    const existing = await Payment.findOne({ orderId: order._id });
    expect(existing).toBeTruthy();

    // Intentar insertar un segundo documento con la misma referencia —
    // simulando un error de programación que reintentara sin pasar por
    // PaymentService.initiate — debe chocar con el índice único, no
    // crear un segundo pago silenciosamente.
    await expect(
      Payment.create({
        orderId: order._id,
        userId: client._id,
        type: existing!.type,
        method: existing!.method,
        amount: existing!.amount,
        currency: existing!.currency,
        reference: existing!.reference,
      })
    ).rejects.toThrow(/duplicate key|E11000/i);
  });
});

describe('Rate limiting de pagos', () => {
  it('los tres limitadores están montados en las rutas correctas', () => {
    // Prueba de cableado, no de umbral: bajo NODE_ENV=test los contadores se
    // elevan a Number.MAX_SAFE_INTEGER a propósito (ver middlewares/security.ts)
    // para que las demás pruebas no choquen entre sí compartiendo el mismo
    // proceso — así que lo que se puede probar aquí es que el middleware
    // correcto sigue atado a cada ruta, por referencia, no que dispare un 429.
    type Layer = { route?: { path: string; stack: Array<{ handle: unknown }> } };
    const stack = (paymentRoutes as unknown as { stack: Layer[] }).stack;

    const layerFor = (path: string) => stack.find((l) => l.route?.path === path);

    const payHandlers = layerFor('/orders/:orderId/pay')!.route!.stack.map((s) => s.handle);
    expect(payHandlers).toContain(paymentInitiateRateLimiter);

    const statusHandlers = layerFor('/status/:transactionId')!.route!.stack.map((s) => s.handle);
    expect(statusHandlers).toContain(paymentStatusRateLimiter);

    const webhookHandlers = layerFor('/webhook')!.route!.stack.map((s) => s.handle);
    expect(webhookHandlers).toContain(paymentWebhookRateLimiter);
  });

  it('el mecanismo de límite (misma forma que los de pagos) responde 429 al superarse', async () => {
    // Reproduce exactamente la forma de los limitadores de pagos —
    // windowMs, mensaje JSON, standardHeaders — con un `max` minúsculo y
    // fijo, para probar el patrón sin depender del interruptor de pruebas
    // que neutraliza los límites reales durante la suite.
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 2,
      message: { success: false, message: 'Demasiadas peticiones.' },
      standardHeaders: true,
      legacyHeaders: false,
    });

    const probe = express();
    probe.get('/probe', limiter, (_req, res) => res.json({ ok: true }));

    const first = await request(probe).get('/probe');
    const second = await request(probe).get('/probe');
    const third = await request(probe).get('/probe');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ success: false, message: 'Demasiadas peticiones.' });
  });
});
