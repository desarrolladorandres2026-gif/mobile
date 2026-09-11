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
