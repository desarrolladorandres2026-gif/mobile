import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { orderService } from '../services/order.service';
import {
  setPaymentProvider,
  SandboxPaymentProvider,
  PaymentProvider,
  PaymentIntent,
  PaymentIntentStatus,
  CreateNativePaymentInput,
} from '../services/payments';
import { Order, Payment, User, SavedCard } from '../models';
import { PaymentMethod, PaymentStatus, UserRole } from '../types';
import {
  makeUser,
  makeBusiness,
  makeProduct,
  makePricingConfig,
  authHeader,
  GARZON,
  offsetKm,
} from './factories';

/**
 * Cobro dentro de la app (`POST /payments/orders/:orderId/pay-native`).
 *
 * El proveedor es un doble en memoria y no Wompi: lo que se prueba aquí es
 * lo que hace la plataforma con lo que la pasarela contesta —el orden de
 * las escrituras, el índice de un solo intento abierto, el reintento tras
 * un rechazo—, no el formato del cuerpo HTTP de Wompi, que ya cubre
 * `wompi.test.ts`.
 */
class FakeNativeProvider implements PaymentProvider {
  readonly name = 'fake-native';
  private txs = new Map<string, PaymentIntent>();
  private seq = 0;
  /** Estado con el que nace la próxima transacción. */
  nextStatus: PaymentIntentStatus = 'pending';
  /** Si se fija, la próxima creación lanza con este mensaje. */
  failNext: string | null = null;
  lastInput: CreateNativePaymentInput | null = null;
  created = 0;

  isConfigured() {
    return true;
  }
  async createPayment(): Promise<PaymentIntent> {
    throw new Error('el cobro nativo no debe pasar por createPayment');
  }
  async getPayment(id: string): Promise<PaymentIntent> {
    const tx = this.txs.get(id);
    if (!tx) throw new Error(`Wompi respondió 404 al consultar la transacción ${id}`);
    return tx;
  }
  async refund(id: string) {
    return this.getPayment(id);
  }
  verifyWebhookSignature() {
    return false;
  }
  parseWebhook() {
    return null;
  }

  async createNativePayment(input: CreateNativePaymentInput): Promise<PaymentIntent> {
    this.lastInput = input;
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    this.created += 1;
    const id = `wompi-tx-${++this.seq}`;
    const intent: PaymentIntent = {
      id,
      status: this.nextStatus,
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      paymentMethodType: 'CARD',
      rawStatus: this.nextStatus.toUpperCase(),
      raw: { id, reference: input.reference },
    };
    this.txs.set(id, intent);
    return intent;
  }

  sources = 0;
  async createPaymentSource(): Promise<{ id: number }> {
    this.sources += 1;
    return { id: 9000 + this.sources };
  }

  /** Lo que haría Wompi al resolver la transacción por su cuenta. */
  settle(id: string, status: PaymentIntentStatus) {
    const tx = this.txs.get(id)!;
    this.txs.set(id, { ...tx, status, rawStatus: status.toUpperCase() });
  }
}

const DESTINATION = offsetKm(GARZON, 1);
const ACCEPTANCE = 'eyJhbGciOiJIUzI1NiJ9.TERMINOS.firma';
const CARD = { kind: 'card_token', token: 'tok_test_1_ABCDEF', installments: 1 };

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

  return { client, order };
}

const payNative = async (
  orderId: unknown,
  user: Awaited<ReturnType<typeof makeUser>>,
  body: Record<string, unknown> = {}
) =>
  request(app)
    .post(`/api/v1/payments/orders/${orderId}/pay-native`)
    .set(await authHeader(user))
    .send({ instrument: CARD, acceptanceToken: ACCEPTANCE, customerEmail: 'cliente@zipp.co', ...body });

