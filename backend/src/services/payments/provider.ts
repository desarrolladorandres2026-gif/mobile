/**
 * Payment provider contract.
 *
 * Nothing in the platform imports a payment SDK directly. Order flow talks
 * to this interface only, so swapping Wompi / Stripe / Mercado Pago is a
 * matter of adding one file and changing PAYMENT_PROVIDER — no changes to
 * business logic, controllers, or the mobile app.
 */

export type PaymentIntentStatus =
  | 'pending'      // created, awaiting customer action
  | 'processing'   // customer acted, provider is settling
  | 'approved'
  | 'declined'
  | 'refunded'
  | 'cancelled'
  // Gateway-native terminal states some providers (Wompi) report distinctly
  // from 'declined'. They still collapse to PaymentStatus.FAILED for order
  // gating — the raw value survives on Payment.gatewayStatus for audit.
  | 'voided'
  | 'error';

export interface CreatePaymentInput {
  orderId: string;
  userId: string;
  /** Integer amount in the currency's minor-unit-free form (COP has no cents). */
  amount: number;
  currency: string;
  description: string;
  customer: {
    name: string;
    // Both optional: a user who signed up with email OTP has no phone, and
    // one who signed up by phone has no email (see IUser). Wompi treats
    // every customer-data field as optional too, and the provider omits
    // whichever is missing rather than sending the string "undefined".
    phone?: string;
    email?: string;
  };
  /** Where the provider should send the customer back to. */
  redirectUrl?: string;
  /**
   * Merchant-generated unique reference for this attempt, minted once by
   * PaymentService and stable across retries of the same pending payment.
   * Redirect-based providers (Wompi Web Checkout) have nothing else to key
   * on until the gateway assigns its own id, so this is what ties a webhook
   * back to the local Payment row. Optional only so providers that don't
   * need it (sandbox, tests) can omit it — PaymentService always sets it.
   */
  reference?: string;
}

export interface PaymentIntent {
  /** Provider-side identifier. Persisted as Payment.transactionId. */
  id: string;
  status: PaymentIntentStatus;
  amount: number;
  currency: string;
  orderId: string;
  /** Hosted checkout URL, when the provider uses a redirect flow. */
  checkoutUrl?: string;
  /** Human-readable reason when declined. */
  declineReason?: string;
  /** Specific rail used (CARD, NEQUI, PSE, BANCOLOMBIA_TRANSFER…), once known. */
  paymentMethodType?: string;
  /** The gateway's own, un-mapped status string (e.g. Wompi's "APPROVED"),
   *  kept for audit even though only `status` drives platform logic. */
  rawStatus?: string;
  raw?: unknown;
}

export interface WebhookEvent {
  /** Key to resolve the local Payment row — a provider's own id or, for
   *  reference-based providers, the merchant reference. */
  paymentId: string;
  status: PaymentIntentStatus;
  amount?: number;
  /** The provider's own transaction id, when different from `paymentId`. */
  gatewayTransactionId?: string;
  /** Human-readable status detail (decline reason, gateway message). */
  message?: string;
  paymentMethodType?: string;
  /** The gateway's own, un-mapped status string — see PaymentIntent.rawStatus. */
  rawStatus?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: string;

  /** True when this provider needs real credentials that are absent. */
  isConfigured(): boolean;

  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;

  getPayment(paymentId: string): Promise<PaymentIntent>;

  refund(paymentId: string, amount?: number): Promise<PaymentIntent>;

  /**
   * Verifies a webhook's authenticity from the raw request body.
   * Must return false rather than throwing on malformed input.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /** Translates a provider payload into a normalized event. */
  parseWebhook(payload: unknown): WebhookEvent | null;
}
