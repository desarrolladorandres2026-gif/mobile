import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { config } from '../config';
import { orderService } from '../services/order.service';
import { ledgerService } from '../services/ledger.service';
import { incidentCenterService } from '../services/incidentCenter.service';
import {
  setPaymentProvider,
  paymentService,
  sweepUnsettledCaptures,
  WompiPaymentProvider,
  PaymentProvider,
  PaymentIntent,
  PaymentIntentStatus,
  CreateNativePaymentInput,
  WebhookEvent,
} from '../services/payments';
import { Order, Payment, Payout, LedgerEntry } from '../models';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  PayoutStatus,
  UserRole,
  LedgerEventType,
  LedgerAccount,
} from '../types';
import {
  makeUser,
  makeStaff,
  makeBusiness,
  makeProduct,
  makePricingConfig,
  authHeader,
  GARZON,
  offsetKm,
} from './factories';

/**
 * Continuidad del cobro hasta el comercio (auditoría de pagos 2026-10-02).
 *
 * Lo que se prueba aquí no es la entrada del dinero —eso lo cubren
 * `payment-hardening`, `payment-bank-rails` y `wompi`— sino lo que pasa
 * cuando algo se corta a mitad de camino y quién se entera:
 *
 *  1. Un cobro aprobado que quedó a medias se termina en el reintento.
 *  2. El cliente no cancela por su cuenta un pedido que ya está en cocina.
 *  3. Un cobro retenido llega al centro de incidentes y se puede cerrar.
 *  4. Un pedido aceptable que nadie acepta salta como incidente.
 *  5. Un corte de red al crear el cobro no termina en un segundo cobro.
 *  6. Un intento que cerramos no revive porque la pasarela diga "pendiente".
 */

class FakeGateway implements PaymentProvider {
  readonly name = 'fake-gateway';
  private txs = new Map<string, PaymentIntent>();
  private seq = 0;
  created = 0;
  /** Cómo termina la próxima creación. */
  createMode: 'ok' | 'createdThenNetworkError' | 'networkErrorNoTx' = 'ok';
  /** Si la búsqueda por referencia contesta o falla. */
  searchMode: 'ok' | 'throws' = 'ok';

  isConfigured() {
    return true;
  }
  async createPayment(): Promise<PaymentIntent> {
    throw new Error('no debe usarse');
  }
  async getPayment(id: string): Promise<PaymentIntent> {
    const tx = this.txs.get(id);
    if (!tx) throw new Error(`404 ${id}`);
    return tx;
  }
  async findPaymentByReference(reference: string): Promise<PaymentIntent | null> {
    if (this.searchMode === 'throws') throw new Error('ETIMEDOUT');
    for (const tx of this.txs.values()) {
      if ((tx.raw as { reference?: string })?.reference === reference) return tx;
    }
    return null;
  }
  async refund(id: string) {
    return this.getPayment(id);
  }
  async getCheckoutConfig() {
    return {
      publicKey: 'pub_test_x',
      environment: 'test' as const,
      acceptanceToken: 'acc',
      personalDataAuthToken: '',
      permalinks: {},
      returnUrl: 'https://zipp.example/pago/retorno',
      threeDs: false,
    };
  }
  verifyWebhookSignature() {
    return true;
  }
  parseWebhook(payload: unknown): WebhookEvent | null {
    return payload as WebhookEvent;
  }

  async createNativePayment(input: CreateNativePaymentInput): Promise<PaymentIntent> {
    if (this.createMode === 'networkErrorNoTx') throw new Error('ECONNRESET');
    this.created += 1;
    const id = `wompi-tx-${++this.seq}`;
    const intent: PaymentIntent = {
      id,
      status: 'pending',
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      paymentMethodType: 'BANCOLOMBIA_TRANSFER',
      rawStatus: 'PENDING',
      raw: { id, reference: input.reference },
      asyncPaymentUrl: 'https://sandbox.wompi.co/bancolombia',
    };
    this.txs.set(id, intent);
    if (this.createMode === 'createdThenNetworkError') throw new Error('ECONNRESET');
    return intent;
  }

  settle(id: string, status: PaymentIntentStatus) {
    const tx = this.txs.get(id)!;
    this.txs.set(id, { ...tx, status, rawStatus: status.toUpperCase() });
  }
}

const DESTINATION = offsetKm(GARZON, 1);
const ACCEPTANCE = 'eyJhbGciOiJIUzI1NiJ9.TERMINOS.firma';
const BANCOLOMBIA = { kind: 'bancolombia_transfer' };

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

type TestUser = Awaited<ReturnType<typeof makeUser>>;

