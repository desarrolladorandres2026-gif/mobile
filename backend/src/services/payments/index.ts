import crypto from 'crypto';
import { config } from '../../config';
import {
  Payment,
  IPayment,
  Order,
  IOrder,
  ProcessedWebhook,
  canTransitionPayment,
} from '../../models';
import { AppError } from '../../middlewares';
import { PaymentType, PaymentStatus, PaymentMethod, OrderStatus, OrderKind } from '../../types';
import { AuditAction, AuditSeverity, logSystemAudit } from '../../security';
import { emitToUser } from '../../sockets/emitter';
import {
  PaymentProvider,
  PaymentIntent,
  PaymentIntentStatus,
  CheckoutConfig,
  PaymentInstrument,
  PseFinancialInstitution,
} from './provider';
import { SandboxPaymentProvider } from './sandbox.provider';
import {
  CardDisplay,
  saveCardFromToken,
  resolveSavedCard,
  touchSavedCard,
  listSavedCards,
  deleteSavedCard,
} from './savedCards';
import { WompiPaymentProvider } from './wompi.provider';

export * from './provider';
export { SandboxPaymentProvider, WompiPaymentProvider };

// ── Provider registry ────────────────────────────────────────────────
// To add a real provider: implement PaymentProvider, register it here,
// and set PAYMENT_PROVIDER in .env. Nothing else changes.
const registry: Record<string, () => PaymentProvider> = {
  sandbox: () => new SandboxPaymentProvider(),
  wompi: () => new WompiPaymentProvider(),
};

let activeProvider: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (activeProvider) return activeProvider;

  const name = config.payments.provider;
  const factory = registry[name];

  if (!factory) {
    const available = Object.keys(registry).join(', ');
    throw new Error(
      `PAYMENT_PROVIDER="${name}" no está registrado. Disponibles: ${available}. ` +
        `Implementa la interfaz PaymentProvider en src/services/payments/ y regístralo.`
    );
  }

  activeProvider = factory();

  if (!activeProvider.isConfigured()) {
    throw new Error(
      `El proveedor de pagos "${name}" no tiene credenciales configuradas.`
    );
  }

  return activeProvider;
}

/**
 * Whether online payment can be offered at all.
 *
 * The checkout asks this before showing the option. A misconfigured
 * gateway must disable online payment, never fall through to "assume it
 * worked" — that was the old behaviour and it made every online order free.
 */
export function isOnlinePaymentAvailable(): boolean {
  try {
    const provider = getPaymentProvider();
    return provider.isConfigured();
  } catch {
    return false;
  }
}

/**
 * Qué puede cobrarse sin salir de la app con el proveedor activo.
 *
 * La app lo pregunta junto con los métodos para decidir qué pinta: con
 * `native` en falso cae al camino de redirección de siempre, que es lo que
 * pasa con el sandbox de desarrollo y con cualquier proveedor futuro que
 * solo sepa redirigir.
 */
export function nativeCapabilities(): { native: boolean; pse: boolean; savedCards: boolean } {
  try {
    const provider = getPaymentProvider();
    const native = Boolean(provider.createNativePayment && provider.getCheckoutConfig);
    return {
      native,
      pse: native && Boolean(provider.listPseBanks),
      savedCards: native && Boolean(provider.createPaymentSource),
    };
  } catch {
    return { native: false, pse: false, savedCards: false };
  }
}

/** Test/bootstrap seam so a provider can be swapped at runtime. */
export function setPaymentProvider(provider: PaymentProvider | null): void {
  activeProvider = provider;
}

/** Maps a provider status onto the platform's PaymentStatus. */
export function toPaymentStatus(status: PaymentIntentStatus): PaymentStatus {
  switch (status) {
    case 'approved':
      return PaymentStatus.PAID;
    case 'refunded':
      return PaymentStatus.REFUNDED;
    case 'declined':
    case 'cancelled':
    // Wompi-native terminal failures. Distinct at the gateway, but the
    // order gate only needs to know "did not pay" — the raw value is kept
    // on Payment.gatewayStatus for anyone who needs the distinction.
    case 'voided':
    case 'error':
      return PaymentStatus.FAILED;
    default:
      return PaymentStatus.PENDING;
  }
}

/**
 * El vocabulario que ve la app: el de `GET /payments/status`, no el de la
 * plataforma. Un solo sitio, para que el socket y el polling no puedan
 * contar el mismo pago de dos formas distintas.
 */
export function toClientStatus(status: PaymentStatus): 'approved' | 'declined' | 'refunded' | 'pending' {
  switch (status) {
    case PaymentStatus.PAID:
      return 'approved';
    case PaymentStatus.FAILED:
      return 'declined';
    case PaymentStatus.REFUNDED:
      return 'refunded';
    default:
      return 'pending';
  }
}

/**
 * Unique per-attempt reference, minted once and reused across retries of
 * the same pending payment. It is what a redirect-based gateway (Wompi Web
 * Checkout) signs and echoes back in its webhook, since it has no id of its
 * own to hand out until the customer actually completes the checkout.
 */
function generatePaymentReference(orderId: string): string {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `ZIPP-${orderId}-${Date.now().toString(36)}-${suffix}`.toUpperCase();
}

/**
 * Referencia de un cobro en efectivo. **Determinista**, al revés que la de
 * un pago en línea.
 *
 * Un pago en línea puede reintentarse muchas veces y cada intento necesita
 * su propia referencia; en efectivo solo hay un cobro posible, el de la
 * puerta. Derivarla del pedido hace que el índice único de `reference`
 * sea, él mismo, la garantía de que no existan dos cobros en efectivo para
 * el mismo pedido — sin depender de que nadie se acuerde de comprobarlo.
 */
function cashPaymentReference(orderId: string): string {
  return `ZIPP-CASH-${orderId}`.toUpperCase();
}

interface InitiateInput {
  orderId: string;
  userId: string;
  /**
   * Solo como contraste. El cobro sale siempre del total que el servidor
   * calculó para el pedido; si esto no coincide, se rechaza en vez de
   * hacerle caso.
   */
  amount: number;
  description: string;
  customer: { name: string; phone?: string; email?: string };
  redirectUrl?: string;
  // No hay `idempotencyKey`: lo había declarado y nadie lo leía nunca, así
  // que prometía una garantía inexistente. La idempotencia de verdad no
  // depende de que el cliente mande una clave — depende del pedido: un
  // pedido tiene como mucho un intento en línea abierto, y eso lo sostiene
  // el índice único parcial de `Payment`, no la buena voluntad de quien
  // llama.
}

/**
 * El instrumento tal como lo manda la app.
 *
 * Difiere del `PaymentInstrument` del proveedor en un punto deliberado: una
 * tarjeta guardada llega como `saved_card` con **nuestro** id, nunca con el
 * `payment_source_id` de la pasarela. Ese número es un entero adivinable, y
 * aceptarlo de la app permitiría cobrarle a la tarjeta de otra persona.
 * `PaymentService` lo traduce tras comprobar el dueño.
 */
export type ClientInstrument =
  | {
      kind: 'card_token';
      token: string;
      installments: number;
      /** Guardarla para la próxima vez. Exige `card` y el consentimiento de datos. */
      save?: boolean;
      card?: CardDisplay;
    }
  | { kind: 'saved_card'; savedCardId: string; installments?: number }
  | Extract<PaymentInstrument, { kind: 'nequi' }>
  | Extract<PaymentInstrument, { kind: 'pse' }>;

