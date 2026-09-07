import crypto from 'crypto';
import { config } from '../../config';
import {
  PaymentProvider,
  CreatePaymentInput,
  PaymentIntent,
  PaymentIntentStatus,
  WebhookEvent,
} from './provider';

/**
 * Wompi Colombia — Web Checkout (hosted redirect) provider.
 *
 * Deliberately does NOT integrate card tokenization, PSE bank selection or
 * Nequi phone push directly: the mobile app would then be in PCI scope and
 * would have to reimplement a payment method picker Wompi already built.
 * Instead it builds a signed link to Wompi's own hosted checkout page
 * (https://checkout.wompi.co/p/), which shows every payment method enabled
 * on this merchant account — cards, PSE, Nequi, Bancolombia Transfer —
 * without ZIPP ever touching a card number, CVV or bank credential.
 *
 * Reference: https://docs.wompi.co/docs/colombia/widget-checkout-web/,
 * https://docs.wompi.co/docs/colombia/eventos/,
 * https://docs.wompi.co/docs/colombia/transacciones/
 */

const CHECKOUT_URL = 'https://checkout.wompi.co/p/';

/** Wompi's own transaction states, mapped 1:1 onto PaymentIntentStatus. */
const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  VOIDED: 'voided',
  ERROR: 'error',
};

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

interface WompiTransaction {
  id: string;
  reference: string;
  status: string;
  status_message?: string | null;
  amount_in_cents: number;
  currency: string;
  payment_method_type?: string;
}

export class WompiPaymentProvider implements PaymentProvider {
  readonly name = 'wompi';

  private get publicKey(): string {
    return config.payments.wompi.publicKey;
  }
  private get privateKey(): string {
    return config.payments.wompi.privateKey;
  }
  private get integritySecret(): string {
    return config.payments.wompi.integritySecret;
  }
  private get eventsSecret(): string {
    return config.payments.wompi.eventsSecret;
  }

  /** Sandbox keys (pub_test_/prv_test_) and production keys (pub_prod_/prv_prod_)
   *  point at different API hosts. Deriving the environment from the key
   *  itself — rather than a separate env var — makes it impossible to run
   *  test keys against the production API by a stale flag. */
  private get isProduction(): boolean {
    return this.publicKey.startsWith('pub_prod_');
  }

  private get apiBaseUrl(): string {
    return this.isProduction ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1';
  }

  isConfigured(): boolean {
    return Boolean(this.publicKey && this.privateKey && this.integritySecret && this.eventsSecret);
  }

  /**
   * SHA-256 integrity signature Wompi requires on every Web Checkout link,
   * so a tampered amount or reference is rejected by Wompi itself even
   * though the browser — not our server — is the one submitting the form.
   *
   * Order is exactly as documented:
   *   reference + amountInCents + currency + [expirationTime] + secret
   * The optional expiration goes *before* the secret, not after it — signing
   * without it while sending it in the URL makes Wompi reject the link.
   */
  private integritySignature(
    reference: string,
    amountInCents: number,
    currency: string,
    expirationTime?: string
  ): string {
    const base = `${reference}${amountInCents}${currency}${expirationTime ?? ''}${this.integritySecret}`;
    return crypto.createHash('sha256').update(base).digest('hex');
  }

  /**
   * When this checkout link stops being payable, as an ISO-8601 instant.
   *
   * A link with no expiry stays chargeable forever, so one recovered months
   * later from a log, a shared screenshot or a browser history still opens a
   * valid payment page for an order that has long since been cancelled or
   * re-priced. Bounding it keeps a leaked link from becoming a live charge.
   */
  private expirationTime(): string {
    const minutes = config.payments.wompi.checkoutExpiryMinutes;
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }

  private mapTransaction(tx: WompiTransaction): PaymentIntent {
    const status = STATUS_MAP[tx.status];
    return {
      id: tx.id,
      status: status ?? 'error',
      amount: Math.round(tx.amount_in_cents / 100),
      currency: tx.currency,
      // Wompi has no notion of our internal order id — only PaymentService,
      // which already knows it, consumes this field on the create path.
      // getPayment()/refund() callers key off `payment.orderId` on the
      // local Payment row instead.
      orderId: '',
      declineReason: tx.status_message ?? undefined,
      paymentMethodType: tx.payment_method_type,
      rawStatus: tx.status,
      raw: tx,
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    if (!input.reference) {
      throw new Error('WompiPaymentProvider requiere una referencia única por intento de pago');
    }

    const amountInCents = Math.round(input.amount * 100);
    const expirationTime = this.expirationTime();
    const signature = this.integritySignature(
      input.reference,
      amountInCents,
      input.currency,
      expirationTime
    );

    const params = new URLSearchParams({
      'public-key': this.publicKey,
      currency: input.currency,
      'amount-in-cents': String(amountInCents),
      reference: input.reference,
      'signature:integrity': signature,
      'expiration-time': expirationTime,
    });

    if (input.redirectUrl) params.set('redirect-url', input.redirectUrl);
    if (input.customer.email) params.set('customer-data:email', input.customer.email);
    if (input.customer.name) params.set('customer-data:full-name', input.customer.name);
    if (input.customer.phone) params.set('customer-data:phone-number', input.customer.phone);

    // Nothing here calls Wompi: the Web Checkout link is a pure function of
    // its signed parameters, so building it never touches the network and a
    // retried, still-pending payment can simply be rebuilt. The rebuilt link
    // carries a fresh expiry (and so a fresh signature) for the same
    // reference and amount — which is exactly what a retry should get.
    return {
      id: input.reference,
      status: 'pending',
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      checkoutUrl: `${CHECKOUT_URL}?${params.toString()}`,
    };
  }

  /**
   * Reads a transaction back from Wompi.
   *
   * Authorised with the *public* key, which is what Wompi documents for this
   * endpoint. The private key would also be accepted, but sending it on a
   * read-only call puts the one credential that can move money on the wire
   * on every status poll, for no added capability. It leaves the process
   * only for `refund()`, which genuinely needs it.
   */
  async getPayment(paymentId: string): Promise<PaymentIntent> {
    const res = await fetch(`${this.apiBaseUrl}/transactions/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${this.publicKey}` },
    });

