import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { config } from '../config';
import { orderService } from '../services/order.service';
import {
  setPaymentProvider,
  paymentService,
  sweepPendingPayments,
  nativeCapabilities,
  WompiPaymentProvider,
  PaymentProvider,
  PaymentIntent,
  PaymentIntentStatus,
  CreateNativePaymentInput,
  OtpOutcome,
  OtpAttempts,
  OtpRejectedError,
  WebhookEvent,
} from '../services/payments';
import { Order, Payment, LedgerEntry } from '../models';
import {
  PaymentMethod,
  PaymentStatus,
  UserRole,
  LedgerEventType,
  LedgerAccount,
} from '../types';
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
 * Botón Bancolombia y DaviPlata como carriles propios de la app.
 *
 * Dos mitades. La primera prueba el formato que se le manda a Wompi y cómo
 * se lee lo que contesta —con `fetch` simulado, igual que `wompi.test.ts`—.
 * La segunda prueba lo que hace la plataforma con eso: quién puede pedir un
 * código, que un código aceptado no sea una segunda puerta para escribir el
 * estado del pago, y que el barredor pregunte sin inventar desenlaces.
 */

// ════════════════════════════════════════════════════════════════════
// 1 · Formato Wompi
// ════════════════════════════════════════════════════════════════════

const KEYS = {
  publicKey: 'pub_test_abc123',
  privateKey: 'prv_test_abc123',
  integritySecret: 'test_integrity_secret',
  eventsSecret: 'test_events_secret',
};

const nativeInput = (instrument: CreateNativePaymentInput['instrument']): CreateNativePaymentInput => ({
  orderId: 'order-1',
  userId: 'user-1',
  amount: 32500,
  currency: 'COP',
  description: 'Pedido ZIPP-000123 con una descripción larguísima',
  customer: { name: 'Cliente Zipp', phone: '3101234567', email: 'cliente@zipp.co' },
  reference: 'ZIPP-order-1-REF',
  acceptanceToken: 'eyJhbGciOi.TERMINOS',
  instrument,
});

const transaction = (overrides: Record<string, unknown> = {}) => ({
  id: '12518-1707777099-36709',
  reference: 'ZIPP-order-1-REF',
  status: 'PENDING',
  amount_in_cents: 3250000,
  currency: 'COP',
  payment_method_type: 'DAVIPLATA',
  ...overrides,
});