interface InitiateNativeInput extends InitiateInput {
  /** Con qué se cobra. Nunca contiene número de tarjeta: ya está tokenizada. */
  instrument: ClientInstrument;
  /** El consentimiento que el cliente tuvo delante, tal cual. */
  acceptanceToken: string;
  /** Solo si va a guardarse la tarjeta. */
  personalDataAuthToken?: string;
  browserInfo?: Record<string, string | number>;
}

interface GatewayStatusMeta {
  /** The gateway's own transaction id, when it differs from the lookup key. */
  gatewayTransactionId?: string;
  /** Currency the gateway settled in. Refused when it is not the row's. */
  currency?: string;
  message?: string;
  paymentMethodType?: string;
  /** The gateway's own, un-mapped status string (Wompi's PENDING/APPROVED/
   *  DECLINED/VOIDED/ERROR). Falls back to the mapped status for providers
   *  without a distinct vocabulary of their own (sandbox). */
  rawStatus?: string;
  source?: 'create' | 'webhook' | 'sync';
}

export class PaymentService {
  /**
   * Lo que la app necesita para cobrar sin salir de sí misma.
   *
   * Un proveedor que solo sabe redirigir no implementa esto, y entonces la
   * respuesta honesta es "aquí no se puede" y no un objeto vacío que la app
   * interpretaría como permiso para pedir una tarjeta que nadie va a poder
   * cobrar. El checkout usa esa distinción para ofrecer el camino viejo.
   */
  async getCheckoutConfig(): Promise<CheckoutConfig> {
    const provider = getPaymentProvider();

    if (!provider.getCheckoutConfig) {
      throw new AppError(
        `El proveedor de pagos "${provider.name}" no admite cobro dentro de la aplicación`,
        501
      );
    }

    return provider.getCheckoutConfig();
  }

  /**
   * Starts a digital payment for an order and records it locally.
   *
   * The local Payment row is written before returning so a provider
   * callback always has something to reconcile against, even if the
   * client disconnects mid-checkout.
   *
   * Capture is *not* decided here. Whatever the provider reports is routed
   * through `applyGatewayStatus`, the single place allowed to mark an order
   * paid — so a synchronous approval and an asynchronous webhook take the
   * exact same code path and the same idempotency guarantees.
   */
  async initiate(input: InitiateInput): Promise<{ intent: PaymentIntent; paymentId: string }> {
    return this.initiateAttempt(input, 0);
  }