    if (!res.ok) {
      throw new Error(`Wompi respondió ${res.status} al consultar la transacción ${paymentId}`);
    }

    const body = (await res.json()) as { data?: WompiTransaction };
    if (!body?.data) {
      throw new Error(`Respuesta de Wompi sin datos de transacción para ${paymentId}`);
    }

    return this.mapTransaction(body.data);
  }

  /**
   * Wompi only exposes a "void" of an unsettled transaction via API — it
   * cancels the authorization before it captures, and only works for cards
   * within a short window. It is not a general-purpose partial refund: PSE,
   * Nequi and already-settled cards have to be reversed from the Wompi
   * merchant dashboard, outside this API. Callers get a clear error instead
   * of a silently-ignored partial amount.
   */
  async refund(paymentId: string, amount?: number): Promise<PaymentIntent> {
    const current = await this.getPayment(paymentId);

    if (amount !== undefined && amount < current.amount) {
      throw new Error(
        'Wompi no admite reembolsos parciales por API. Para un reembolso parcial, ' +
          'procésalo manualmente desde el dashboard de Wompi y regístralo como contracargo en ZIPP.'
      );
    }

    const res = await fetch(`${this.apiBaseUrl}/transactions/${encodeURIComponent(paymentId)}/void`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.privateKey}` },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Wompi rechazó la anulación de ${paymentId} (HTTP ${res.status}). Es posible que la ` +
          `transacción ya esté liquidada — anúlala manualmente desde el dashboard de Wompi. ${detail}`.trim()
      );
    }

    const body = (await res.json()) as { data?: WompiTransaction };
    if (!body?.data) {
      throw new Error(`Respuesta de Wompi sin datos al anular ${paymentId}`);
    }

    return this.mapTransaction(body.data);
  }

  /**
   * Wompi signs events inside the JSON body itself (`signature.checksum`),
   * not in an HTTP header, so the header `signature` argument here is
   * unused for this provider — everything needed is in `rawBody`.
   */
  verifyWebhookSignature(rawBody: string, _signature: string): boolean {
    if (!rawBody) return false;

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return false;
    }

    const sig = payload?.signature;
    if (!sig || !Array.isArray(sig.properties) || typeof sig.checksum !== 'string') return false;
    if (typeof payload.timestamp !== 'number' && typeof payload.timestamp !== 'string') return false;
    if (!this.eventsSecret) return false;

    const values = sig.properties.map((path: string) => {
      const value = getByPath(payload.data, path);
      return value === undefined || value === null ? '' : String(value);
    });

    const base = values.join('') + String(payload.timestamp) + this.eventsSecret;
    const expected = crypto.createHash('sha256').update(base).digest('hex');

    try {
      const a = Buffer.from(expected.toLowerCase(), 'utf8');
      const b = Buffer.from(String(sig.checksum).toLowerCase(), 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown): WebhookEvent | null {
    if (!payload || typeof payload !== 'object') return null;

    const body = payload as Record<string, any>;

    // Wompi publishes more than one event type on the same endpoint
    // (`nequi_token.updated`, and whatever it adds next). Only transaction
    // updates may move money here; anything else is acknowledged upstream as
    // "unrecognised" rather than pattern-matched on its shape.
    if (body.event !== 'transaction.updated') return null;

    // Defence in depth against crossed credentials: a test event can only
    // carry a valid checksum if the test events secret is configured, and if
    // that ever happens on a production deployment the safe move is to
    // ignore it rather than settle a real order from a sandbox transaction.
    const expectedEnvironment = this.isProduction ? 'prod' : 'test';
    if (typeof body.environment === 'string' && body.environment !== expectedEnvironment) {
      return null;
    }

    const tx = body?.data?.transaction as WompiTransaction | undefined;
    if (!tx || typeof tx.id !== 'string' || typeof tx.reference !== 'string') return null;

    const status = STATUS_MAP[tx.status];
    if (!status) return null;

    return {
      // The merchant reference is the only thing known about this payment
      // from the moment it was created — see Payment.reference — so it is
      // what resolves the local row, not Wompi's own id.
      paymentId: tx.reference,
      status,
      amount: typeof tx.amount_in_cents === 'number' ? Math.round(tx.amount_in_cents / 100) : undefined,
      gatewayTransactionId: tx.id,
      message: tx.status_message ?? undefined,
      paymentMethodType: tx.payment_method_type,
      rawStatus: tx.status,
      raw: payload,
    };
  }
}