const payNative = async (orderId: unknown, user: TestUser) =>
  request(app)
    .post(`/api/v1/payments/orders/${orderId}/pay-native`)
    .set(await authHeader(user))
    .send({ instrument: BANCOLOMBIA, acceptanceToken: ACCEPTANCE, customerEmail: 'cliente@zipp.co' });

const approvedEvent = (payment: { reference?: string; amount: number }, txId: string) =>
  JSON.stringify({
    paymentId: payment.reference,
    gatewayTransactionId: txId,
    status: 'approved',
    rawStatus: 'APPROVED',
    amount: payment.amount,
    currency: 'COP',
    paymentMethodType: 'BANCOLOMBIA_TRANSFER',
  });

const captures = (orderId: unknown) =>
  LedgerEntry.countDocuments({
    orderId,
    event: LedgerEventType.PAYMENT_CAPTURED,
    account: LedgerAccount.CUSTOMER_PAYMENT,
  });

const ALLOW_ALL = () => true;

describe('Continuidad del cobro', () => {
  let provider: FakeGateway;

  beforeEach(() => {
    provider = new FakeGateway();
    setPaymentProvider(provider);
  });

  afterEach(() => {
    setPaymentProvider(null);
    vi.restoreAllMocks();
  });

  /** Un pedido pagado de punta a punta por el camino normal. */
  async function paidOrder() {
    const { client, order } = await scenario();
    const res = await payNative(order._id, client);
    const txId = res.body.data.transactionId as string;
    provider.settle(txId, 'approved');
    const payment = (await Payment.findOne({ orderId: order._id }))!;
    await paymentService.handleWebhook(approvedEvent(payment, txId), 'firma');
    return { client, order, payment: (await Payment.findById(payment._id))!, txId };
  }

  describe('1 · un cobro aprobado a medias se termina', () => {
    it('si el asiento falla, el reintento del webhook lo escribe y libera los pagos', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client);
      const txId = res.body.data.transactionId as string;
      provider.settle(txId, 'approved');
      const payment = (await Payment.findOne({ orderId: order._id }))!;

      vi.spyOn(ledgerService, 'recordPaymentCaptured').mockRejectedValueOnce(new Error('mongo blip'));

      await expect(
        paymentService.handleWebhook(approvedEvent(payment, txId), 'firma')
      ).rejects.toThrow(/mongo blip/);
      expect((await Payment.findById(payment._id))!.status).toBe(PaymentStatus.PAID);
      expect(await captures(order._id)).toBe(0);

      // Wompi reintenta. Antes esto respondía "sin cambios" y el asiento no
      // se escribía nunca.
      const retry = await paymentService.handleWebhook(approvedEvent(payment, txId), 'firma');

      expect(retry).toMatchObject({ accepted: true });
      expect(await captures(order._id)).toBe(1);
      expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
      expect(await Payout.countDocuments({ orderId: order._id, status: PayoutStatus.ACCRUED })).toBe(0);
      expect((await Payment.findById(payment._id))!.metadata?.captureSettledAt).toBeTruthy();
    });

    it('si se cortó antes de marcar el pedido, el barrido lo marca y el comercio lo ve', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client);
      const payment = (await Payment.findOne({ orderId: order._id }))!;
      provider.settle(res.body.data.transactionId, 'approved');

      // El reclamo del pago ocurrió y el proceso cayó justo después.
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: PaymentStatus.PAID, processedAt: new Date(Date.now() - 10 * 60_000) } }
      );
      expect((await Order.findById(order._id))!.paymentStatus).not.toBe(PaymentStatus.PAID);

      const result = await sweepUnsettledCaptures();

      expect(result.resumed).toBe(1);
      expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
      expect(await captures(order._id)).toBe(1);
    });

    it('un webhook repetido de un cobro ya terminado no vuelve a asentar nada', async () => {
      const { order, payment, txId } = await paidOrder();

      await paymentService.handleWebhook(approvedEvent(payment, txId), 'firma');
      await sweepUnsettledCaptures(new Date(Date.now() + 10 * 60_000));

      expect(await captures(order._id)).toBe(1);
    });

    it('un segundo cobro que cayó antes de marcarse se retiene y no se asienta', async () => {
      const { order, payment } = await paidOrder();

      const dup = await Payment.create({
        orderId: order._id,
        userId: payment.userId,
        type: PaymentType.ORDER_PAYMENT,
        method: PaymentMethod.ONLINE,
        status: PaymentStatus.PAID,
        amount: payment.amount,
        currency: payment.currency,
        reference: 'ZIPP-DUPLICADO',
        transactionId: 'wompi-tx-dup',
        processedAt: new Date(Date.now() + 1000),
      });

      await sweepUnsettledCaptures(new Date(Date.now() + 10 * 60_000));

      const held = (await Payment.findById(dup._id))!;
      expect(held.metadata?.requiresReview).toBe(true);
      expect(await captures(order._id)).toBe(1);
    });
  });

  describe('2 · hasta dónde cancela el cliente', () => {
    it.each([OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.ON_WAY])(
      'no puede cancelar un pedido en %s',
      async (status) => {
        const { client, order } = await paidOrder();
        await Order.updateOne({ _id: order._id }, { $set: { status } });

        await expect(
          orderService.updateStatus(
            order._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Ya no'
          )
        ).rejects.toThrow(/no se puede cancelar desde la app/);
        expect((await Order.findById(order._id))!.status).toBe(status);
      }
    );

    it('sí puede cancelar uno aceptado que la cocina no ha empezado', async () => {
      const { client, order } = await paidOrder();
      await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.ACCEPTED } });

      const cancelled = await orderService.updateStatus(
        order._id.toString(), OrderStatus.CANCELLED, client._id.toString(), UserRole.CLIENT, 'Me equivoqué'
      );
      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    });
  });

  describe('3 · cobros retenidos en el centro de incidentes', () => {
    it('aparece, Finanzas lo cierra y desaparece', async () => {
      const { client, order, payment } = await paidOrder();
      const dup = await Payment.create({
        orderId: order._id,
        userId: payment.userId,
        type: PaymentType.ORDER_PAYMENT,
        method: PaymentMethod.ONLINE,
        status: PaymentStatus.PAID,
        amount: payment.amount,
        currency: payment.currency,
        reference: 'ZIPP-DUPLICADO-2',
        transactionId: 'wompi-tx-dup-2',
        processedAt: new Date(Date.now() + 1000),
      });
      await sweepUnsettledCaptures(new Date(Date.now() + 10 * 60_000));

      const open = await incidentCenterService.open(ALLOW_ALL);
      const incident = open.find((i) => i.kind === 'payment_review');
      expect(incident?.id).toBe(String(dup._id));
      expect(incident?.orderId).toBe(String(order._id));

      const denied = await request(app)
        .post(`/api/v1/payments/${dup._id}/review/resolve`)
        .set(await authHeader(client))
        .send({ note: 'Reembolsado desde el panel de Wompi' });
      expect(denied.status).toBe(403);

      const finanzas = await makeStaff({ roleSlug: 'finanzas' });
      const ok = await request(app)
        .post(`/api/v1/payments/${dup._id}/review/resolve`)
        .set(await authHeader(finanzas))
        .send({ note: 'Reembolsado desde el panel de Wompi' });
      expect(ok.status).toBe(200);

      const after = await incidentCenterService.open(ALLOW_ALL);
      expect(after.find((i) => i.kind === 'payment_review')).toBeUndefined();
    });
  });

  describe('4 · pedido aceptable que nadie acepta', () => {
    it('un pedido pagado sin aceptar a los 10 minutos es incidente alto', async () => {
      const { order } = await paidOrder();
      await Order.collection.updateOne(
        { _id: order._id },
        { $set: { updatedAt: new Date(Date.now() - 15 * 60_000) } }
      );

      const incident = (await incidentCenterService.open(ALLOW_ALL)).find(
        (i) => i.kind === 'order_unaccepted'
      );
      expect(incident?.orderId).toBe(String(order._id));
      expect(incident?.severity).toBe('high');
    });

    it('uno en línea sin pagar no cuenta: todavía no es del comercio', async () => {
      const { order } = await scenario();
      await Order.collection.updateOne(
        { _id: order._id },
        { $set: { updatedAt: new Date(Date.now() - 15 * 60_000) } }
      );

      const kinds = (await incidentCenterService.open(ALLOW_ALL)).map((i) => i.kind);
      expect(kinds).not.toContain('order_unaccepted');
    });
  });

  describe('5 · corte de red al crear el cobro', () => {
    it('si Wompi alcanzó a crearlo, se sigue con esa transacción', async () => {
      provider.createMode = 'createdThenNetworkError';
      const { client, order } = await scenario();

      const res = await payNative(order._id, client);

      expect(res.status).toBe(201);
      expect(res.body.data.transactionId).toBe('wompi-tx-1');
      const payment = (await Payment.findOne({ orderId: order._id }))!;
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.transactionId).toBe('wompi-tx-1');
    });

    it('si Wompi confirma que no existe, el intento se cierra y se puede reintentar', async () => {
      provider.createMode = 'networkErrorNoTx';
      const { client, order } = await scenario();

      const res = await payNative(order._id, client);

      expect(res.status).toBe(502);
      expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.FAILED);

      provider.createMode = 'ok';
      expect((await payNative(order._id, client)).status).toBe(201);
    });

    it('si no se puede saber, nadie abre un segundo cobro hasta resolverlo', async () => {
      provider.createMode = 'networkErrorNoTx';
      provider.searchMode = 'throws';
      const { client, order } = await scenario();

      const first = await payNative(order._id, client);
      expect(first.status).toBe(502);
      expect(JSON.stringify(first.body)).toMatch(/PAYMENT_UNCERTAIN/);
      const row = (await Payment.findOne({ orderId: order._id }))!;
      expect(row.status).toBe(PaymentStatus.PENDING);
      expect(row.metadata?.creationUncertain).toBe(true);

      provider.createMode = 'ok';
      const second = await payNative(order._id, client);
      expect(second.status).toBe(409);
      expect(provider.created).toBe(0);

      // Wompi vuelve a contestar y confirma que no existe: el barrido lo cierra.
      provider.searchMode = 'ok';
      await paymentService.resolveUncertainCreation(row._id.toString());
      expect((await Payment.findById(row._id))!.status).toBe(PaymentStatus.FAILED);

      expect((await payNative(order._id, client)).status).toBe(201);
    });

    it('doble toque: un intento recién creado sin respuesta de Wompi no se retira', async () => {
      const { client, order } = await scenario();
      await Payment.create({
        orderId: order._id,
        userId: client._id,
        type: PaymentType.ORDER_PAYMENT,
        method: PaymentMethod.ONLINE,
        status: PaymentStatus.PENDING,
        amount: order.finance?.customerTotal ?? order.total,
        currency: 'COP',
        reference: 'ZIPP-EN-VUELO',
        transactionId: 'ZIPP-EN-VUELO',
        metadata: { instrumentKind: 'bancolombia_transfer' },
      });

      const res = await payNative(order._id, client);

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/PAYMENT_IN_PROGRESS/);
      expect(provider.created).toBe(0);
    });
  });

  describe('6 · un intento cerrado no revive', () => {
    it('tras abandonarlo, una consulta con la pasarela aún pendiente no lo reabre', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client);
      const txId = res.body.data.transactionId as string;

      const abandoned = await paymentService.abandonAttempt({ userId: client._id.toString(), transactionId: txId });
      expect(abandoned.status).toBe('abandoned');

      await paymentService.sync(txId);

      const payment = (await Payment.findOne({ orderId: order._id }))!;
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.statusHistory.at(-1)!.status).toBe(PaymentStatus.FAILED);

      // Si el banco lo aprueba al final, el dinero sí entra.
      provider.settle(txId, 'approved');
      await paymentService.sync(txId);
      expect((await Payment.findById(payment._id))!.status).toBe(PaymentStatus.PAID);
    });
  });
});