  private async initiateAttempt(
    input: InitiateInput,
    attempt: number
  ): Promise<{ intent: PaymentIntent; paymentId: string }> {
    const provider = getPaymentProvider();

    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    if (order.paymentMethod !== PaymentMethod.ONLINE) {
      throw new AppError('Este pedido no es de pago en línea', 400);
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new AppError('Este pedido ya fue pagado', 409);
    }
    // A cancelled order has already unwound its finances (see
    // OrderService.onCancelled) — collecting for it would leave money with
    // no obligation behind it.
    if (order.status === OrderStatus.CANCELLED) {
      throw new AppError('Este pedido fue cancelado y no admite pago', 409);
    }

    // Charge exactly what the server computed, never a client-supplied
    // number: `input.amount` is only a cross-check.
    const amount = order.finance?.customerTotal ?? order.total;
    if (input.amount && input.amount !== amount) {
      throw new AppError('El monto no coincide con el total del pedido', 409);
    }

    // A retried checkout must not create a second charge. The open attempt,
    // if any: a cash row is never one (it has its own path), and a PAID row
    // is not "open" either — but it has to be looked at, see below.
    const existing = await Payment.findOne({
      orderId: input.orderId,
      type: PaymentType.ORDER_PAYMENT,
      method: { $ne: PaymentMethod.CASH_ON_DELIVERY },
      status: { $in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
    }).sort({ createdAt: -1 });

    // The order-level guard above already refused a paid order. A PAID row
    // under an order that still says otherwise is the one case
    // applyGatewayStatus deliberately leaves open — a capture whose amount
    // did not match, or a second capture for the same order — and it needs
    // a person, not another checkout link.
    if (existing?.status === PaymentStatus.PAID) {
      throw new AppError(
        'Este pedido ya tiene un cobro aprobado pendiente de revisión. Contacta a soporte.',
        409,
        'PAYMENT_UNDER_REVIEW'
      );
    }

    // Reusing a pending attempt is only safe while it is for the same money.
    // If the order's total moved since, the old reference is bound — through
    // Wompi's integrity signature — to an amount we would no longer accept.
    const amountUnchanged = !existing || existing.amount === amount;

    if (existing && amountUnchanged) {
      if (existing.transactionId) {
        try {
          const intent = await provider.getPayment(existing.transactionId);
          return { intent, paymentId: existing._id.toString() };
        } catch {
          // The gateway has no record yet — e.g. a Wompi Web Checkout the
          // customer never opened or completed. Fall through and rebuild the
          // same intent instead of failing the retry.
        }
      }

      const reference = existing.reference || generatePaymentReference(input.orderId);
      const intent = await this.createIntent(provider, input, amount, reference);

      existing.reference = reference;
      existing.transactionId = intent.id;
      await existing.save();

      await this.applyIfTerminal(intent);
      return { intent, paymentId: existing._id.toString() };
    }

    // ── A new attempt: first order, or the total changed ──
    //
    // A re-priced attempt gets a brand-new row, and the old one is retired
    // in place rather than overwritten. The old checkout link is still
    // payable until it expires, and its webhook resolves the row by
    // reference: overwriting that reference made a late payment on the old
    // link land on no row at all — money captured by Wompi, nothing to show
    // for it locally. Retired, the old row is found, and applyGatewayStatus
    // sees an amount that no longer matches the order and flags it for a
    // person instead of settling the order with the wrong money.
    if (existing) {
      await this.retireAttempt(
        existing,
        `Total del pedido actualizado: ${existing.amount} → ${amount}`,
        { supersededAmount: existing.amount, supersededAt: new Date().toISOString() }
      );
    }

    const reference = generatePaymentReference(input.orderId);
    const intent = await this.createIntent(provider, input, amount, reference);

    const payment = new Payment({
      orderId: input.orderId,
      userId: input.userId,
      type: PaymentType.ORDER_PAYMENT,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PENDING,
      amount,
      currency: config.payments.currency,
      reference,
      transactionId: intent.id,
      metadata: existing
        ? { supersedesReference: existing.reference, supersededAmount: existing.amount }
        : {},
    });
    payment.statusHistory.push({
      status: PaymentStatus.PENDING,
      gatewayStatus: intent.status,
      source: 'create',
      at: new Date(),
    });

    try {
      await payment.save();
    } catch (error: any) {
      // Another initiate for the same order won the race and holds the one
      // open attempt this order may have (see the partial unique index on
      // Payment). Start over: the second pass finds that attempt and reuses
      // it, which is exactly what the loser should have received.
      if (error?.code === 11000 && attempt < 1) {
        return this.initiateAttempt(input, attempt + 1);
      }
      throw error;
    }

    if (existing) {
      await Payment.updateOne(
        { _id: existing._id },
        { $set: { 'metadata.supersededBy': reference } }
      );
    }

    await this.applyIfTerminal(intent);
    return { intent, paymentId: payment._id.toString() };
  }

  /**
   * Cobra dentro de la aplicación, con un instrumento que el cliente ya
   * capturó (tarjeta tokenizada, Nequi, PSE o una tarjeta guardada).
   *
   * Tres cosas lo separan de `initiate`, y ninguna es cosmética:
   *
   * 1. **La fila se guarda antes de cobrar.** En el camino de redirección
   *    `createPayment` no toca la red, así que daba igual el orden. Aquí sí
   *    se mueve dinero: si el proceso muriera entre el cobro y el `save()`,
   *    habría plata en Wompi sin nada que la reclame. Guardando primero, el
   *    webhook siempre encuentra una fila por su referencia.
   * 2. **Un intento abierto no se reutiliza.** Un enlace de Web Checkout se
   *    puede reabrir; una transacción no: cobrar otra vez sería un segundo
   *    cargo. Si el anterior sigue vivo en la pasarela se rechaza el intento
   *    y la app espera en la pantalla que ya tiene.
   * 3. **Un fallo de la pasarela cierra la fila.** Si no, quedaría PENDING
   *    para siempre ocupando el único hueco que el índice parcial
   *    `one_open_online_payment_per_order` concede por pedido, y el cliente
   *    no podría reintentar nunca.
   */
  async initiateNative(
    input: InitiateNativeInput
  ): Promise<{ intent: PaymentIntent; paymentId: string; reference: string }> {
    const provider = getPaymentProvider();

    if (!provider.createNativePayment) {
      throw new AppError(
        `El proveedor de pagos "${provider.name}" no admite cobro dentro de la aplicación`,
        501
      );
    }

    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    if (order.paymentMethod !== PaymentMethod.ONLINE) {
      throw new AppError('Este pedido no es de pago en línea', 400);
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new AppError('Este pedido ya fue pagado', 409);
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new AppError('Este pedido fue cancelado y no admite pago', 409);
    }

    // El importe lo pone el servidor. `input.amount` solo sirve de contraste.
    const amount = order.finance?.customerTotal ?? order.total;
    if (input.amount && input.amount !== amount) {
      throw new AppError('El monto no coincide con el total del pedido', 409);
    }

    await this.clearOpenAttempt(input.orderId);

    // Después de todas las guardas y antes de la fila: guardar una tarjeta
    // es un efecto en la pasarela, y no debe ocurrir para un cobro que de
    // todos modos se iba a rechazar.
    const { instrument, savedCardId } = await this.resolveInstrument(provider, input);

    const reference = generatePaymentReference(input.orderId);

    const payment = new Payment({
      orderId: input.orderId,
      userId: input.userId,
      type: PaymentType.ORDER_PAYMENT,
      // Siempre `online`: el carril concreto (CARD, NEQUI, PSE) vive en
      // `paymentMethodType`. Escribirlo aquí borraría la distinción de la
      // que dependen la invalidación de intentos y la guarda de efectivo.
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PENDING,
      amount,
      currency: config.payments.currency,
      reference,
      // Provisional, como en el camino de redirección: asciende al id real
      // de Wompi en cuanto la transacción existe.
      transactionId: reference,
      metadata: { instrumentKind: input.instrument.kind },
    });
    payment.statusHistory.push({
      status: PaymentStatus.PENDING,
      source: 'create',
      at: new Date(),
    });

    try {
      await payment.save();
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new AppError(
          'Ya hay un cobro en curso para este pedido. Espera a que termine.',
          409,
          'PAYMENT_IN_PROGRESS'
        );
      }
      throw error;
    }

    let intent: PaymentIntent;
    try {
      intent = await provider.createNativePayment({
        orderId: input.orderId,
        userId: input.userId,
        amount,
        currency: config.payments.currency,
        description: input.description,
        customer: input.customer,
        redirectUrl: input.redirectUrl,
        reference,
        instrument,
        acceptanceToken: input.acceptanceToken,
        personalDataAuthToken: input.personalDataAuthToken,
        browserInfo: input.browserInfo,
      });
    } catch (error) {
      const reason = ((error as Error).message || 'La pasarela rechazó el cobro').slice(0, 300);
      // Se cierra la fila para liberar el hueco del índice; si no, el cliente
      // quedaría bloqueado sin poder reintentar nunca.
      await this.retireAttempt(payment, reason);
      throw new AppError(reason, 502, 'GATEWAY_REJECTED');
    }

    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          transactionId: intent.id,
          ...(intent.paymentMethodType ? { paymentMethodType: intent.paymentMethodType } : {}),
          ...(intent.rawStatus ? { gatewayStatus: intent.rawStatus } : {}),
        },
      }
    );

    if (savedCardId) await touchSavedCard(savedCardId);

    await this.applyIfTerminal(intent);
    return { intent, paymentId: payment._id.toString(), reference };
  }

  /**
   * Del instrumento de la app al de la pasarela.
   *
   * "Pagar y guardar" crea primero la fuente de pago y cobra contra ella:
   * Wompi consume el token al crear la fuente, así que no se puede usar
   * además para la transacción.
   */
  private async resolveInstrument(
    provider: PaymentProvider,
    input: InitiateNativeInput
  ): Promise<{ instrument: PaymentInstrument; savedCardId?: string }> {
    const client = input.instrument;

    switch (client.kind) {
      case 'card_token': {
        if (!client.save) {
          return {
            instrument: { kind: 'card_token', token: client.token, installments: client.installments },
          };
        }
        if (!client.card) {
          throw new AppError('Faltan los datos de la tarjeta para guardarla', 400);
        }
        if (!input.customer.email) {
          throw new AppError('Necesitamos un correo para guardar la tarjeta', 422, 'EMAIL_REQUIRED');
        }
        const card = await saveCardFromToken(provider, {
          userId: input.userId,
          token: client.token,
          display: client.card,
          customerEmail: input.customer.email,
          acceptanceToken: input.acceptanceToken,
          personalDataAuthToken: input.personalDataAuthToken,
        });
        return {
          instrument: {
            kind: 'saved_source',
            paymentSourceId: card.gatewaySourceId,
            installments: client.installments,
          },
          savedCardId: card._id.toString(),
        };
      }

      case 'saved_card': {
        const card = await resolveSavedCard(provider, input.userId, client.savedCardId);
        return {
          instrument: {
            kind: 'saved_source',
            paymentSourceId: card.gatewaySourceId,
            installments: client.installments ?? 1,
          },
          savedCardId: card._id.toString(),
        };
      }

      case 'nequi':
      case 'pse':
        return { instrument: client };
    }
  }

  // ── Tarjetas guardadas ──

  listCards(userId: string) {
    return listSavedCards(userId);
  }

  /** Guarda una tarjeta sin cobrar nada (desde el perfil, p. ej.). */
  async saveCard(input: {
    userId: string;
    token: string;
    display: CardDisplay;
    customerEmail: string;
    acceptanceToken: string;
    personalDataAuthToken?: string;
  }) {
    return saveCardFromToken(getPaymentProvider(), input);
  }

  deleteCard(userId: string, cardId: string) {
    return deleteSavedCard(userId, cardId);
  }

  /**
   * Deja libre el único hueco de intento abierto que el pedido admite.
   *
   * Antes de retirar nada se le pregunta a la pasarela: una fila local que
   * dice PENDING puede ser una transacción que Wompi ya resolvió y cuyo
   * webhook aún no ha llegado. Retirarla a ciegas convertiría un cobro
   * aprobado en un intento fallido y abriría la puerta a un segundo cargo.
   */
  private async clearOpenAttempt(orderId: string): Promise<void> {
    const existing = await Payment.findOne({
      orderId,
      type: PaymentType.ORDER_PAYMENT,
      method: { $ne: PaymentMethod.CASH_ON_DELIVERY },
      status: { $in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
    }).sort({ createdAt: -1 });

    if (!existing) return;

    if (existing.status === PaymentStatus.PAID) {
      throw new AppError(
        'Este pedido ya tiene un cobro aprobado pendiente de revisión. Contacta a soporte.',
        409,
        'PAYMENT_UNDER_REVIEW'
      );
    }

    // ¿Sigue vivo de verdad? Solo tiene sentido preguntar cuando la pasarela
    // ya le asignó un identificador propio; mientras siga siendo la
    // referencia, la transacción no llegó a existir allí.
    const hasGatewayRecord = Boolean(
      existing.transactionId && existing.transactionId !== existing.reference
    );

    if (!hasGatewayRecord) {
      // Nunca llegó a la pasarela: retirarla no puede perder dinero.
      await this.retireAttempt(
        existing,
        'Intento anterior que no llegó a la pasarela; sustituido por uno nuevo',
        { supersededAmount: existing.amount, supersededAt: new Date().toISOString() }
      );
      return;
    }

    let asked = false;
    try {
      await this.sync(existing.transactionId!);
      asked = true;
    } catch {
      // No se pudo preguntar. Se decide con lo que diga la fila local, que
      // es lo único disponible.
    }

    const refreshed = await Payment.findById(existing._id);

    if (refreshed?.status === PaymentStatus.PAID) {
      throw new AppError('Este pedido ya fue pagado.', 409, 'PAYMENT_ALREADY_PAID');
    }

    if (refreshed?.status === PaymentStatus.PENDING) {
      throw new AppError(
        asked
          ? 'Ya hay un cobro en curso para este pedido. Termínalo o espera a que caduque.'
          : 'No pudimos verificar el cobro anterior. Espera un momento y vuelve a intentarlo.',
        409,
        'PAYMENT_IN_PROGRESS'
      );
    }
    // Terminal (FAILED): el hueco del índice quedó libre por sí solo.
  }

  /** Bancos disponibles para PSE. */
  async listPseBanks(): Promise<PseFinancialInstitution[]> {
    const provider = getPaymentProvider();

    if (!provider.listPseBanks) {
      throw new AppError(`El proveedor de pagos "${provider.name}" no admite PSE`, 501);
    }

    return provider.listPseBanks();
  }

  private createIntent(
    provider: PaymentProvider,
    input: InitiateInput,
    amount: number,
    reference: string
  ): Promise<PaymentIntent> {
    return provider.createPayment({
      orderId: input.orderId,
      userId: input.userId,
      amount,
      currency: config.payments.currency,
      description: input.description,
      customer: input.customer,
      redirectUrl: input.redirectUrl,
      reference,
    });
  }

  /**
   * Synchronous providers can already be terminal. Route it through the
   * same authority the webhook uses rather than special-casing it.
   */
  private async applyIfTerminal(intent: PaymentIntent): Promise<void> {
    if (intent.status === 'approved' || intent.status === 'declined') {
      await this.applyGatewayStatus(intent.id, intent.status, intent.amount, {
        currency: intent.currency,
        source: 'create',
      });
    }
  }

  /**
   * Closes a pending attempt without deleting it. The row stays resolvable
   * by reference, which is what lets a late gateway event about it be
   * recognised — and judged — instead of vanishing.
   */
  private async retireAttempt(
    payment: IPayment,
    reason: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const now = new Date();
    await Payment.updateOne(
      { _id: payment._id, status: PaymentStatus.PENDING },
      {
        $set: {
          status: PaymentStatus.FAILED,
          statusMessage: reason,
          metadata: { ...(payment.metadata ?? {}), voidedReason: reason, voidedAt: now.toISOString(), ...metadata },
        },
        $push: {
          statusHistory: { status: PaymentStatus.FAILED, source: 'admin', message: reason, at: now },
        },
      }
    );
  }

  /**
   * The single authority that moves an order's payment state.
   *
   * Called only with something the gateway told us — a verified webhook or
   * a provider response — never from the delivery flow. Idempotent: a
   * second "approved" for the same transaction is a no-op, which is what
   * makes duplicate webhook delivery harmless.
   */
  async applyGatewayStatus(
    key: string,
    status: PaymentIntentStatus,
    amount?: number,
    meta?: GatewayStatusMeta
  ): Promise<{ order: IOrder | null; changed: boolean }> {
    // `key` is whatever the caller has on hand: our own reference (always
    // known) or the gateway's own id (known only once a webhook or sync has
    // reported it). Both resolve to the same row.
    const payment = await Payment.findOne({ $or: [{ transactionId: key }, { reference: key }] });
    if (!payment) return { order: null, changed: false };

    // Una pasarela no tiene nada que decir sobre un cobro en efectivo. No
    // debería poder llegar aquí —los cobros en efectivo no tienen id de
    // pasarela y la firma del webhook ya filtra lo demás—, pero si llegara,
    // marcaría como cobrado un dinero que nadie ha recogido todavía.
    if (payment.method === PaymentMethod.CASH_ON_DELIVERY) {
      console.error('[PAYMENTS] Un evento de pasarela apuntó a un cobro en efectivo', {
        key,
        paymentId: payment._id.toString(),
      });
      const order = await Order.findById(payment.orderId);
      return { order, changed: false };
    }

    const nextStatus = toPaymentStatus(status);

    if (payment.status === nextStatus) {
      const order = await Order.findById(payment.orderId);
      return { order, changed: false };
    }

    // Nunca se retrocede desde un estado terminal. La tabla de transiciones
    // es la que manda, y un salto ilegal se ignora en vez de lanzar: el
    // contrato del webhook es responder 200 a lo que ya está resuelto, y un
    // 5xx aquí haría que la pasarela reintentara para siempre un evento
    // que jamás va a aplicarse.
    if (!canTransitionPayment(payment.status, nextStatus)) {
      console.warn('[PAYMENTS] Transición de pago ignorada', {
        key,
        from: payment.status,
        to: nextStatus,
      });
      const order = await Order.findById(payment.orderId);
      return { order, changed: false };
    }

    if (amount !== undefined && amount !== payment.amount) {
      console.error('[PAYMENTS] Monto del webhook distinto al registrado', {
        key,
        expected: payment.amount,
        received: amount,
      });
      throw new AppError('El monto notificado no coincide con el pago registrado', 409);
    }

    // La moneda es parte del importe, no un adorno. Sin esta comprobación,
    // un evento que declarara 50.000 de otra divisa liquidaría un pedido de
    // 50.000 COP: mismo número, otro dinero. Wompi solo opera en COP, así
    // que esto no puede saltar por un caso legítimo — y por eso mismo, si
    // salta, no se aplica nada.
    if (meta?.currency && meta.currency !== payment.currency) {
      console.error('[PAYMENTS] Moneda del webhook distinta a la registrada', {
        key,
        expected: payment.currency,
        received: meta.currency,
      });
      throw new AppError('La moneda notificada no coincide con el pago registrado', 409);
    }

    const gatewayStatus = meta?.rawStatus ?? status;
    const now = new Date();

    // ── Reclamo atómico de la transición ──
    //
    // El estado de partida viaja DENTRO de la condición de la escritura, el
    // mismo patrón que ya protege el reclamo de un pedido y la reserva del
    // fondo del domiciliario. Leer, validar y guardar son tres pasos, y
    // entre ellos caben perfectamente el webhook de Wompi y el `sync()` que
    // dispara la propia app —que consulta el estado cada 3 segundos mientras
    // el pago está pendiente—. Los dos leían PENDING, los dos pasaban la
    // tabla de transiciones y los dos ejecutaban los efectos del cobro:
    // asiento contable, liberación de liquidaciones y arranque del reparto,
    // por duplicado. Solo una de las dos escrituras encuentra ahora el
    // estado previo, y la otra sale como "sin cambios", que es exactamente
    // lo que es.
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: payment.status },
      {
        $set: {
          status: nextStatus,
          gatewayStatus,
          ...(meta?.message ? { statusMessage: meta.message } : {}),
          // El carril que usó el cliente (CARD, NEQUI, PSE…) es un dato de
          // la pasarela y vive en su propio campo. Escribirlo sobre
          // `method` borraba el único sitio donde consta si el cobro es en
          // línea o en efectivo — justo la distinción de la que dependen
          // `voidOpenPayments`, la búsqueda de intentos abiertos y la
          // guarda de más arriba contra cobrar un efectivo por pasarela.
          ...(meta?.paymentMethodType ? { paymentMethodType: meta.paymentMethodType } : {}),
          // Upgrades the placeholder (our reference) to the gateway's real
          // id, once it exists — a no-op for providers that had it already.
          ...(meta?.gatewayTransactionId ? { transactionId: meta.gatewayTransactionId } : {}),
          ...(nextStatus === PaymentStatus.PAID ? { processedAt: now } : {}),
        },
        $push: {
          statusHistory: {
            status: nextStatus,
            gatewayStatus,
            message: meta?.message,
            source: meta?.source ?? 'webhook',
            at: now,
          },
        },
      },
      { new: true }
    );

    if (!claimed) {
      // Otra entrega del mismo hecho ganó la carrera y ya aplicó todo.
      const order = await Order.findById(payment.orderId);
      return { order, changed: false };
    }

    // Aviso en vivo a la pantalla de espera de la app. Va aquí, después del
    // reclamo atómico, porque este es el único punto por el que pasan tanto
    // el webhook como `sync` y solo quien gana la carrera llega: un cambio,
    // un aviso. El polling de la app queda de respaldo, no de mecanismo.
    emitToUser(claimed.userId.toString(), 'payment:updated', {
      orderId: claimed.orderId.toString(),
      reference: claimed.reference,
      status: toClientStatus(nextStatus),
      declineReason: nextStatus === PaymentStatus.FAILED ? meta?.message : undefined,
    });

    const order = await Order.findById(claimed.orderId);
    if (!order) {
      console.error('[PAYMENTS] Pago sin pedido asociado', {
        key,
        paymentId: claimed._id.toString(),
      });
      return { order: null, changed: true };
    }

    if (nextStatus === PaymentStatus.PAID) {
      return this.onCaptured(order, claimed, key);
    }

    // El pedido refleja el estado del cobro, con la escritura acotada al
    // campo. `order.save()` reescribía el documento entero desde una copia
    // leída hace varios `await`, así que pisaba cualquier cambio hecho
    // entretanto —una cancelación, la asignación de un domiciliario—.
    //
    // Un pedido ya reembolsado no vuelve atrás: es terminal, y un evento
    // tardío de la pasarela no puede reabrirlo.
    await Order.updateOne(
      { _id: order._id, paymentStatus: { $ne: PaymentStatus.REFUNDED } },
      { $set: { paymentStatus: nextStatus } }
    );
    order.paymentStatus = nextStatus;

    return { order, changed: true };
  }

  /**
   * Las consecuencias de que el dinero haya entrado de verdad.
   *
   * Separado del reclamo del estado porque son dos preguntas distintas, y
   * confundirlas era la vía por la que se escapaba dinero:
   *
   *  · **¿Entró el dinero?** Lo dice Wompi y no se discute. El pago queda
   *    PAID pase lo que pase — negarlo sería tener un cobro real que la
   *    plataforma no reconoce, que es peor que cualquier descuadre.
   *  · **¿Se da el pedido por cobrado?** Eso exige además que el dinero
   *    cubra lo que el pedido vale AHORA y que el pedido siga vivo.
   *
   * Los dos casos en que la segunda respuesta es "no" son reales:
   *
   *  1. **Se pagó un enlace viejo.** El total cambió entre que se generó el
   *     checkout y que el cliente pagó, así que llegó menos dinero del que
   *     cuesta el pedido. Marcarlo pagado dejaba al comercio cocinando y a
   *     ZIPP liquidando por un dinero que no está.
   *  2. **El pedido ya se canceló.** `onCancelled` ya deshizo los libros y
   *     `voidOpenPayments` dejó el intento en FAILED; FAILED → PAID sigue
   *     siendo legal a propósito, porque el dinero entró. Lo que no puede
   *     pasar —y era lo que pasaba— es que además se liberen las
   *     liquidaciones: ZIPP le pagaba al comercio un pedido cancelado. Lo
   *     que corresponde es un reembolso, y eso lo decide una persona.
   */
  private async onCaptured(
    order: IOrder,
    payment: IPayment,
    key: string
  ): Promise<{ order: IOrder; changed: boolean }> {
    const orderTotal = order.finance?.customerTotal ?? order.total;
    const shortPaid = payment.amount !== orderTotal;
    const orderClosed =
      order.status === OrderStatus.CANCELLED || order.paymentStatus === PaymentStatus.REFUNDED;

    if (shortPaid || orderClosed) {
      const reason = orderClosed
        ? 'Se cobró un pedido que ya estaba cancelado o reembolsado'
        : `Se cobró ${payment.amount} por un pedido que cuesta ${orderTotal}`;

      console.error('[PAYMENTS] Cobro que no puede darse por bueno', {
        key,
        paymentId: payment._id.toString(),
        orderId: order._id.toString(),
        paidAmount: payment.amount,
        orderTotal,
        orderStatus: order.status,
      });

      await Payment.updateOne(
        { _id: payment._id },
        { $set: { 'metadata.requiresReview': true, 'metadata.reviewReason': reason } }
      );

      logSystemAudit({
        userId: 'system',
        role: 'system',
        action: AuditAction.SUSPICIOUS_ACTIVITY,
        entity: 'payment',
        entityId: payment._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Cobro retenido para revisión: ${reason}`,
        metadata: {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber,
          orderStatus: order.status,
          paidAmount: payment.amount,
          orderTotal,
          reference: payment.reference,
          transactionId: payment.transactionId,
        },
      }).catch(console.error);

      // El pago queda PAID —el dinero entró— pero el pedido no avanza y
      // nada se libera. Queda dinero cobrado con un pedido sin cerrar, que
      // es visible y reparable; lo contrario es invisible y no lo es.
      return { order, changed: true };
    }

    // El dinero cubre el pedido y el pedido sigue vivo: se cierra el cobro.
    await Order.updateOne(
      { _id: order._id, paymentStatus: { $ne: PaymentStatus.REFUNDED } },
      { $set: { paymentStatus: PaymentStatus.PAID } }
    );
    order.paymentStatus = PaymentStatus.PAID;

    // Imported lazily: the ledger and payout services import models that
    // import this module, and a static cycle would leave one side undefined.
    const { ledgerService } = await import('../ledger.service');
    const { payoutService } = await import('../payout.service');

    await ledgerService.recordPaymentCaptured({
      orderId: order._id,
      amount: payment.amount,
      pricingConfigVersion: order.finance?.pricingConfigVersion ?? 0,
      transactionId: payment.transactionId ?? key,
      currency: order.finance?.currency,
    });

    // The money is ours, so what we owe becomes payable.
    await payoutService.release(order._id);

    // ── El mandado empieza a buscar domiciliario aquí ──
    //
    // Un pedido normal arranca la búsqueda cuando el comercio lo marca
    // listo. Un mandado no tiene comercio que lo marque, así que el
    // disparador es el cobro — y tiene que serlo: mandar a alguien a
    // adelantar $50.000 de su bolsillo por un pedido que todavía no está
    // pagado sería ponerle su dinero a jugar por nosotros.
    if (order.kind === OrderKind.ERRAND && !order.driverId) {
      import('../dispatch.service')
        .then(({ startDispatch }) => startDispatch(order._id.toString()))
        .catch((err) => console.error('[Errand] No se pudo iniciar el reparto:', err));
    }

    return { order, changed: true };
  }

  /**
   * Handles a provider callback.
   *
   * Three gates before anything moves: a valid signature, a parseable
   * payload, and an event key we have not already processed. The unique
   * index on (provider, eventKey) is the actual lock — checking first and
   * inserting after would race under the retry storms gateways produce.
   */
  async handleWebhook(
    rawBody: string,
    signature: string
  ): Promise<{
    accepted: boolean;
    duplicated: boolean;
    ignored?: boolean;
    reason?: string;
  }> {
    const provider = getPaymentProvider();

    if (!provider.verifyWebhookSignature(rawBody, signature)) {
      return { accepted: false, duplicated: false, reason: 'firma inválida' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { accepted: false, duplicated: false, reason: 'cuerpo ilegible' };
    }

    const parsed = provider.parseWebhook(payload);
    if (!parsed) {
      // Firma válida, evento que no nos toca: Wompi publica varios tipos en
      // el mismo endpoint (`nequi_token.updated`, y lo que añada después).
      // Se acusa recibo en vez de rechazarlo — un no-2xx haría que la
      // pasarela reintentara para siempre un evento que jamás vamos a
      // aplicar, y ese ruido acaba enterrando los reintentos que sí importan.
      return {
        accepted: true,
        duplicated: false,
        ignored: true,
        reason: 'evento no aplicable',
      };
    }

    // ── Confirmación contra la pasarela ──
    //
    // Una firma válida prueba que los campos *firmados* no se tocaron, no
    // que el resto del cuerpo sea cierto. Wompi firma tres —id, estado y
    // monto— y deja fuera la referencia, que es justo lo que decide a qué
    // pago se aplica el evento. Cuando el proveedor sabe confirmar, se le
    // pregunta a él y se aplica SU versión, no la que llegó por la red.
    //
    // Un fallo de red se propaga a propósito: se responde 5xx, Wompi
    // reintenta y el pago acaba aplicándose. Descartarlo como "no
    // confirmado" perdería cobros reales por un hipo de conectividad.
    let event = parsed;
    if (provider.confirmEvent) {
      const confirmed = await provider.confirmEvent(parsed);
      if (!confirmed) {
        console.error('[PAYMENTS] Evento rechazado: la pasarela no lo confirma', {
          reference: parsed.paymentId,
          transactionId: parsed.gatewayTransactionId,
        });
        return { accepted: false, duplicated: false, reason: 'evento no confirmado por la pasarela' };
      }
      event = confirmed;
    }

    const body = payload as Record<string, unknown>;
    // La clave anti-duplicado sale del contenido FIRMADO del evento, no de
    // un `eventId` del cuerpo: ese campo no entra en la firma de Wompi, así
    // que bastaba con cambiarlo para que un mismo evento se procesara de
    // nuevo como si fuera otro. Con el proveedor confirmando, además, la
    // clave describe el hecho —esta transacción llegó a este estado— y no
    // la entrega concreta, que es lo que debe deduplicarse.
    const eventKey = event.gatewayTransactionId
      ? `${event.gatewayTransactionId}:${event.rawStatus ?? event.status}`
      : typeof body.eventId === 'string' && body.eventId
        ? body.eventId
        : crypto.createHash('sha256').update(rawBody).digest('hex');

    try {
      await ProcessedWebhook.create({
        provider: provider.name,
        eventKey,
        paymentReference: event.paymentId,
        status: event.status,
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        return { accepted: true, duplicated: true, reason: 'evento ya procesado' };
      }
      throw error;
    }

    // The claim above is a lock, not a receipt. If applying the event fails
    // — Mongo blip, ledger error, a mismatched amount — the row has to go,
    // or the gateway's retry would hit the duplicate branch and be answered
    // "already processed" while nothing was ever processed. That silently
    // stranded approved payments: money captured by Wompi, order still
    // pending, no ledger entry, no payout released. Releasing the claim is
    // what makes at-least-once delivery actually deliver.
    let result: { order: IOrder | null; changed: boolean };
    try {
      result = await this.applyGatewayStatus(event.paymentId, event.status, event.amount, {
        gatewayTransactionId: event.gatewayTransactionId,
        currency: event.currency,
        message: event.message,
        paymentMethodType: event.paymentMethodType,
        rawStatus: event.rawStatus,
        source: 'webhook',
      });
    } catch (error) {
      await ProcessedWebhook.deleteOne({ provider: provider.name, eventKey }).catch(() => {
        // Losing the compensation is worse than the original failure: the
        // event would be stuck forever. Surface it loudly, then rethrow the
        // real cause so the gateway still sees a non-2xx and retries.
        console.error('[PAYMENTS] No se pudo liberar el registro de webhook', { eventKey });
      });
      throw error;
    }

    const { order, changed } = result;

    await ProcessedWebhook.updateOne(
      { provider: provider.name, eventKey },
      {
        $set: {
          handled: true,
          orderId: order?._id ?? null,
          result: changed ? 'aplicado' : 'sin cambios',
        },
      }
    );

    return { accepted: true, duplicated: false };
  }

  /**
   * Re-reads a payment from the provider and syncs the local record.
   *
   * `transactionId` must be an id the gateway itself recognises — for a
   * redirect-based provider that is only true once a webhook or the
   * post-checkout redirect has revealed it. Callers that only have the
   * merchant reference should read the local record instead (see
   * PaymentController.status) rather than call this with it.
   */
  async sync(transactionId: string): Promise<PaymentIntent> {
    const provider = getPaymentProvider();
    const intent = await provider.getPayment(transactionId);
    await this.applyGatewayStatus(transactionId, intent.status, intent.amount, {
      gatewayTransactionId: intent.id,
      currency: intent.currency,
      message: intent.declineReason,
      paymentMethodType: intent.paymentMethodType,
      rawStatus: intent.rawStatus,
      source: 'sync',
    });
    return intent;
  }

  async getForOrder(orderId: string) {
    return Payment.find({ orderId }).sort({ createdAt: -1 });
  }

  // ── Efectivo ───────────────────────────────────────────────────────
  //
  // El efectivo no lo recibe ZIPP: lo recibe una persona en una puerta.
  // Eso cambia dos cosas respecto al pago en línea, y solo dos.
  //
  //  · No hay pasarela que atestigüe nada. El único testigo es el
  //    domiciliario, así que su declaración se registra como tal —con
  //    actor, hora y estado previo— y nunca como un hecho anónimo.
  //  · El asiento contable ya se escribió al entregar (ver
  //    OrderService.onDelivered → recordCashCollected). Confirmar el
  //    efectivo **no** vuelve a tocar el libro mayor; solo cierra el
  //    estado del cobro. Volver a asentarlo duplicaría los ingresos.

  /**
   * Abre el cobro en efectivo de un pedido.
   *
   * Se llama al crear el pedido, no al entregarlo: desde el primer
   * instante existe una fila que dice "este pedido se cobra en la puerta"
   * y en qué estado va. Antes no había ninguna, y un pedido en efectivo
   * era indistinguible de uno en línea sin pagar.
   *
   * Idempotente por construcción: la referencia se deriva del pedido y el
   * índice único la respalda, así que dos llamadas concurrentes devuelven
   * la misma fila en vez de crear dos cobros.
   */
  async openCashPayment(order: IOrder): Promise<IPayment> {
    const reference = cashPaymentReference(order._id.toString());

    const existing = await Payment.findOne({ reference });
    if (existing) return existing;

    try {
      const payment = new Payment({
        orderId: order._id,
        userId: order.clientId,
        type: PaymentType.ORDER_PAYMENT,
        method: PaymentMethod.CASH_ON_DELIVERY,
        status: PaymentStatus.PENDING_CASH,
        amount: order.finance?.customerTotal ?? order.total,
        currency: order.finance?.currency ?? config.payments.currency,
        reference,
      });
      payment.statusHistory.push({
        status: PaymentStatus.PENDING_CASH,
        source: 'create',
        message: 'Pedido en efectivo: se cobra al entregar',
        at: new Date(),
      });
      await payment.save();
      return payment;
    } catch (error: any) {
      if (error?.code === 11000) {
        const raced = await Payment.findOne({ reference });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /**
   * El domiciliario declara si recibió —o no— el efectivo del cliente.
   *
   * Es el único camino por el que un pedido en efectivo llega a PAID, y
   * está deliberadamente cerrado por todos lados. La comprobación que
   * importa es la del estado: **el servicio tiene que haber terminado**.
   * Sin ella, alguien con el token de un domiciliario podría marcar
   * cobrado cualquier pedido asignado y cerrar la contabilidad de un
   * dinero que todavía no existe. Por eso no vive en la app: vive aquí.
   *
   * `driverId` es el `Driver._id` de quien confirma. Se vuelve a comparar
   * contra el pedido aunque el controlador ya haya resuelto el acceso: es
   * la diferencia entre "nadie puede llamar a este endpoint por otro
   * pedido" y "nadie puede llamar a este método por otro pedido".
   */
  async confirmCashCollection(input: {
    orderId: string;
    /** `Driver._id` de quien confirma. */
    driverId: string;
    actorUserId: string;
    received: boolean;
    note?: string;
    /** Solo para la auditoría; nunca influye en la decisión. */
    context?: { ip?: string; userAgent?: string };
  }): Promise<{ payment: IPayment; order: IOrder; changed: boolean }> {
    const order = await Order.findById(input.orderId);
    if (!order) throw new AppError('Pedido no encontrado', 404);

    if (order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
      throw new AppError('Este pedido no es de pago en efectivo', 400);
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new AppError('Este pedido fue cancelado y no admite cobro', 409);
    }

    // ── La puerta antifraude ──
    // Confirmar antes de entregar es cobrar por un servicio que no ha
    // ocurrido. El intento se audita: a este punto no se llega por
    // accidente, porque la app ni siquiera muestra el botón todavía.
    if (order.status !== OrderStatus.DELIVERED) {
      logSystemAudit({
        userId: input.actorUserId,
        role: 'driver',
        action: AuditAction.CASH_COLLECTION_BLOCKED,
        entity: 'order',
        entityId: order._id.toString(),
        severity: AuditSeverity.HIGH,
        description:
          `Intento de confirmar efectivo con el pedido en "${order.status}", ` +
          'antes de finalizar el servicio',
        metadata: {
          orderNumber: order.orderNumber,
          orderStatus: order.status,
          driverId: input.driverId,
          ...input.context,
        },
      }).catch(console.error);

      throw new AppError(
        'Solo puedes confirmar el efectivo cuando la entrega esté completada.',
        409,
        'CASH_BEFORE_DELIVERY'
      );
    }

    if (!order.driverId || order.driverId.toString() !== input.driverId) {
      throw new AppError('Este pedido no está asignado a ti', 403);
    }

    // La fila normalmente ya existe desde la creación del pedido; se abre
    // aquí solo para los pedidos anteriores a este cambio.
    const payment = await this.openCashPayment(order);

    // El monto sale del pedido, jamás de la petición. Si la fila y el
    // pedido discrepan, algo reescribió uno de los dos: se para en seco
    // en vez de cerrar un cobro por una cifra que nadie puede explicar.
    const expected = order.finance?.customerTotal ?? order.total;
    if (payment.amount !== expected) {
      console.error('[PAYMENTS] Monto del cobro en efectivo inconsistente', {
        orderId: order._id.toString(),
        payment: payment.amount,
        order: expected,
      });
      throw new AppError('El monto del cobro no coincide con el del pedido', 409);
    }

    const target = input.received ? PaymentStatus.PAID : PaymentStatus.CASH_NOT_RECEIVED;

    // ── Idempotencia ──
    // Repetir la misma confirmación es lo que hace una red móvil mala, no
    // un ataque: se responde lo mismo y no se cobra dos veces.
    if (payment.status === target) {
      return { payment, order, changed: false };
    }

    if (payment.status === PaymentStatus.PAID) {
      throw new AppError('Este pedido ya fue cobrado en efectivo', 409);
    }

    const now = new Date();
    const previousStatus = payment.status;
    const note = input.note?.slice(0, 200);

    // Se prepara la escritura completa antes de aplicarla, para que el
    // reclamo atómico de más abajo sea una sola operación.
    let update: Record<string, unknown>;

    if (input.received) {
      // Dos asientos en la historia, un solo estado final. La declaración
      // ("recibí el efectivo") y su consecuencia ("el pedido está pagado")
      // son hechos distintos y quedan los dos registrados, pero el pago no
      // se queda esperando en un estado intermedio que nada volvería a mover.
      if (!canTransitionPayment(previousStatus, PaymentStatus.CASH_RECEIVED)) {
        throw new AppError(
          `No se puede confirmar el efectivo desde el estado "${previousStatus}"`,
          409
        );
      }

      update = {
        $set: {
          status: PaymentStatus.PAID,
          processedAt: now,
          statusMessage: 'Cobrado en efectivo por el domiciliario',
        },
        $push: {
          statusHistory: {
            $each: [
              {
                status: PaymentStatus.CASH_RECEIVED,
                source: 'cash',
                message: note || 'El domiciliario recibió el efectivo',
                at: now,
              },
              {
                status: PaymentStatus.PAID,
                source: 'cash',
                message: 'Cobro en efectivo completado',
                at: now,
              },
            ],
          },
        },
      };
    } else {
      if (!canTransitionPayment(previousStatus, PaymentStatus.CASH_NOT_RECEIVED)) {
        throw new AppError(
          `No se puede reportar un faltante desde el estado "${previousStatus}"`,
          409
        );
      }

      update = {
        $set: {
          status: PaymentStatus.CASH_NOT_RECEIVED,
          statusMessage: 'Efectivo no recibido: pendiente de revisión',
        },
        $push: {
          statusHistory: {
            status: PaymentStatus.CASH_NOT_RECEIVED,
            source: 'cash',
            message: note || 'El domiciliario no recibió el efectivo',
            at: now,
          },
        },
      };
    }

    // ── Reclamo atómico ──
    //
    // El estado de partida viaja dentro de la escritura. La comprobación de
    // idempotencia de arriba y este guardado estaban separados por varios
    // `await`, y un doble toque en "confirmé el efectivo" —una red móvil
    // mala basta— pasaba el filtro dos veces: dos declaraciones en la
    // historia del cobro y, en un faltante, dos expedientes abiertos por el
    // mismo dinero. Solo una de las dos peticiones encuentra el estado
    // previo; la otra sale como repetición, que es lo que es.
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: previousStatus },
      update,
      { new: true }
    );

    if (!claimed) {
      const current = await Payment.findById(payment._id);
      return { payment: current ?? payment, order, changed: false };
    }

    // Escritura acotada al campo: `order.save()` reescribía el pedido
    // entero desde una copia leída antes de todas estas comprobaciones, y
    // se llevaba por delante cualquier cambio hecho entretanto.
    await Order.updateOne(
      { _id: order._id },
      { $set: { paymentStatus: claimed.status } }
    );
    order.paymentStatus = claimed.status;
    Object.assign(payment, claimed.toObject());

    // Un faltante no es solo un estado del cobro: es un caso que alguien
    // tiene que resolver. Sin expediente, lo único que quedaba era una
    // línea de auditoría, y una línea de auditoría no tiene estado — nadie
    // puede trabajar una lista de eventos ni saber cuáles siguen abiertos.
    //
    // Abrirlo no mueve dinero: ni la conciliación ni el libro mayor se
    // tocan. Esa es la garantía de que declarar un faltante no pueda ser
    // la forma barata de no pagarle a ZIPP.
    if (!input.received) {
      const { cashIncidentService } = await import('../cashIncident.service');
      await cashIncidentService.open({
        order,
        payment,
        driverId: input.driverId,
        note: input.note,
      });
    }

    // El libro mayor NO se toca aquí: `recordCashCollected` ya convirtió el
    // cobro pendiente en efectivo en poder del domiciliario cuando se
    // entregó el pedido, y la conciliación que abrió `open()` es la deuda
    // que queda viva. Un faltante tampoco la cancela —eso convertiría el
    // botón "no recibí" en la forma más barata de no pagarle a ZIPP—: la
    // deja abierta y marcada para que finanzas la resuelva con la
    // evidencia del traspaso delante.
    logSystemAudit({
      userId: input.actorUserId,
      role: 'driver',
      action: input.received
        ? AuditAction.CASH_COLLECTION_CONFIRMED
        : AuditAction.CASH_COLLECTION_DISPUTED,
      entity: 'payment',
      entityId: payment._id.toString(),
      severity: input.received ? AuditSeverity.MEDIUM : AuditSeverity.HIGH,
      description: input.received
        ? `Efectivo recibido del pedido ${order.orderNumber}`
        : `El domiciliario declaró NO haber recibido el efectivo del pedido ${order.orderNumber}`,
      metadata: {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        driverId: input.driverId,
        amount: payment.amount,
        currency: payment.currency,
        paymentMethod: order.paymentMethod,
        previousStatus,
        newStatus: payment.status,
        note: input.note?.slice(0, 200),
        ...input.context,
      },
    }).catch(console.error);

    return { payment, order, changed: true };
  }

  /**
   * Cierra todo intento de cobro que siga abierto para un pedido.
   *
   * Se usa al cambiar de método y al cancelar. El caso que justifica que
   * exista: el cliente pasa de "en línea" a "efectivo" con un checkout de
   * Wompi ya generado. Ese enlace sigue siendo válido y pagadero durante
   * un rato, y dejarlo vivo es la receta exacta del doble cobro —el
   * cliente paga en la puerta y después, desde el historial del
   * navegador, paga otra vez en la pasarela—. Cerrarlo aquí es lo que
   * garantiza la regla de que un pedido nunca tenga dos cobros válidos.
   *
   * Un webhook tardío sobre la referencia invalidada se encuentra un pago
   * FAILED, y la tabla de transiciones decide: FAILED → PAID sigue siendo
   * legal, porque si Wompi confirma que el dinero entró de verdad, el
   * hecho manda sobre nuestra intención de invalidarlo. Lo que no puede
   * pasar —y no pasa— es que el cambio de método deje dos cobros abiertos.
   *
   * Un pago ya aprobado NO se toca: deshacer eso no es cambiar de método,
   * es un reembolso, y tiene su propio camino.
   */
  async voidOpenPayments(orderId: string, reason: string): Promise<{ voided: number }> {
    const open = await Payment.find({
      orderId,
      status: { $in: [PaymentStatus.PENDING, PaymentStatus.PENDING_CASH] },
    });

    const now = new Date();
    let voided = 0;

    for (const payment of open) {
      // Condicional sobre el estado leído, y no `save()`: entre la lectura
      // de arriba y esta escritura cabe el webhook que aprueba justo ese
      // intento. Con `save()` se reescribía el documento entero desde la
      // copia vieja, así que la invalidación pisaba una aprobación real y
      // el cobro desaparecía —el dinero en Wompi, el pago en FAILED—. Con
      // la condición dentro, el que llega tarde simplemente no aplica.
      const result = await Payment.updateOne(
        { _id: payment._id, status: payment.status },
        {
          $set: {
            status: PaymentStatus.FAILED,
            statusMessage: reason,
            metadata: {
              ...(payment.metadata ?? {}),
              voidedReason: reason,
              voidedAt: now.toISOString(),
            },
          },
          $push: {
            statusHistory: {
              status: PaymentStatus.FAILED,
              source: 'admin',
              message: reason,
              at: now,
            },
          },
        }
      );

      if (result.modifiedCount) voided += 1;
    }

    return { voided };
  }
}

export const paymentService = new PaymentService();