describe('POST /api/v1/payments/orders/:orderId/pay-native', () => {
  let provider: FakeNativeProvider;

  beforeEach(() => {
    provider = new FakeNativeProvider();
    setPaymentProvider(provider);
  });

  it('responde 501 si el proveedor activo solo sabe redirigir', async () => {
    setPaymentProvider(new SandboxPaymentProvider());
    const { client, order } = await scenario();

    const res = await payNative(order._id, client);

    expect(res.status).toBe(501);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('rechaza cobrar el pedido de otra persona, sin tocar la pasarela', async () => {
    const { order } = await scenario();
    const otro = await makeUser();

    const res = await payNative(order._id, otro);

    expect(res.status).toBe(404);
    expect(provider.created).toBe(0);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('rechaza con un mensaje explícito cualquier dato crudo de tarjeta', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client, {
      instrument: { ...CARD, number: '4242424242424242', cvc: '123' },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/tokenízalos/);
    // Nada de lo recibido puede haber llegado a la base ni a la pasarela.
    expect(JSON.stringify(res.body)).not.toContain('4242424242424242');
    expect(provider.created).toBe(0);
  });

  it('pide correo a una cuenta registrada con teléfono que no lo trae', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client, { customerEmail: undefined });

    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.errorCode ?? JSON.stringify(res.body)).toMatch(/EMAIL_REQUIRED/);
    expect(provider.created).toBe(0);
  });

  it('el correo de la cuenta manda sobre el del cuerpo', async () => {
    const { client, order } = await scenario();
    await User.updateOne({ _id: client._id }, { $set: { email: 'cuenta@zipp.co' } });

    const res = await payNative(order._id, client, { customerEmail: 'otro@zipp.co' });

    expect(res.status).toBe(201);
    expect(provider.lastInput?.customer.email).toBe('cuenta@zipp.co');
  });

  it('guarda el intento como `online` con el carril aparte y el id real de la pasarela', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.transactionId).toBe('wompi-tx-1');
    // Nunca se reenvía la transacción cruda de la pasarela.
    expect(res.body.data).not.toHaveProperty('raw');

    const payment = await Payment.findOne({ orderId: order._id });
    expect(payment?.method).toBe(PaymentMethod.ONLINE);
    expect(payment?.paymentMethodType).toBe('CARD');
    expect(payment?.transactionId).toBe('wompi-tx-1');
    expect(payment?.transactionId).not.toBe(payment?.reference);
    expect(payment?.status).toBe(PaymentStatus.PENDING);
  });

  it('cobra el total del servidor aunque el cliente mande otro monto', async () => {
    const { client, order } = await scenario();
    const real = order.finance?.customerTotal ?? order.total;

    const res = await payNative(order._id, client, { amount: 1 });

    // Monto distinto = 409, no un cobro por el número del cliente.
    expect(res.status).toBe(409);
    expect(provider.created).toBe(0);

    const ok = await payNative(order._id, client);
    expect(ok.status).toBe(201);
    expect(provider.lastInput?.amount).toBe(real);
  });

  it('un fallo de la pasarela cierra la fila y deja reintentar', async () => {
    const { client, order } = await scenario();
    provider.failNext = 'Wompi rechazó la creación de la transacción (HTTP 422). Tarjeta vencida';

    const failed = await payNative(order._id, client);
    expect(failed.status).toBe(502);
    expect(failed.body.message).toMatch(/vencida/);

    const retired = await Payment.findOne({ orderId: order._id });
    expect(retired?.status).toBe(PaymentStatus.FAILED);

    // Si la fila se hubiera quedado en PENDING, el índice de un solo
    // intento abierto bloquearía este segundo intento para siempre.
    const retry = await payNative(order._id, client);
    expect(retry.status).toBe(201);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(2);
  });

  it('tras un rechazo de la pasarela se puede pagar con otra tarjeta', async () => {
    const { client, order } = await scenario();

    const first = await payNative(order._id, client);
    expect(first.status).toBe(201);
    // Wompi resuelve la transacción como rechazada; el webhook aún no llegó.
    provider.settle('wompi-tx-1', 'declined');

    const second = await payNative(order._id, client, {
      instrument: { ...CARD, token: 'tok_test_2_OTRATARJETA' },
    });

    expect(second.status).toBe(201);
    const rows = await Payment.find({ orderId: order._id }).sort({ createdAt: 1 });
    expect(rows.map((p) => p.status)).toEqual([PaymentStatus.FAILED, PaymentStatus.PENDING]);
    expect(provider.lastInput?.instrument).toMatchObject({ token: 'tok_test_2_OTRATARJETA' });
  });

  it('no abre un segundo cobro mientras el anterior siga vivo en la pasarela', async () => {
    const { client, order } = await scenario();

    await payNative(order._id, client);
    // Sigue PENDING en la pasarela: un Nequi esperando la aprobación, p. ej.
    const second = await payNative(order._id, client);

    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toMatch(/PAYMENT_IN_PROGRESS|cobro en curso/);
    expect(provider.created).toBe(1);
    expect(await Payment.countDocuments({ orderId: order._id })).toBe(1);
  });

  it('si la pasarela ya lo aprobó, no cobra otra vez y avisa que está pagado', async () => {
    const { client, order } = await scenario();

    await payNative(order._id, client);
    provider.settle('wompi-tx-1', 'approved');

    const second = await payNative(order._id, client);

    expect(second.status).toBe(409);
    expect(provider.created).toBe(1);
    const updated = await Order.findById(order._id);
    expect(updated?.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('una aprobación inmediata marca el pedido como pagado por el camino de siempre', async () => {
    const { client, order } = await scenario();
    provider.nextStatus = 'approved';

    const res = await payNative(order._id, client);

    expect(res.status).toBe(201);
    const updated = await Order.findById(order._id);
    expect(updated?.paymentStatus).toBe(PaymentStatus.PAID);
  });
});

describe('Tarjetas guardadas', () => {
  const PERSONAL = 'eyJhbGciOiJIUzI1NiJ9.DATOS.firma';
  const DISPLAY = { brand: 'VISA', lastFour: '4242', expMonth: '08', expYear: '29' };
  let provider: FakeNativeProvider;

  beforeEach(() => {
    provider = new FakeNativeProvider();
    setPaymentProvider(provider);
  });

  it('pagar y guardar crea la fuente primero y cobra contra ella', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client, {
      instrument: { ...CARD, save: true, card: DISPLAY },
      personalDataAuthToken: PERSONAL,
    });

    expect(res.status).toBe(201);
    expect(provider.sources).toBe(1);
    // El token se consumió al crear la fuente: el cobro va contra ella.
    expect(provider.lastInput?.instrument).toEqual({
      kind: 'saved_source',
      paymentSourceId: 9001,
      installments: 1,
    });
    const card = await SavedCard.findOne({ userId: client._id });
    expect(card?.lastFour).toBe('4242');
    expect(card?.gatewaySourceId).toBe(9001);
  });

  it('no guarda nada sin el consentimiento de datos personales', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client, {
      instrument: { ...CARD, save: true, card: DISPLAY },
    });

    expect(res.status).toBe(400);
    expect(provider.sources).toBe(0);
    expect(provider.created).toBe(0);
    expect(await SavedCard.countDocuments({ userId: client._id })).toBe(0);
  });

  it('una persona no puede cobrar con la tarjeta guardada de otra', async () => {
    const { client: victim, order: victimOrder } = await scenario();
    await payNative(victimOrder._id, victim, {
      instrument: { ...CARD, save: true, card: DISPLAY },
      personalDataAuthToken: PERSONAL,
    });
    const victimCard = await SavedCard.findOne({ userId: victim._id });

    const { client: attacker, order: attackerOrder } = await scenario();
    const res = await payNative(attackerOrder._id, attacker, {
      instrument: { kind: 'saved_card', savedCardId: victimCard!._id.toString() },
    });

    expect(res.status).toBe(404);
    expect(provider.created).toBe(1); // solo el cobro de la víctima
  });

  it('la app no puede mandar el id de fuente de la pasarela directamente', async () => {
    const { client, order } = await scenario();

    const res = await payNative(order._id, client, {
      instrument: { kind: 'saved_source', paymentSourceId: 9001, installments: 1 },
    });

    expect(res.status).toBe(400);
    expect(provider.created).toBe(0);
  });

  it('cobra con una tarjeta propia guardada, por nuestro id', async () => {
    const { client, order } = await scenario();
    const card = await SavedCard.create({
      userId: client._id,
      provider: 'fake-native',
      gatewaySourceId: 4321,
      ...DISPLAY,
    });

    const res = await payNative(order._id, client, {
      instrument: { kind: 'saved_card', savedCardId: card._id.toString(), installments: 2 },
    });

    expect(res.status).toBe(201);
    expect(provider.lastInput?.instrument).toEqual({
      kind: 'saved_source',
      paymentSourceId: 4321,
      installments: 2,
    });
  });

  it('lista solo las propias y nunca expone el id de la pasarela', async () => {
    const { client } = await scenario();
    const other = await makeUser();
    await SavedCard.create({ userId: client._id, provider: 'fake-native', gatewaySourceId: 1, ...DISPLAY });
    await SavedCard.create({ userId: other._id, provider: 'fake-native', gatewaySourceId: 2, ...DISPLAY });

    const res = await request(app).get('/api/v1/payments/cards').set(await authHeader(client));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('gatewaySourceId');
  });

  it('borrar una tarjeta ajena responde como si no existiera', async () => {
    const { client } = await scenario();
    const other = await makeUser();
    const foreign = await SavedCard.create({
      userId: other._id,
      provider: 'fake-native',
      gatewaySourceId: 7,
      ...DISPLAY,
    });

    const res = await request(app)
      .delete(`/api/v1/payments/cards/${foreign._id}`)
      .set(await authHeader(client));

    expect(res.status).toBe(404);
    expect(await SavedCard.countDocuments({ _id: foreign._id })).toBe(1);
  });

  it('borrar la propia la deja inservible desde Zipp', async () => {
    const { client, order } = await scenario();
    const card = await SavedCard.create({
      userId: client._id,
      provider: 'fake-native',
      gatewaySourceId: 55,
      ...DISPLAY,
    });

    const del = await request(app).delete(`/api/v1/payments/cards/${card._id}`).set(await authHeader(client));
    expect(del.status).toBe(200);

    const pay = await payNative(order._id, client, {
      instrument: { kind: 'saved_card', savedCardId: card._id.toString() },
    });
    expect(pay.status).toBe(404);
  });
});
