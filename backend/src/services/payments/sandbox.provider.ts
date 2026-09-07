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
 * A fully functional in-process payment provider for development and tests.
 *
 * It is not a stub: it creates real intents with real identifiers, moves
 * them through real state transitions, signs and verifies its webhooks with
 * HMAC exactly like a hosted provider, and supports refunds. That means the
 * entire payment flow — including the failure and refund paths — is
 * exercisable end-to-end with no external account.
 *
 * Deterministic failure hook: any amount whose last two digits match
 * SANDBOX_FAIL_SUFFIX is declined, so the decline path is testable.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';

  private intents = new Map<string, PaymentIntent>();

  isConfigured(): boolean {
    return true; // never needs credentials
  }

  private secret(): string {
    return config.payments.webhookSecret || config.security.csrfSecret;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    const id = `sbx_${crypto.randomBytes(12).toString('hex')}`;

    const shouldFail =
      config.payments.sandbox.failOnAmountSuffix >= 0 &&
      input.amount % 100 === config.payments.sandbox.failOnAmountSuffix;

    let status: PaymentIntentStatus;
    let declineReason: string | undefined;

    if (shouldFail) {
      status = 'declined';
      declineReason = 'Fondos insuficientes (simulado por el proveedor sandbox)';
    } else if (config.payments.sandbox.autoApprove) {
      status = 'approved';
    } else {
      status = 'pending';
    }

    const intent: PaymentIntent = {
      id,
      status,
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      checkoutUrl: status === 'pending' ? `zipp://sandbox-checkout/${id}` : undefined,
      declineReason,
      raw: { provider: 'sandbox', description: input.description },
    };

    this.intents.set(id, intent);
    return intent;
  }

  async getPayment(paymentId: string): Promise<PaymentIntent> {
    const intent = this.intents.get(paymentId);
    if (!intent) {
      throw new Error(`Pago sandbox no encontrado: ${paymentId}`);
    }
    return intent;
  }

  async refund(paymentId: string, amount?: number): Promise<PaymentIntent> {
    const intent = await this.getPayment(paymentId);

    if (intent.status !== 'approved') {
      throw new Error('Solo se pueden reembolsar pagos aprobados');
    }
    if (amount !== undefined && amount > intent.amount) {
      throw new Error('El reembolso no puede superar el monto del pago');
    }

    const refunded: PaymentIntent = { ...intent, status: 'refunded' };
    this.intents.set(paymentId, refunded);
    return refunded;
  }

  /** Signs a payload the way this provider expects. Used by tests and tooling. */
  sign(rawBody: string): string {
    return crypto.createHmac('sha256', this.secret()).update(rawBody).digest('hex');
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!rawBody || !signature) return false;

    try {
      const expected = this.sign(rawBody);
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(signature, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown): WebhookEvent | null {
    if (!payload || typeof payload !== 'object') return null;

    const body = payload as Record<string, any>;
    const paymentId = body.paymentId ?? body.id;
    const status = body.status;

    const valid: PaymentIntentStatus[] = [
      'pending', 'processing', 'approved', 'declined', 'refunded', 'cancelled',
    ];
    if (typeof paymentId !== 'string' || !valid.includes(status)) return null;

    // Keep local state consistent with what the webhook reports.
    const existing = this.intents.get(paymentId);
    if (existing) this.intents.set(paymentId, { ...existing, status });

    return {
      paymentId,
      status,
      amount: typeof body.amount === 'number' ? body.amount : undefined,
      raw: payload,
    };
  }
}
