import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WompiPaymentProvider } from '../services/payments/wompi.provider';
import { config } from '../config';

const KEYS = {
  publicKey: 'pub_test_abc123',
  privateKey: 'prv_test_abc123',
  integritySecret: 'test_integrity_secret',
  eventsSecret: 'test_events_secret',
};

const customer = { name: 'Cliente Zipp', phone: '3101234567', email: 'cliente@zipp.co' };

const input = (overrides: Partial<Record<string, unknown>> = {}) => ({
  orderId: 'order-1',
  userId: 'user-1',
  amount: 25000,
  currency: 'COP',
  description: 'Pedido de prueba',
  customer,
  reference: 'ZIPP-order-1-REF',
  ...overrides,
});

describe('WompiPaymentProvider', () => {
  let provider: WompiPaymentProvider;
  const original = { ...config.payments.wompi };

  beforeEach(() => {
    Object.assign(config.payments.wompi, KEYS);
    provider = new WompiPaymentProvider();
  });

  afterEach(() => {
    Object.assign(config.payments.wompi, original);
    vi.unstubAllGlobals();
  });

  it('no está configurado si falta cualquier llave o secreto', () => {
    expect(provider.isConfigured()).toBe(true);

    for (const key of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
      Object.assign(config.payments.wompi, KEYS, { [key]: '' });
      expect(new WompiPaymentProvider().isConfigured()).toBe(false);
    }
  });

  describe('createPayment (Web Checkout)', () => {
    it('genera una URL de checkout con la firma de integridad correcta', async () => {
      const intent = await provider.createPayment(input());

      expect(intent.status).toBe('pending');
      expect(intent.id).toBe('ZIPP-order-1-REF');
      expect(intent.checkoutUrl).toContain('https://checkout.wompi.co/p/?');

      const url = new URL(intent.checkoutUrl!);
      expect(url.searchParams.get('public-key')).toBe(KEYS.publicKey);
      expect(url.searchParams.get('currency')).toBe('COP');
      expect(url.searchParams.get('amount-in-cents')).toBe('2500000');
      expect(url.searchParams.get('reference')).toBe('ZIPP-order-1-REF');

      // Firma = SHA256(referencia + montoEnCentavos + moneda + expiración +
      // secretoIntegridad). La expiración va ANTES del secreto, según la
      // documentación oficial: firmarla al final produce un rechazo de Wompi.
      const expiration = url.searchParams.get('expiration-time')!;
      const expected = crypto
        .createHash('sha256')
        .update(`ZIPP-order-1-REF2500000COP${expiration}test_integrity_secret`)
        .digest('hex');
      expect(url.searchParams.get('signature:integrity')).toBe(expected);
    });

    it('acota la vigencia del enlace en lugar de dejarlo pagable para siempre', async () => {
      const intent = await provider.createPayment(input());
      const url = new URL(intent.checkoutUrl!);

      const expiration = url.searchParams.get('expiration-time');
      expect(expiration).toBeTruthy();

      const expiresAt = new Date(expiration!).getTime();
      expect(Number.isNaN(expiresAt)).toBe(false);
      expect(expiresAt).toBeGreaterThan(Date.now());
      // El valor por defecto son 30 minutos; con margen para la ejecución.
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
    });

    it('incluye redirect-url y los datos del cliente cuando se proveen', async () => {
      const intent = await provider.createPayment(
        input({ redirectUrl: 'zipp://payment-result' })
      );
      const url = new URL(intent.checkoutUrl!);

      expect(url.searchParams.get('redirect-url')).toBe('zipp://payment-result');
      expect(url.searchParams.get('customer-data:email')).toBe(customer.email);
      expect(url.searchParams.get('customer-data:full-name')).toBe(customer.name);
      expect(url.searchParams.get('customer-data:phone-number')).toBe(customer.phone);
    });

    it('exige una referencia — es responsabilidad de PaymentService generarla', async () => {
      await expect(
        provider.createPayment(input({ reference: undefined }))
      ).rejects.toThrow(/referencia/i);
    });

    it('nunca llama a la red: el enlace es una función pura de sus parámetros', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await provider.createPayment(input());

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('getCheckoutConfig', () => {
    const merchant = (overrides: Record<string, unknown> = {}) => ({
      data: {
        presigned_acceptance: {
          acceptance_token: 'eyJhbGciOi.TERMINOS',
          permalink: 'https://wompi.com/terminos.pdf',
          type: 'END_USER_POLICY',
        },
        presigned_personal_data_auth: {
          acceptance_token: 'eyJhbGciOi.DATOS',
          permalink: 'https://wompi.com/datos.pdf',
          type: 'PERSONAL_DATA_AUTH',
        },
        ...overrides,
      },
    });

    it('informa la dirección de regreso y si 3DS está encendido', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => merchant() }));
      Object.assign(config.payments.wompi, { threeDs: true, returnUrl: 'https://zipp.example/pago/retorno' });

      const cfg = await new WompiPaymentProvider().getCheckoutConfig();

      expect(cfg.returnUrl).toBe('https://zipp.example/pago/retorno');
      expect(cfg.threeDs).toBe(true);
    });

    it('devuelve la llave pública, el entorno y los dos consentimientos', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => merchant() }));

      const cfg = await provider.getCheckoutConfig();

      expect(cfg.publicKey).toBe(KEYS.publicKey);
      expect(cfg.environment).toBe('test');
      expect(cfg.acceptanceToken).toBe('eyJhbGciOi.TERMINOS');
      expect(cfg.personalDataAuthToken).toBe('eyJhbGciOi.DATOS');
      expect(cfg.permalinks.termsAndConditions).toBe('https://wompi.com/terminos.pdf');
      expect(cfg.permalinks.personalDataAuth).toBe('https://wompi.com/datos.pdf');
    });

    it('nunca deja salir la llave privada ni el secreto de integridad', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => merchant() }));

      const serialised = JSON.stringify(await provider.getCheckoutConfig());

      expect(serialised).not.toContain(KEYS.privateKey);
      expect(serialised).not.toContain(KEYS.integritySecret);
      expect(serialised).not.toContain(KEYS.eventsSecret);
    });

    it('pide la configuración una sola vez: la cachea', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => merchant() });
      vi.stubGlobal('fetch', fetchSpy);

      await provider.getCheckoutConfig();
      await provider.getCheckoutConfig();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('la caché es por instancia, no global: otro entorno no hereda la anterior', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => merchant() }));
      await provider.getCheckoutConfig();

      Object.assign(config.payments.wompi, KEYS, { publicKey: 'pub_prod_xyz' });
      const production = new WompiPaymentProvider();

      expect((await production.getCheckoutConfig()).environment).toBe('production');
    });

    it('falla si Wompi no devuelve token de aceptación, en vez de entregar una configuración a medias', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => merchant({ presigned_acceptance: {} }),
        })
      );

      await expect(provider.getCheckoutConfig()).rejects.toThrow(/token de aceptación/);
    });

    it('propaga un error legible si Wompi responde con un estado HTTP de error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
      await expect(provider.getCheckoutConfig()).rejects.toThrow(/503/);
    });
  });

  describe('createNativePayment (API de Transacciones)', () => {
    const nativeInput = (overrides: Record<string, unknown> = {}) => ({
      ...input(),
      acceptanceToken: 'eyJhbGciOi.TERMINOS',
      instrument: { kind: 'card_token' as const, token: 'tok_test_1_ABC', installments: 1 },
      ...overrides,
    });

    const transaction = (overrides: Record<string, unknown> = {}) => ({
      id: '1234-1610641025-49201',
      reference: 'ZIPP-order-1-REF',
      status: 'PENDING',
      amount_in_cents: 2500000,
      currency: 'COP',
      payment_method_type: 'CARD',
      ...overrides,
    });

    const stubCreate = (tx: Record<string, unknown> = transaction()) => {
      const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: tx }) });
      vi.stubGlobal('fetch', spy);
      return spy;
    };

    const sentBody = (spy: ReturnType<typeof vi.fn>) => JSON.parse(spy.mock.calls[0][1].body);

    it('cobra con la llave privada contra /transactions', async () => {
      const spy = stubCreate();
      await provider.createNativePayment(nativeInput());

      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://sandbox.wompi.co/v1/transactions');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${KEYS.privateKey}`);
    });

    it('firma SIN tiempo de expiración: ese parámetro es solo del Web Checkout', async () => {
      const spy = stubCreate();
      await provider.createNativePayment(nativeInput());

      const expected = crypto
        .createHash('sha256')
        .update('ZIPP-order-1-REF2500000COPtest_integrity_secret')
        .digest('hex');
      expect(sentBody(spy).signature).toBe(expected);
    });

    it('arma el cuerpo de una tarjeta tokenizada con cuotas y aceptación', async () => {
      const spy = stubCreate();
      await provider.createNativePayment(nativeInput());

      const body = sentBody(spy);
      expect(body.payment_method).toEqual({ type: 'CARD', token: 'tok_test_1_ABC', installments: 1 });
      expect(body.acceptance_token).toBe('eyJhbGciOi.TERMINOS');
      expect(body.amount_in_cents).toBe(2500000);
      expect(body.customer_email).toBe('cliente@zipp.co');
      expect(body).not.toHaveProperty('payment_source_id');
    });

    it('Nequi viaja con el teléfono y nada más', async () => {
      const spy = stubCreate(transaction({ payment_method_type: 'NEQUI' }));
      await provider.createNativePayment(
        nativeInput({ instrument: { kind: 'nequi', phone: '3991111111' } })
      );
      expect(sentBody(spy).payment_method).toEqual({ type: 'NEQUI', phone_number: '3991111111' });
    });

    it('una tarjeta guardada va como payment_source_id, con solo las cuotas en payment_method', async () => {
      const spy = stubCreate();
      await provider.createNativePayment(
        nativeInput({ instrument: { kind: 'saved_source', paymentSourceId: 3891, installments: 3 } })
      );

      const body = sentBody(spy);
      expect(body.payment_source_id).toBe(3891);
      // Ni tipo ni token: la pasarela ya sabe qué tarjeta es.
      expect(body.payment_method).toEqual({ installments: 3 });
    });

    it('PSE lleva banco, documento, descripción acotada y la dirección de regreso del servidor', async () => {
      const spy = stubCreate(
        transaction({
          payment_method_type: 'PSE',
          payment_method: { extra: { async_payment_url: 'https://banco.example/pse?x=1' } },
        })
      );

      const intent = await provider.createNativePayment(
        nativeInput({
          description: 'Pedido ZIPP-000123 con una descripción larguísima',
          // Lo que diga quien llama no cuenta: la dirección es del servidor.
          redirectUrl: 'https://evil.example/robar',
          instrument: {
            kind: 'pse',
            financialInstitutionCode: '1022',
            userType: 0,
            userLegalIdType: 'CC',
            userLegalId: '1999888777',
          },
        })
      );

      const body = sentBody(spy);
      expect(body.payment_method.type).toBe('PSE');
      expect(body.payment_method.financial_institution_code).toBe('1022');
      expect(body.payment_method.payment_description.length).toBeLessThanOrEqual(30);
      expect(body.redirect_url).toBe(config.payments.wompi.returnUrl);
      expect(body.redirect_url).toMatch(/^https:\/\//);
      expect(intent.asyncPaymentUrl).toBe('https://banco.example/pse?x=1');
    });

    it('descarta una URL de banco que no sea https: se abriría dentro del WebView de la app', async () => {
      stubCreate(
        transaction({ payment_method: { extra: { async_payment_url: 'javascript:alert(1)' } } })
      );
      const intent = await provider.createNativePayment(nativeInput());
      expect(intent.asyncPaymentUrl).toBeUndefined();
    });

    it('entrega el reto 3DS ya desescapado, y solo si está pendiente', async () => {
      stubCreate(
        transaction({
          payment_method: {
            extra: {
              three_ds_auth: {
                current_step: 'CHALLENGE',
                current_step_status: 'PENDING',
                three_ds_method_data: '&lt;form action=&quot;x&quot;&gt;&amp;lt;&lt;/form&gt;',
              },
            },
          },
        })
      );

      const intent = await provider.createNativePayment(nativeInput());
      // `&amp;lt;` debe quedar en `&lt;`: desescapar `&amp;` primero lo
      // convertiría en `<` y cambiaría el documento.
      expect(intent.threeDsChallengeHtml).toBe('<form action="x">&lt;</form>');
    });

    it('no inventa un reto cuando el paso 3DS ya terminó', async () => {
      stubCreate(
        transaction({
          payment_method: {
            extra: {
              three_ds_auth: {
                current_step: 'CHALLENGE',
                current_step_status: 'COMPLETED',
                three_ds_method_data: '&lt;p&gt;viejo&lt;/p&gt;',
              },
            },
          },
        })
      );
      expect((await provider.createNativePayment(nativeInput())).threeDsChallengeHtml).toBeUndefined();
    });

    it('conserva el motivo de Wompi cuando rechaza la creación', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 422,
          json: async () => ({ error: { reason: 'La tarjeta está vencida' } }),
        })
      );
      await expect(provider.createNativePayment(nativeInput())).rejects.toThrow(/422.*vencida/);
    });

    it('exige correo antes de llamar a Wompi, en vez de recibir su 422', async () => {
      const spy = stubCreate();
      await expect(
        provider.createNativePayment(nativeInput({ customer: { name: 'Sin correo' } }))
      ).rejects.toThrow(/correo/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('devuelve el id real de Wompi y el pedido de quien llama', async () => {
      stubCreate();
      const intent = await provider.createNativePayment(nativeInput());
      expect(intent.id).toBe('1234-1610641025-49201');
      expect(intent.orderId).toBe('order-1');
      expect(intent.status).toBe('pending');
    });
  });

  describe('3D Secure', () => {
    const BROWSER = {
      browser_color_depth: '24',
      browser_screen_height: '800',
      browser_screen_width: '400',
      browser_language: 'es-CO',
      browser_user_agent: 'Mozilla/5.0 Zipp',
      browser_tz: '300',
    };

    const card = (instrument: Record<string, unknown> = { kind: 'card_token', token: 'tok_test_1_A', installments: 1 }) => ({
      ...input(),
      acceptanceToken: 'eyJhbGciOi.TERMINOS',
      instrument: instrument as any,
      browserInfo: BROWSER,
    });

    const stub = () => {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { id: 'tx-1', reference: 'ZIPP-order-1-REF', status: 'PENDING', amount_in_cents: 2500000, currency: 'COP' },
        }),
      });
      vi.stubGlobal('fetch', spy);
      return spy;
    };
    const body = (spy: ReturnType<typeof vi.fn>) => JSON.parse(spy.mock.calls[0][1].body);

    it('apagado por defecto: no se pide 3DS aunque llegue el navegador', async () => {
      const spy = stub();
      await provider.createNativePayment(card());
      expect(body(spy)).not.toHaveProperty('is_three_ds');
      expect(body(spy).customer_data).not.toHaveProperty('browser_info');
    });

    it('encendido: tarjeta nueva lleva is_three_ds en la raíz y el navegador en customer_data', async () => {
      Object.assign(config.payments.wompi, { threeDs: true });
      const spy = stub();
      await provider.createNativePayment(card());

      const sent = body(spy);
      expect(sent.is_three_ds).toBe(true);
      expect(sent.payment_method).not.toHaveProperty('is_three_ds');
      expect(sent.customer_data.browser_info).toEqual(BROWSER);
      // Sandbox: se simula el resultado del reto.
      expect(sent.three_ds_auth_type).toBe(config.payments.wompi.threeDsSandboxType);
    });

    it('en producción nunca manda el campo de simulación del sandbox', async () => {
      Object.assign(config.payments.wompi, KEYS, { publicKey: 'pub_prod_x', privateKey: 'prv_prod_x', threeDs: true });
      const spy = stub();
      await new WompiPaymentProvider().createNativePayment(card());

      expect(body(spy).is_three_ds).toBe(true);
      expect(body(spy)).not.toHaveProperty('three_ds_auth_type');
    });

    it('ni tarjeta guardada ni Nequi piden 3DS por este camino', async () => {
      Object.assign(config.payments.wompi, { threeDs: true });

      const saved = stub();
      await provider.createNativePayment(card({ kind: 'saved_source', paymentSourceId: 9, installments: 1 }));
      expect(body(saved)).not.toHaveProperty('is_three_ds');

      const nequi = stub();
      await provider.createNativePayment(card({ kind: 'nequi', phone: '3991111111' }));
      expect(body(nequi)).not.toHaveProperty('is_three_ds');
    });

    it('sin datos del navegador el cobro sale sin 3DS en vez de fallar', async () => {
      Object.assign(config.payments.wompi, { threeDs: true });
      const spy = stub();
      await provider.createNativePayment({ ...card(), browserInfo: undefined });
      expect(body(spy)).not.toHaveProperty('is_three_ds');
    });

    it('el reto aparece al consultar, no al crear: getPayment también lo entrega', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              id: 'tx-1',
              reference: 'ZIPP-order-1-REF',
              status: 'PENDING',
              amount_in_cents: 2500000,
              currency: 'COP',
              payment_method: {
                extra: {
                  three_ds_auth: {
                    current_step: 'CHALLENGE',
                    current_step_status: 'PENDING',
                    three_ds_method_data: '&lt;iframe&gt;&lt;/iframe&gt;',
                  },
                },
              },
            },
          }),
        })
      );

      const intent = await provider.getPayment('tx-1');
      expect(intent.threeDsChallengeHtml).toBe('<iframe></iframe>');
    });
  });

  describe('createPaymentSource', () => {
    const sourceInput = {
      token: 'tok_test_1_ABCDEF',
      customerEmail: 'cliente@zipp.co',
      acceptanceToken: 'eyJhbGciOi.TERMINOS',
      personalDataAuthToken: 'eyJhbGciOi.DATOS',
    };

    it('crea la fuente con la llave privada y los dos consentimientos', async () => {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: 3891, status: 'AVAILABLE' } }),
      });
      vi.stubGlobal('fetch', spy);

      const source = await provider.createPaymentSource(sourceInput);

      expect(source.id).toBe(3891);
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://sandbox.wompi.co/v1/payment_sources');
      expect(init.headers.Authorization).toBe(`Bearer ${KEYS.privateKey}`);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        type: 'CARD',
        token: 'tok_test_1_ABCDEF',
        acceptance_token: 'eyJhbGciOi.TERMINOS',
        accept_personal_auth: 'eyJhbGciOi.DATOS',
      });
    });

    it('rechaza una fuente que Wompi no deja disponible', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 1, status: 'PENDING' } }) })
      );
      await expect(provider.createPaymentSource(sourceInput)).rejects.toThrow(/PENDING/);
    });

    it('rechaza una respuesta sin identificador utilizable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: '3891' } }) })
      );
      await expect(provider.createPaymentSource(sourceInput)).rejects.toThrow(/identificador/);
    });
  });

  describe('listPseBanks', () => {
    const banks = [
      { financial_institution_code: '0', financial_institution_name: 'A continuación seleccione su banco' },
      { financial_institution_code: '1022', financial_institution_name: 'BANCO UNION COLOMBIANO' },
      { financial_institution_code: '', financial_institution_name: 'sin código' },
    ];

    it('mapea la lista y descarta entradas incompletas', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: banks }) }));
      const list = await provider.listPseBanks();
      expect(list).toContainEqual({ code: '1022', name: 'BANCO UNION COLOMBIANO' });
      expect(list.find((b) => b.name === 'sin código')).toBeUndefined();
    });

    it('usa la llave pública: es un catálogo, no un movimiento de dinero', async () => {
      const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: banks }) });
      vi.stubGlobal('fetch', spy);
      await provider.listPseBanks();
      expect(spy.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEYS.publicKey}`);
    });

    it('cachea una lista con bancos, pero nunca una vacía', async () => {
      const empty = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
      vi.stubGlobal('fetch', empty);
      await provider.listPseBanks();
      await provider.listPseBanks();
      expect(empty).toHaveBeenCalledTimes(2);

      const full = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: banks }) });
      vi.stubGlobal('fetch', full);
      await provider.listPseBanks();
      await provider.listPseBanks();
      expect(full).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPayment', () => {
    it('mapea la transacción de Wompi a un PaymentIntent', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              id: '1234-1610641025-49201',
              reference: 'ZIPP-order-1-REF',
              status: 'APPROVED',
              amount_in_cents: 2500000,
              currency: 'COP',
              payment_method_type: 'NEQUI',
            },
          }),
        })
      );

      const intent = await provider.getPayment('1234-1610641025-49201');

      expect(intent.status).toBe('approved');
      expect(intent.amount).toBe(25000);
      expect(intent.paymentMethodType).toBe('NEQUI');
    });

    it('lanza un error legible si Wompi responde con un estado HTTP de error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(provider.getPayment('no-existe')).rejects.toThrow(/404/);
    });

    it('consulta con la llave pública: la privada no viaja en una lectura', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fetchSpy);

      await provider.getPayment('1234-1610641025-49201').catch(() => {});

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers.Authorization).toBe(`Bearer ${KEYS.publicKey}`);
      expect(init.headers.Authorization).not.toContain(KEYS.privateKey);
    });
  });

  describe('webhooks', () => {
    /** Ahora, en segundos, que es como Wompi sella sus eventos. */
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    function signedPayload(
      tx: Record<string, unknown>,
      timestamp: number | string = nowSeconds()
    ) {
      const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
      const values = properties.map((p) => String((tx as any)[p.split('.')[1]]));
      const checksum = crypto
        .createHash('sha256')
        .update(values.join('') + String(timestamp) + KEYS.eventsSecret)
        .digest('hex');

      return {
        event: 'transaction.updated',
        data: { transaction: { ...tx } },
        environment: 'test',
        signature: { properties, checksum },
        timestamp,
        sent_at: new Date().toISOString(),
      };
    }

    const tx = {
      id: '1234-1610641025-49201',
      reference: 'ZIPP-order-1-REF',
      status: 'APPROVED',
      amount_in_cents: 2500000,
      status_message: null,
      payment_method_type: 'CARD',
    };

    it('acepta un evento con checksum válido', () => {
      const body = JSON.stringify(signedPayload(tx));
      expect(provider.verifyWebhookSignature(body, '')).toBe(true);
    });

    it('rechaza un evento con checksum manipulado', () => {
      const payload = signedPayload(tx);
      payload.signature.checksum = 'f'.repeat(64);
      expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
    });

    it('rechaza un evento cuyo monto fue alterado después de firmarlo', () => {
      const payload = signedPayload(tx);
      (payload.data.transaction as any).amount_in_cents = 1;
      expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
    });

    it('rechaza JSON ilegible o sin firma', () => {
      expect(provider.verifyWebhookSignature('no es json', '')).toBe(false);
      expect(provider.verifyWebhookSignature(JSON.stringify({ data: {} }), '')).toBe(false);
    });

    it('interpreta un evento válido, usando la referencia como clave de negocio', () => {
      const event = provider.parseWebhook(signedPayload(tx));
      expect(event).toEqual(
        expect.objectContaining({
          paymentId: 'ZIPP-order-1-REF',
          status: 'approved',
          amount: 25000,
          gatewayTransactionId: '1234-1610641025-49201',
          paymentMethodType: 'CARD',
        })
      );
    });

    it('mapea VOIDED y ERROR a sus propios estados, no a "declined"', () => {
      expect(provider.parseWebhook(signedPayload({ ...tx, status: 'VOIDED' }))?.status).toBe('voided');
      expect(provider.parseWebhook(signedPayload({ ...tx, status: 'ERROR' }))?.status).toBe('error');
    });

    it('descarta cargas útiles sin transacción reconocible', () => {
      expect(provider.parseWebhook(null)).toBeNull();
      expect(provider.parseWebhook({ data: {} })).toBeNull();
      expect(
        provider.parseWebhook({
          event: 'transaction.updated',
          data: { transaction: { ...tx, status: 'INVENTADO' } },
        })
      ).toBeNull();
    });

    it('ignora eventos que no son actualizaciones de transacción', () => {
      const payload = signedPayload(tx) as Record<string, unknown>;
      payload.event = 'nequi_token.updated';
      // La firma sigue siendo válida — Wompi publica varios tipos de evento
      // en el mismo endpoint. Solo las transacciones pueden mover dinero.
      expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(true);
      expect(provider.parseWebhook(payload)).toBeNull();
    });

    it('ignora un evento de otro entorno aunque venga bien firmado', () => {
      const payload = signedPayload(tx) as Record<string, unknown>;
      payload.environment = 'prod';
      // Llaves pub_test_ ⇒ solo se aceptan eventos 'test'. Defensa en
      // profundidad contra secretos de sandbox y producción cruzados.
      expect(provider.parseWebhook(payload)).toBeNull();
    });

    describe('ventana anti-replay', () => {
      it('rechaza un evento viejo aunque su firma sea válida', () => {
        // El sello va DENTRO de la firma, así que no puede moverse sin el
        // secreto — y por eso sirve de límite. Un evento capturado hace
        // semanas deja de ser verificable en vez de depender solo de que la
        // deduplicación siga viva.
        const old = nowSeconds() - 8 * 24 * 60 * 60;
        const payload = JSON.stringify(signedPayload(tx, old));

        expect(provider.verifyWebhookSignature(payload, '')).toBe(false);
      });

      it('rechaza un evento sellado en el futuro, más allá de la tolerancia de reloj', () => {
        const future = nowSeconds() + 60 * 60;
        const payload = JSON.stringify(signedPayload(tx, future));

        expect(provider.verifyWebhookSignature(payload, '')).toBe(false);
      });

      it('tolera un desfase pequeño de reloj en ambos sentidos', () => {
        for (const skew of [-120, 120]) {
          const payload = JSON.stringify(signedPayload(tx, nowSeconds() + skew));
          expect(provider.verifyWebhookSignature(payload, '')).toBe(true);
        }
      });

      it('rechaza un sello ausente o sin sentido', () => {
        for (const stamp of [undefined, null, 0, -1, 'ayer']) {
          const payload = signedPayload(tx) as Record<string, unknown>;
          payload.timestamp = stamp;
          expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
        }
      });
    });

    describe('la lista de propiedades firmadas es del servidor, no del evento', () => {
      /**
       * El agujero que cierra: la firma se calculaba concatenando los
       * campos que el propio evento decía haber firmado. Quien tuviera un
       * solo evento legítimo podía declarar una propiedad inventada, meter
       * en ella la concatenación original, y el mismo checksum volvía a
       * verificar para una transacción con id, estado y monto distintos.
       */
      it('rechaza un evento que declara otras propiedades firmadas', () => {
        const genuine = signedPayload(tx);
        const concatenated = `${tx.id}${tx.status}${tx.amount_in_cents}`;

        const forged = {
          event: 'transaction.updated',
          data: {
            transaction: {
              ...tx,
              id: 'transaccion-inventada',
              status: 'APPROVED',
              amount_in_cents: 1,
              // El valor que reproduce la concatenación original.
              smuggled: concatenated,
            },
          },
          environment: 'test',
          signature: {
            properties: ['transaction.smuggled'],
            checksum: genuine.signature.checksum,
          },
          timestamp: genuine.timestamp,
        };

        expect(provider.verifyWebhookSignature(JSON.stringify(forged), '')).toBe(false);
      });

      it('rechaza una lista con las propiedades correctas en otro orden', () => {
        const payload = signedPayload(tx) as any;
        payload.signature.properties = [
          'transaction.status',
          'transaction.id',
          'transaction.amount_in_cents',
        ];
        expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
      });

      it('rechaza una lista con propiedades de más', () => {
        const payload = signedPayload(tx) as any;
        payload.signature.properties = [...payload.signature.properties, 'transaction.reference'];
        expect(provider.verifyWebhookSignature(JSON.stringify(payload), '')).toBe(false);
      });
    });

    describe('saneado de campos no firmados', () => {
      it('descarta un carril de pago con forma sospechosa', () => {
        // `payment_method_type` no entra en la firma y se escribía tal cual
        // en el registro del pago. Solo se acepta la forma que Wompi usa
        // de verdad (CARD, NEQUI, PSE, BANCOLOMBIA_TRANSFER).
        for (const bogus of ['cash_on_delivery', '$ne', 'a'.repeat(80), '<script>']) {
          const event = provider.parseWebhook(
            signedPayload({ ...tx, payment_method_type: bogus })
          );
          expect(event?.paymentMethodType).toBeUndefined();
        }

        expect(
          provider.parseWebhook(signedPayload({ ...tx, payment_method_type: 'PSE' }))
            ?.paymentMethodType
        ).toBe('PSE');
      });

      it('acota el mensaje de estado en vez de guardarlo entero', () => {
        const event = provider.parseWebhook(
          signedPayload({ ...tx, status: 'DECLINED', status_message: 'x'.repeat(5000) })
        );
        expect(event!.message!.length).toBe(300);
      });

      it('descarta una transacción sin referencia o sin monto utilizable', () => {
        expect(provider.parseWebhook(signedPayload({ ...tx, reference: '   ' }))).toBeNull();
        expect(
          provider.parseWebhook(signedPayload({ ...tx, amount_in_cents: 'mucho' }))
        ).toBeNull();
        expect(
          provider.parseWebhook(signedPayload({ ...tx, amount_in_cents: -100 }))
        ).toBeNull();
      });
    });

    describe('confirmEvent · la verdad la tiene Wompi, no el cuerpo recibido', () => {
      const event = {
        paymentId: 'ZIPP-order-1-REF',
        status: 'approved' as const,
        amount: 25000,
        gatewayTransactionId: '1234-1610641025-49201',
      };

      const wompiSays = (overrides: Record<string, unknown> = {}) =>
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              id: '1234-1610641025-49201',
              reference: 'ZIPP-order-1-REF',
              status: 'APPROVED',
              amount_in_cents: 2500000,
              currency: 'COP',
              ...overrides,
            },
          }),
        });

      it('devuelve la versión de Wompi cuando todo concuerda', async () => {
        vi.stubGlobal('fetch', wompiSays());

        const confirmed = await provider.confirmEvent(event);

        expect(confirmed).toEqual(
          expect.objectContaining({
            paymentId: 'ZIPP-order-1-REF',
            status: 'approved',
            amount: 25000,
            currency: 'COP',
            gatewayTransactionId: '1234-1610641025-49201',
          })
        );
      });

      it('rechaza un evento cuya referencia no es la que Wompi tiene', async () => {
        // El ataque completo: la referencia NO está firmada, así que quien
        // consiga un evento legítimo puede apuntarlo al pedido de otro por
        // el mismo importe. Wompi, preguntado por el id —que sí va
        // firmado—, devuelve la referencia real y el fraude se cae.
        vi.stubGlobal('fetch', wompiSays({ reference: 'ZIPP-VICTIMA-OTRA' }));

        expect(await provider.confirmEvent(event)).toBeNull();
      });

      it('manda el estado real de Wompi aunque el evento diga otro', async () => {
        vi.stubGlobal('fetch', wompiSays({ status: 'DECLINED' }));

        const confirmed = await provider.confirmEvent(event);
        expect(confirmed!.status).toBe('declined');
      });

      it('manda el monto real de Wompi aunque el evento diga otro', async () => {
        vi.stubGlobal('fetch', wompiSays({ amount_in_cents: 100 }));

        const confirmed = await provider.confirmEvent(event);
        expect(confirmed!.amount).toBe(1);
      });

      it('rechaza una transacción que Wompi no conoce', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

        expect(await provider.confirmEvent(event)).toBeNull();
      });

      it('rechaza un evento sin id de transacción: no hay nada que confirmar', async () => {
        expect(await provider.confirmEvent({ ...event, gatewayTransactionId: undefined })).toBeNull();
      });

      it('propaga un fallo de red en vez de darlo por no confirmado', async () => {
        // La diferencia importa: "no confirmado" descarta el evento para
        // siempre, y un hipo de red descartaría un cobro real. Al lanzar,
        // el webhook responde 5xx y Wompi reintenta.
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

        await expect(provider.confirmEvent(event)).rejects.toThrow(/ECONNRESET/);
      });

      it('propaga un 500 de Wompi como reintentable, no como rechazo', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));

        await expect(provider.confirmEvent(event)).rejects.toThrow(/502/);
      });
    });
  });
});