const OTP_SERVICES = {
  token: 'bearer-de-la-transaccion',
  code_otp_send: 'https://api.wompi.co/daviplata/otp/send',
  code_otp_validate: 'https://api.wompi.co/daviplata/otp/validate',
};

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('WompiPaymentProvider · carriles bancarios', () => {
  let provider: WompiPaymentProvider;
  const original = { ...config.payments.wompi };

  beforeEach(() => {
    Object.assign(config.payments.wompi, KEYS, { returnUrl: 'https://zipp.example/pago/retorno' });
    provider = new WompiPaymentProvider();
  });

  afterEach(() => {
    Object.assign(config.payments.wompi, original);
    vi.unstubAllGlobals();
  });

  const stubCreate = (tx: Record<string, unknown> = transaction()) => {
    const spy = vi.fn().mockResolvedValue(json({ data: tx }));
    vi.stubGlobal('fetch', spy);
    return spy;
  };
  const sentBody = (spy: ReturnType<typeof vi.fn>) => JSON.parse(spy.mock.calls[0][1].body);

  describe('Botón Bancolombia', () => {
    it('manda BANCOLOMBIA_TRANSFER como persona, con la dirección de regreso del servidor', async () => {
      const spy = stubCreate(
        transaction({
          payment_method_type: 'BANCOLOMBIA_TRANSFER',
          payment_method: { extra: { async_payment_url: 'https://sandbox.wompi.co/bancolombia?x=1' } },
        })
      );

      const intent = await provider.createNativePayment(nativeInput({ kind: 'bancolombia_transfer' }));

      const body = sentBody(spy);
      expect(body.payment_method.type).toBe('BANCOLOMBIA_TRANSFER');
      expect(body.payment_method.user_type).toBe('PERSON');
      expect(body.payment_method.payment_description.length).toBeLessThanOrEqual(30);
      expect(body.payment_method.ecommerce_url).toBe('https://zipp.example/pago/retorno');
      expect(body.redirect_url).toBe('https://zipp.example/pago/retorno');
      expect(intent.asyncPaymentUrl).toBe('https://sandbox.wompi.co/bancolombia?x=1');
    });

    it('elige el desenlace de sandbox solo con llaves de prueba', async () => {
      const spy = stubCreate();
      await provider.createNativePayment(nativeInput({ kind: 'bancolombia_transfer' }));
      expect(sentBody(spy).payment_method.sandbox_status).toBe(config.payments.wompi.sandboxAsyncStatus);
    });

    it('en producción no envía sandbox_status', async () => {
      Object.assign(config.payments.wompi, { publicKey: 'pub_prod_x', privateKey: 'prv_prod_x' });
      const spy = stubCreate();
      await new WompiPaymentProvider().createNativePayment(nativeInput({ kind: 'bancolombia_transfer' }));
      expect(sentBody(spy).payment_method).not.toHaveProperty('sandbox_status');
    });
  });

  describe('DaviPlata', () => {
    it('manda documento y dirección de regreso, sin pedir celular', async () => {
      const spy = stubCreate();

      await provider.createNativePayment(
        nativeInput({ kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' })
      );

      const body = sentBody(spy);
      expect(body.payment_method).toMatchObject({
        type: 'DAVIPLATA',
        user_legal_id_type: 'CC',
        user_legal_id: '1134568019',
      });
      expect(body.payment_method.payment_description.length).toBeLessThanOrEqual(30);
      expect(body.payment_method).not.toHaveProperty('phone_number');
      expect(body.redirect_url).toBe('https://zipp.example/pago/retorno');
    });

    it('avisa que espera código sin exponer el servicio ni su token', async () => {
      stubCreate(transaction({ payment_method: { extra: { url_services: OTP_SERVICES } } }));

      const intent = await provider.createNativePayment(
        nativeInput({ kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' })
      );

      expect(intent.otpRequired).toBe(true);
      // Ninguna propiedad pública del intento lleva la credencial.
      const { raw: _raw, ...publicPart } = intent;
      expect(JSON.stringify(publicPart)).not.toContain(OTP_SERVICES.token);
    });

    it('no da por válido un servicio de código fuera de wompi.co', async () => {
      stubCreate(
        transaction({
          payment_method: {
            extra: {
              url_services: { ...OTP_SERVICES, code_otp_validate: 'https://evil.example/otp' },
            },
          },
        })
      );

      const intent = await provider.createNativePayment(
        nativeInput({ kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' })
      );
      expect(intent.otpRequired).toBeUndefined();
    });

    it('la tarjeta sigue sin dirección de regreso', async () => {
      const spy = stubCreate(transaction({ payment_method_type: 'CARD' }));
      await provider.createNativePayment(
        nativeInput({ kind: 'card_token', token: 'tok_test_1_ABC', installments: 1 })
      );
      expect(sentBody(spy)).not.toHaveProperty('redirect_url');
    });
  });

  describe('servicios de código', () => {
    /**
     * Enruta por URL: consultar la transacción, reenviar y validar son tres
     * llamadas distintas y cada prueba decide qué contesta la segunda.
     */
    const stubOtp = (
      otpResponse: { body: unknown; status?: number },
      services: Record<string, string> = OTP_SERVICES,
      finalStatus = 'PENDING'
    ) => {
      let reads = 0;
      const spy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/transactions/')) {
          reads += 1;
          // La segunda lectura es la que se hace después de validar.
          const status = reads > 1 ? finalStatus : 'PENDING';
          return json({ data: transaction({ status, payment_method: { extra: { url_services: services } } }) });
        }
        return json(otpResponse.body, otpResponse.status ?? 200);
      });
      vi.stubGlobal('fetch', spy);
      return spy;
    };

    const callsTo = (spy: ReturnType<typeof vi.fn>, url: string) =>
      spy.mock.calls.filter(([u]) => u === url);

    it('valida con el Bearer de la transacción y el código como número', async () => {
      const spy = stubOtp(
        {
          body: {
            status: 200,
            code: 'OK',
            data: {
              transaction: {
                status: 'PENDING',
                steps: { ConfirmIntention: [{ estado: 'Aprobado', numAprobacion: '452341' }] },
              },
            },
          },
        },
        OTP_SERVICES,
        'APPROVED'
      );

      const outcome = await provider.validateOtp('12518-1707777099-36709', '574829');

      const [[, init]] = callsTo(spy, OTP_SERVICES.code_otp_validate);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${OTP_SERVICES.token}`);
      expect(JSON.parse(init.body)).toEqual({ code: 574829 });
      expect(outcome.accepted).toBe(true);
      // El estado sale de la API de Transacciones, releída después.
      expect(outcome.intent.status).toBe('approved');
    });

    it('un código errado responde 200 y aun así NO cuenta como aceptado', async () => {
      stubOtp({
        body: {
          status: 200,
          code: 'OK',
          data: {
            transaction: { status: 'PENDING' },
            attempts: { currentSendCode: 1, limitSendCode: 2, currentValidateCode: 1, limitValidateCode: 2 },
          },
        },
      });

      const outcome = await provider.validateOtp('12518-1707777099-36709', '111111');

      expect(outcome.accepted).toBe(false);
      expect(outcome.attempts).toEqual({ sent: 1, maxSends: 2, validated: 1, maxValidations: 2 });
      expect(outcome.intent.status).toBe('pending');
    });

    it('intentos agotados (422) llegan como un rechazo tipado, no como un fallo', async () => {
      stubOtp({
        status: 422,
        body: { status: 422, code: 'ERROR', message: 'Validation attempts for this session have been exhausted.', data: { status: 'PENDING' } },
      });

      const error = await provider.validateOtp('12518-1707777099-36709', '111111').catch((e) => e);
      expect(error).toBeInstanceOf(OtpRejectedError);
      expect(error.reason).toBe('exhausted');
    });

    it('un 422 sobre una transacción ya terminada se distingue de los intentos agotados', async () => {
      stubOtp({ status: 422, body: { status: 422, code: 'ERROR', message: 'Transaction finalized', data: { status: 'DECLINED' } } });
      const error = await provider.validateOtp('12518-1707777099-36709', '111111').catch((e) => e);
      expect(error.reason).toBe('finalized');
    });

    it('un 500 de Wompi NO es un rechazo: es un fallo que se puede reintentar', async () => {
      stubOtp({ status: 500, body: {} });
      const error = await provider.validateOtp('12518-1707777099-36709', '111111').catch((e) => e);
      expect(error).not.toBeInstanceOf(OtpRejectedError);
    });

    it('intentos agotados (422) se propagan con el mensaje de Wompi', async () => {
      stubOtp({
        status: 422,
        body: {
          status: 422,
          code: 'ERROR',
          message: 'Validation attempts for this session have been exhausted.',
          data: { status: 'PENDING' },
        },
      });

      await expect(provider.validateOtp('12518-1707777099-36709', '111111')).rejects.toThrow(
        /exhausted/
      );
    });

    it('nunca le entrega el Bearer a un host que no sea de Wompi', async () => {
      const foreign = { ...OTP_SERVICES, code_otp_validate: 'https://evil.example/otp' };
      const spy = stubOtp({ body: {} }, foreign);

      await expect(provider.validateOtp('12518-1707777099-36709', '574829')).rejects.toThrow();
      expect(callsTo(spy, 'https://evil.example/otp')).toHaveLength(0);
    });

    it('reenviar es un POST sin cuerpo y devuelve los intentos', async () => {
      const spy = stubOtp({
        body: {
          status: 200,
          code: 'OK',
          data: { attempts: { currentSendCode: 2, limitSendCode: 2, currentValidateCode: 0, limitValidateCode: 2 } },
        },
      });

      const attempts = await provider.resendOtp('12518-1707777099-36709');

      const [[, init]] = callsTo(spy, OTP_SERVICES.code_otp_send);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(attempts).toEqual({ sent: 2, maxSends: 2, validated: 0, maxValidations: 2 });
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 · Plataforma
// ════════════════════════════════════════════════════════════════════

/**
 * Doble en memoria de la pasarela: lo que se prueba aquí es lo que hace la
 * plataforma con lo que la pasarela contesta, no el formato HTTP de Wompi.
 */
class FakeBankProvider implements PaymentProvider {
  readonly name = 'fake-bank';
  private txs = new Map<string, PaymentIntent>();
  private seq = 0;
  created = 0;
  otpCalls = 0;
  lastInput: CreateNativePaymentInput | null = null;
  /** Código que la pasarela da por bueno. */
  goodCode = '574829';
  /** Estado en que queda la transacción cuando el código es bueno. */
  afterGoodCode: PaymentIntentStatus = 'approved';

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

  // Webhooks: la firma se da por buena y el cuerpo ES el evento. La
  // autenticidad del webhook ya la cubre `wompi.test.ts`.
  verifyWebhookSignature() {
    return true;
  }
  parseWebhook(payload: unknown): WebhookEvent | null {
    return payload as WebhookEvent;
  }

  async createNativePayment(input: CreateNativePaymentInput): Promise<PaymentIntent> {
    this.lastInput = input;
    this.created += 1;
    const id = `wompi-tx-${++this.seq}`;
    const kind = input.instrument.kind;
    const intent: PaymentIntent = {
      id,
      status: 'pending',
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      paymentMethodType: kind === 'daviplata' ? 'DAVIPLATA' : 'BANCOLOMBIA_TRANSFER',
      rawStatus: 'PENDING',
      raw: { id, reference: input.reference },
      ...(kind === 'bancolombia_transfer'
        ? { asyncPaymentUrl: 'https://sandbox.wompi.co/bancolombia' }
        : {}),
      ...(kind === 'daviplata' ? { otpRequired: true } : {}),
    };
    this.txs.set(id, intent);
    return intent;
  }

  async resendOtp(): Promise<OtpAttempts | undefined> {
    this.otpCalls += 1;
    return { sent: 2, maxSends: 2, validated: 0, maxValidations: 2 };
  }

  /** Si se fija, el próximo intento de código lanza esto. */
  failOtp: Error | null = null;

  async validateOtp(id: string, code: string): Promise<OtpOutcome> {
    this.otpCalls += 1;
    if (this.failOtp) throw this.failOtp;
    const accepted = code === this.goodCode;
    if (accepted) this.settle(id, this.afterGoodCode);
    return {
      accepted,
      attempts: { sent: 1, maxSends: 2, validated: 1, maxValidations: 2 },
      intent: await this.getPayment(id),
    };
  }

  settle(id: string, status: PaymentIntentStatus) {
    const tx = this.txs.get(id)!;
    this.txs.set(id, { ...tx, status, rawStatus: status.toUpperCase() });
  }
}

const DESTINATION = offsetKm(GARZON, 1);
const ACCEPTANCE = 'eyJhbGciOiJIUzI1NiJ9.TERMINOS.firma';
const BANCOLOMBIA = { kind: 'bancolombia_transfer' };
const DAVIPLATA = { kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' };

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

const payNative = async (orderId: unknown, user: TestUser, instrument: unknown) =>
  request(app)
    .post(`/api/v1/payments/orders/${orderId}/pay-native`)
    .set(await authHeader(user))
    .send({ instrument, acceptanceToken: ACCEPTANCE, customerEmail: 'cliente@zipp.co' });

const validateOtp = async (transactionId: string, user: TestUser, code: unknown) =>
  request(app)
    .post(`/api/v1/payments/status/${transactionId}/otp/validate`)
    .set(await authHeader(user))
    .send({ code });

const resendOtp = async (transactionId: string, user: TestUser) =>
  request(app)
    .post(`/api/v1/payments/status/${transactionId}/otp/resend`)
    .set(await authHeader(user))
    .send();

describe('Carriles bancarios · plataforma', () => {
  let provider: FakeBankProvider;

  beforeEach(() => {
    provider = new FakeBankProvider();
    setPaymentProvider(provider);
  });

  afterEach(() => {
    setPaymentProvider(null);
  });

  it('anuncia los dos carriles solo si el proveedor sabe cobrarlos', () => {
    expect(nativeCapabilities()).toMatchObject({ bancolombiaTransfer: true, daviplata: true });

    // Sin servicios de código, DaviPlata sería un callejón sin salida.
    const sinOtp = new FakeBankProvider();
    (sinOtp as { validateOtp?: unknown }).validateOtp = undefined;
    setPaymentProvider(sinOtp);
    expect(nativeCapabilities()).toMatchObject({ bancolombiaTransfer: true, daviplata: false });
  });

  describe('Botón Bancolombia', () => {
    it('crea el cobro con el importe del pedido y devuelve la dirección del banco', async () => {
      const { client, order } = await scenario();

      const res = await payNative(order._id, client, BANCOLOMBIA);

      expect(res.status).toBe(201);
      expect(res.body.data.asyncPaymentUrl).toBe('https://sandbox.wompi.co/bancolombia');
      expect(provider.lastInput!.instrument).toEqual({ kind: 'bancolombia_transfer' });
      // El importe sale del pedido, nunca del cliente.
      expect(provider.lastInput!.amount).toBe(order.finance!.customerTotal);

      const payment = await Payment.findOne({ orderId: order._id });
      expect(payment!.status).toBe(PaymentStatus.PENDING);
      expect(payment!.paymentMethodType).toBe('BANCOLOMBIA_TRANSFER');
    });

    it('rechaza campos de más en el instrumento', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, { ...BANCOLOMBIA, amount: 1 });
      expect(res.status).toBe(400);
      expect(provider.created).toBe(0);
    });

    it('doble toque: el segundo intento con el primero vivo responde PAYMENT_IN_PROGRESS', async () => {
      const { client, order } = await scenario();

      expect((await payNative(order._id, client, BANCOLOMBIA)).status).toBe(201);
      const second = await payNative(order._id, client, BANCOLOMBIA);

      expect(second.status).toBe(409);
      expect(JSON.stringify(second.body)).toMatch(/PAYMENT_IN_PROGRESS/);
      expect(provider.created).toBe(1);
    });

    it('webhook duplicado: un solo asiento y una sola transición a PAID', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);
      const payment = await Payment.findOne({ orderId: order._id });
      provider.settle(res.body.data.transactionId, 'approved');

      const event = JSON.stringify({
        paymentId: payment!.reference,
        gatewayTransactionId: res.body.data.transactionId,
        status: 'approved',
        rawStatus: 'APPROVED',
        amount: payment!.amount,
        currency: 'COP',
        paymentMethodType: 'BANCOLOMBIA_TRANSFER',
      });

      const first = await paymentService.handleWebhook(event, 'firma');
      const again = await paymentService.handleWebhook(event, 'firma');

      expect(first).toMatchObject({ accepted: true, duplicated: false });
      expect(again).toMatchObject({ accepted: true, duplicated: true });

      const capturas = await LedgerEntry.countDocuments({
        orderId: order._id,
        event: LedgerEventType.PAYMENT_CAPTURED,
        account: LedgerAccount.CUSTOMER_PAYMENT,
      });
      expect(capturas).toBe(1);
      expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
    });

    it('webhook antes del regreso: la consulta posterior no vuelve a aplicar nada', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);
      const txId = res.body.data.transactionId;
      const payment = await Payment.findOne({ orderId: order._id });
      provider.settle(txId, 'approved');

      await paymentService.handleWebhook(
        JSON.stringify({
          paymentId: payment!.reference,
          gatewayTransactionId: txId,
          status: 'approved',
          rawStatus: 'APPROVED',
          amount: payment!.amount,
          currency: 'COP',
        }),
        'firma'
      );

      // La persona vuelve del banco y la app consulta.
      const status = await request(app)
        .get(`/api/v1/payments/status/${txId}`)
        .set(await authHeader(client));

      expect(status.status).toBe(200);
      expect(status.body.data.status).toBe('approved');

      const refreshed = await Payment.findById(payment!._id);
      expect(refreshed!.statusHistory.filter((h) => h.status === PaymentStatus.PAID)).toHaveLength(1);
    });

    it('un rechazo tardío tras volver a Zipp deja el pedido sin pagar', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);
      provider.settle(res.body.data.transactionId, 'declined');

      const status = await request(app)
        .get(`/api/v1/payments/status/${res.body.data.transactionId}`)
        .set(await authHeader(client));

      expect(status.body.data.status).toBe('declined');
      expect((await Order.findById(order._id))!.paymentStatus).not.toBe(PaymentStatus.PAID);
    });
  });

  describe('DaviPlata', () => {
    it('crea el cobro y avisa que espera código', async () => {
      const { client, order } = await scenario();

      const res = await payNative(order._id, client, DAVIPLATA);

      expect(res.status).toBe(201);
      expect(res.body.data.otpRequired).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/url_services|bearer/i);
    });

    it('rechaza un documento mal formado antes de tocar la pasarela', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, { ...DAVIPLATA, userLegalId: '12$' });
      expect(res.status).toBe(400);
      expect(provider.created).toBe(0);
    });

    it('código correcto: el pago pasa a PAID por el mismo camino del webhook', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);

      const otp = await validateOtp(res.body.data.transactionId, client, '574829');

      expect(otp.status).toBe(200);
      expect(otp.body.data).toMatchObject({ accepted: true, status: 'approved' });
      expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PAID);
      expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);

      const capturas = await LedgerEntry.countDocuments({
        orderId: order._id,
        event: LedgerEventType.PAYMENT_CAPTURED,
        account: LedgerAccount.CUSTOMER_PAYMENT,
      });
      expect(capturas).toBe(1);
    });

    it('código aceptado pero cobro aún pendiente: no se da por pagado', async () => {
      provider.afterGoodCode = 'pending';
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);

      const otp = await validateOtp(res.body.data.transactionId, client, '574829');

      expect(otp.body.data).toMatchObject({ accepted: true, status: 'pending' });
      expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PENDING);
    });

    it('código errado: 200 con intentos, el pago sigue pendiente', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);

      const otp = await validateOtp(res.body.data.transactionId, client, '111111');

      expect(otp.status).toBe(200);
      expect(otp.body.data.accepted).toBe(false);
      expect(otp.body.data.attempts).toMatchObject({ validated: 1, maxValidations: 2 });
      expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PENDING);
    });

    it('el código de otra persona responde 404 y no llega a la pasarela', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);
      const otro = await makeUser();

      const otp = await validateOtp(res.body.data.transactionId, otro, '574829');
      const resend = await resendOtp(res.body.data.transactionId, otro);

      expect(otp.status).toBe(404);
      expect(resend.status).toBe(404);
      expect(provider.otpCalls).toBe(0);
    });

    it('rechaza un código que no sea de 4 a 8 dígitos', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);

      for (const code of ['12', 'abcdef', 574829, '5748291234']) {
        expect((await validateOtp(res.body.data.transactionId, client, code)).status).toBe(400);
      }
      expect(provider.otpCalls).toBe(0);
    });

    it('un cobro ya pagado no admite más códigos', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);
      await validateOtp(res.body.data.transactionId, client, '574829');
      const callsBefore = provider.otpCalls;

      const again = await validateOtp(res.body.data.transactionId, client, '574829');

      expect(again.status).toBe(409);
      expect(JSON.stringify(again.body)).toMatch(/PAYMENT_NOT_PENDING/);
      expect(provider.otpCalls).toBe(callsBefore);
    });

    it('un cobro de Bancolombia no se confirma con código', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);

      const otp = await validateOtp(res.body.data.transactionId, client, '574829');

      expect(otp.status).toBe(409);
      expect(JSON.stringify(otp.body)).toMatch(/OTP_NOT_APPLICABLE/);
      expect(provider.otpCalls).toBe(0);
    });

    it('intentos agotados: 422 OTP_REJECTED con un mensaje para la persona, sin tocar el pago', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);
      provider.failOtp = new OtpRejectedError('exhausted', 'exhausted');

      const otp = await validateOtp(res.body.data.transactionId, client, '111111');

      expect(otp.status).toBe(422);
      expect(JSON.stringify(otp.body)).toMatch(/OTP_REJECTED/);
      expect(otp.body.message).toMatch(/agotaron/);
      // Un rechazo del código no inventa un desenlace: lo decide la pasarela.
      expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PENDING);
    });

    it('pasarela caída: 502, distinto de un rechazo', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);
      provider.failOtp = new Error('Wompi respondió 503');

      const otp = await validateOtp(res.body.data.transactionId, client, '574829');

      expect(otp.status).toBe(502);
      expect(JSON.stringify(otp.body)).toMatch(/GATEWAY_ERROR/);
      expect(JSON.stringify(otp.body)).not.toContain('503');
    });

    it('reenviar devuelve los intentos', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, DAVIPLATA);

      const resend = await resendOtp(res.body.data.transactionId, client);

      expect(resend.status).toBe(200);
      expect(resend.body.data.attempts).toMatchObject({ sent: 2, maxSends: 2 });
    });
  });

  describe('barrido de cobros pendientes', () => {
    /** Envejece la fila sin pasar por Mongoose, que refresca `updatedAt`. */
    const age = async (paymentId: unknown, minutes: number) => {
      await Payment.collection.updateOne(
        { _id: paymentId as never },
        { $set: { updatedAt: new Date(Date.now() - minutes * 60_000) } }
      );
    };

    it('aplica un pago aprobado aunque la app se haya cerrado y el webhook no llegara', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);
      const payment = await Payment.findOne({ orderId: order._id });
      provider.settle(res.body.data.transactionId, 'approved');
      await age(payment!._id, 10);

      const result = await sweepPendingPayments();

      expect(result.checked).toBe(1);
      expect((await Payment.findById(payment!._id))!.status).toBe(PaymentStatus.PAID);
      expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
    });

    it('no inventa desenlaces: lo que la pasarela ve pendiente sigue pendiente', async () => {
      const { client, order } = await scenario();
      await payNative(order._id, client, BANCOLOMBIA);
      const payment = await Payment.findOne({ orderId: order._id });
      await age(payment!._id, 10);

      await sweepPendingPayments();

      expect((await Payment.findById(payment!._id))!.status).toBe(PaymentStatus.PENDING);
    });

    it('deja en paz lo recién creado y lo demasiado viejo', async () => {
      const { client, order } = await scenario();
      const res = await payNative(order._id, client, BANCOLOMBIA);
      const payment = await Payment.findOne({ orderId: order._id });
      provider.settle(res.body.data.transactionId, 'approved');

      // Recién creado: menos de dos minutos.
      expect((await sweepPendingPayments()).checked).toBe(0);

      // Más de un día: se deja de preguntar.
      await age(payment!._id, 25 * 60);
      expect((await sweepPendingPayments()).checked).toBe(0);
      expect((await Payment.findById(payment!._id))!.status).toBe(PaymentStatus.PENDING);
    });

    it('una pasarela caída no tumba el barrido', async () => {
      const { client, order } = await scenario();
      await payNative(order._id, client, BANCOLOMBIA);
      const payment = await Payment.findOne({ orderId: order._id });
      await age(payment!._id, 10);
      provider.getPayment = async () => {
        throw new Error('Wompi respondió 503');
      };

      const result = await sweepPendingPayments();

      expect(result).toEqual({ checked: 0, failed: 1 });
      expect((await Payment.findById(payment!._id))!.status).toBe(PaymentStatus.PENDING);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 3 · Cancelar la transacción desde la espera del banco
// ════════════════════════════════════════════════════════════════════

const abandon = async (transactionId: string, user: TestUser) =>
  request(app)
    .post(`/api/v1/payments/status/${transactionId}/abandon`)
    .set(await authHeader(user))
    .send();

const captures = (orderId: unknown) =>
  LedgerEntry.countDocuments({
    orderId: orderId as never,
    event: LedgerEventType.PAYMENT_CAPTURED,
    account: LedgerAccount.CUSTOMER_PAYMENT,
  });

describe('Abandonar la verificación del banco', () => {
  let provider: FakeBankProvider;

  beforeEach(() => {
    provider = new FakeBankProvider();
    setPaymentProvider(provider);
  });

  afterEach(() => {
    setPaymentProvider(null);
  });

  it('suelta un intento que sigue pendiente y deja pagar con otro método', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);

    const res = await abandon(first.body.data.transactionId, client);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('abandoned');
    const retired = await Payment.findOne({ orderId: order._id });
    expect(retired!.status).toBe(PaymentStatus.FAILED);
    expect(retired!.statusHistory.at(-1)!.source).toBe('client');

    // Sin el abandono, esto sería PAYMENT_IN_PROGRESS.
    const second = await payNative(order._id, client, DAVIPLATA);
    expect(second.status).toBe(201);
  });

  it('si el banco ya aprobó, lo dice y no suelta nada', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    provider.settle(first.body.data.transactionId, 'approved');

    const res = await abandon(first.body.data.transactionId, client);

    expect(res.body.data.status).toBe('approved');
    expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PAID);
    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('sin respuesta de Wompi no suelta el intento: "no sé" no es "no pagó"', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    provider.getPayment = async () => {
      throw new Error('Wompi respondió 503');
    };

    const res = await abandon(first.body.data.transactionId, client);

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).toMatch(/GATEWAY_ERROR/);
    expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PENDING);
  });

  it('el intento de otra persona responde 404 y no se toca', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    const otro = await makeUser();

    const res = await abandon(first.body.data.transactionId, otro);

    expect(res.status).toBe(404);
    expect((await Payment.findOne({ orderId: order._id }))!.status).toBe(PaymentStatus.PENDING);
  });

  it('un intento ya rechazado responde declined sin tocar nada', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    provider.settle(first.body.data.transactionId, 'declined');
    await paymentService.sync(first.body.data.transactionId);

    const res = await abandon(first.body.data.transactionId, client);

    expect(res.body.data.status).toBe('declined');
  });

  it('aprobación tardía del intento abandonado, sin otro pago: el pedido queda pagado', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    await abandon(first.body.data.transactionId, client);

    provider.settle(first.body.data.transactionId, 'approved');
    await paymentService.sync(first.body.data.transactionId);

    expect((await Order.findById(order._id))!.paymentStatus).toBe(PaymentStatus.PAID);
    expect(await captures(order._id)).toBe(1);
  });

  it('aprobación tardía después de pagar con otro método: va a revisión, no al libro', async () => {
    const { client, order } = await scenario();
    const first = await payNative(order._id, client, BANCOLOMBIA);
    await abandon(first.body.data.transactionId, client);

    // Paga con DaviPlata y queda pagado.
    const second = await payNative(order._id, client, DAVIPLATA);
    await validateOtp(second.body.data.transactionId, client, '574829');
    expect(await captures(order._id)).toBe(1);

    // El banco aprueba el primero de todas formas.
    provider.settle(first.body.data.transactionId, 'approved');
    await paymentService.sync(first.body.data.transactionId);

    const late = await Payment.findOne({ transactionId: first.body.data.transactionId });
    expect(late!.status).toBe(PaymentStatus.PAID);
    expect(late!.metadata?.requiresReview).toBe(true);
    expect(String(late!.metadata?.reviewReason)).toMatch(/dos veces/);
    // Un solo ingreso en el libro: el segundo cobro no se asienta.
    expect(await captures(order._id)).toBe(1);
  });
});