describe('WompiPaymentProvider · búsqueda por referencia y tiempo límite', () => {
  const KEYS = {
    publicKey: 'pub_test_abc123',
    privateKey: 'prv_test_abc123',
    integritySecret: 'test_integrity_secret',
    eventsSecret: 'test_events_secret',
  };
  const original = { ...config.payments.wompi };
  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  beforeEach(() => {
    Object.assign(config.payments.wompi, KEYS, { httpTimeoutMs: 15000 });
  });

  afterEach(() => {
    Object.assign(config.payments.wompi, original);
    vi.unstubAllGlobals();
  });

  it('busca con la llave privada y devuelve la transacción de esa referencia', async () => {
    const spy = vi.fn().mockResolvedValue(
      json({
        data: [
          { id: 'tx-1', reference: 'ZIPP-REF', status: 'APPROVED', amount_in_cents: 3250000, currency: 'COP' },
        ],
      })
    );
    vi.stubGlobal('fetch', spy);

    const intent = await new WompiPaymentProvider().findPaymentByReference('ZIPP-REF');

    const [url, init] = spy.mock.calls[0];
    expect(url).toMatch(/\/transactions\?reference=ZIPP-REF$/);
    expect(init.headers.Authorization).toBe(`Bearer ${KEYS.privateKey}`);
    expect(intent).toMatchObject({ id: 'tx-1', status: 'approved', amount: 32500 });
  });

  it('sin resultados responde null, y un error de Wompi lanza', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: [] })));
    expect(await new WompiPaymentProvider().findPaymentByReference('ZIPP-NADA')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)));
    await expect(new WompiPaymentProvider().findPaymentByReference('ZIPP-NADA')).rejects.toThrow(/503/);
  });

  it('cada llamada a Wompi lleva tiempo límite', async () => {
    const spy = vi.fn().mockResolvedValue(
      json({ data: { id: 'tx-1', reference: 'ZIPP-REF', status: 'PENDING', amount_in_cents: 100, currency: 'COP' } })
    );
    vi.stubGlobal('fetch', spy);

    await new WompiPaymentProvider().getPayment('tx-1');

    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
