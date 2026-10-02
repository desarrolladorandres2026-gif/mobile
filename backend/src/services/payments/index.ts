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
  OtpAttempts,
  OtpRejectedError,
  GatewayRejectedError,
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
// Ciclo deliberado: `pro.service` cobra a través de este módulo y este
// módulo le devuelve el resultado. Ninguno de los dos toca al otro
// mientras se carga —solo dentro de sus métodos—, que es la condición
// para que un ciclo de CommonJS sea inofensivo.
import { proService } from '../pro.service';

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
export function nativeCapabilities(): {
  native: boolean;
  pse: boolean;
  savedCards: boolean;
  bancolombiaTransfer: boolean;
  daviplata: boolean;
} {
  try {
    const provider = getPaymentProvider();
    const native = Boolean(provider.createNativePayment && provider.getCheckoutConfig);
    return {
      native,
      pse: native && Boolean(provider.listPseBanks),
      savedCards: native && Boolean(provider.createPaymentSource),
      // El Botón Bancolombia no necesita nada más del proveedor que crear la
      // transacción: la dirección del banco llega dentro de la respuesta.
      bancolombiaTransfer: native,
      // DaviPlata sí: sin los servicios de código no hay forma de confirmar
      // el cobro desde la app, y ofrecer el carril sería un callejón.
      daviplata: native && Boolean(provider.validateOtp),
    };
  } catch {
    return {
      native: false,
      pse: false,
      savedCards: false,
      bancolombiaTransfer: false,
      daviplata: false,
    };
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

/**
 * Referencia de un cobro de membresía. Como la de un pedido en línea —una
 * por intento—, pero colgada de la persona: Zipp Pro no tiene pedido del
 * que colgar. El prefijo `PRO` es lo que permite reconocer de un vistazo,
 * en el panel de Wompi, un cobro que no corresponde a ninguna entrega.
 */
function proPaymentReference(userId: string): string {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `ZIPP-PRO-${userId}-${Date.now().toString(36)}-${suffix}`.toUpperCase();
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
  | Extract<PaymentInstrument, { kind: 'pse' }>
  | Extract<PaymentInstrument, { kind: 'bancolombia_transfer' }>
  | Extract<PaymentInstrument, { kind: 'daviplata' }>;

interface InitiateNativeInput extends InitiateInput {
  /** Con qué se cobra. Nunca contiene número de tarjeta: ya está tokenizada. */
  instrument: ClientInstrument;
  /** El consentimiento que el cliente tuvo delante, tal cual. */
  acceptanceToken: string;
  /** Solo si va a guardarse la tarjeta. */
  personalDataAuthToken?: string;
  browserInfo?: Record<string, string>;
}

/**
 * Un cobro que no cuelga de ningún pedido: hoy, la membresía Zipp Pro.
 *
 * El importe lo pone quien llama —y quien llama lo saca del plan, nunca de
 * la app—, igual que el total de un pedido sale del pedido. Aquí no hay
 * `redirectUrl` ni métodos asíncronos: la membresía se cobra con tarjeta
 * porque la renovación mensual necesita algo que se pueda volver a cobrar,
 * y ni Nequi ni PSE lo son.
 */
interface InitiateProInput {
  userId: string;
  amount: number;
  description: string;
  customer: { name: string; phone?: string; email?: string };
  instrument: Extract<ClientInstrument, { kind: 'card_token' } | { kind: 'saved_card' }>;
  acceptanceToken: string;
  personalDataAuthToken?: string;
  browserInfo?: Record<string, string>;
  metadata?: Record<string, unknown>;
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
        // Sin `redirectUrl`: para PSE la pone el provider desde la
        // configuración, nunca desde la app.
        reference,
        instrument,
        acceptanceToken: input.acceptanceToken,
        personalDataAuthToken: input.personalDataAuthToken,
        browserInfo: input.browserInfo,
      });
    } catch (error) {
      // Un "no" explícito de la pasarela cierra la fila para liberar el hueco
      // del índice; si no, el cliente quedaría bloqueado sin poder reintentar.
      // Cualquier otro fallo (red, tiempo agotado) no dice si Wompi alcanzó a
      // crear la transacción, y eso se pregunta antes de cerrar nada.
      const found = await this.onCreationError(payment, error);
      intent = found;
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
   * Cobra la membresía Zipp Pro.
   *
   * Hermano de `initiateNative` y no un parámetro suyo: comparten la
   * mecánica (una fila PENDING antes de tocar la pasarela, el instrumento
   * resuelto contra el dueño, el estado que solo mueve `applyGatewayStatus`)
   * pero no comparten ni una sola guarda. Las de un pedido —que exista, que
   * sea en línea, que no esté cancelado, que el importe cuadre con el
   * total— no significan nada aquí, y mezclarlas en un método con un `if`
   * por medio es la forma segura de que un día una guarda de pedidos deje
   * pasar un cobro de membresía, o al revés.
   *
   * Devuelve además `savedCardId` porque la suscripción tiene que
   * recordarlo: sin tarjeta guardada no hay renovación posible, y eso se
   * decide aquí, no en la pantalla.
   */
  async initiateProNative(input: InitiateProInput): Promise<{
    intent: PaymentIntent;
    paymentId: string;
    reference: string;
    savedCardId?: string;
  }> {
    const provider = getPaymentProvider();

    if (!provider.createNativePayment) {
      throw new AppError(
        `El proveedor de pagos "${provider.name}" no admite cobro dentro de la aplicación`,
        501
      );
    }

    await this.clearOpenProAttempt(input.userId);

    const { instrument, savedCardId } = await this.resolveInstrument(provider, input);

    const reference = proPaymentReference(input.userId);

    const payment = new Payment({
      // Sin `orderId`: no hay pedido. El esquema lo permite solo para este
      // tipo, y el índice de "un intento abierto por persona" es lo que
      // impide que un doble toque abra dos cobros.
      userId: input.userId,
      type: PaymentType.PRO_SUBSCRIPTION,
      method: PaymentMethod.ONLINE,
      status: PaymentStatus.PENDING,
      amount: input.amount,
      currency: config.payments.currency,
      reference,
      transactionId: reference,
      metadata: { ...(input.metadata ?? {}), instrumentKind: input.instrument.kind },
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
          'Ya hay un cobro de tu membresía en curso. Espera a que termine.',
          409,
          'PAYMENT_IN_PROGRESS'
        );
      }
      throw error;
    }

    let intent: PaymentIntent;
    try {
      intent = await provider.createNativePayment({
        orderId: '',
        userId: input.userId,
        amount: input.amount,
        currency: config.payments.currency,
        description: input.description,
        customer: input.customer,
        reference,
        instrument,
        acceptanceToken: input.acceptanceToken,
        personalDataAuthToken: input.personalDataAuthToken,
        browserInfo: input.browserInfo,
      });
    } catch (error) {
      intent = await this.onCreationError(payment, error);
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
    return { intent, paymentId: payment._id.toString(), reference, savedCardId };
  }

  /**
   * Retira el intento de membresía anterior, si lo hay.
   *
   * Mismo criterio que con un pedido: antes de retirar nada se le pregunta
   * a la pasarela, porque una fila PENDING puede ser una transacción ya
   * aprobada cuyo webhook no ha llegado. La diferencia es qué se hace con
   * un cobro ya aprobado — en un pedido es un caso para soporte; aquí
   * significa sencillamente que la persona ya es Pro.
   */
  private async clearOpenProAttempt(userId: string): Promise<void> {
    const existing = await Payment.findOne({
      userId,
      type: PaymentType.PRO_SUBSCRIPTION,
      status: PaymentStatus.PENDING,
    }).sort({ createdAt: -1 });

    if (!existing) return;

    const hasGatewayRecord = Boolean(
      existing.transactionId && existing.transactionId !== existing.reference
    );

    let asked = false;
    if (!hasGatewayRecord) {
      const decision = await this.settleUnconfirmedAttempt(existing);
      if (decision === 'retire') {
        await this.retireAttempt(
          existing,
          'Intento de membresía que no llegó a la pasarela; sustituido por uno nuevo',
          { supersededAmount: existing.amount, supersededAt: new Date().toISOString() }
        );
        return;
      }
      asked = decision === 'resolved';
    } else {
      try {
        await this.sync(existing.transactionId!);
        asked = true;
      } catch {
        // Sin respuesta de la pasarela se decide con la fila local.
      }
    }

    const refreshed = await Payment.findById(existing._id);

    if (refreshed?.status === PaymentStatus.PAID) {
      throw new AppError('Tu membresía ya está pagada.', 409, 'PAYMENT_ALREADY_PAID');
    }

    if (refreshed?.status === PaymentStatus.PENDING) {
      throw new AppError(
        asked
          ? 'Ya hay un cobro de tu membresía en curso. Espera a que termine.'
          : 'No pudimos verificar el cobro anterior. Espera un momento y vuelve a intentarlo.',
        409,
        'PAYMENT_IN_PROGRESS'
      );
    }
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
    // Solo lo que de verdad se mira: quién cobra, con qué y con qué
    // consentimientos. Pedir el molde entero de un pedido obligaba a
    // inventarse un `orderId` vacío para cobrar una membresía.
    input: {
      userId: string;
      instrument: ClientInstrument;
      customer: { email?: string };
      acceptanceToken: string;
      personalDataAuthToken?: string;
    }
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
      case 'bancolombia_transfer':
      case 'daviplata':
        // Pasan tal cual: ninguno lleva nada que haya que traducir ni que
        // dependa de comprobar a quién pertenece algo guardado.
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

    let asked = false;
    if (!hasGatewayRecord) {
      // Sin id de la pasarela no basta con suponer que nunca llegó: puede
      // estar creándose ahora mismo en otra petición, o haberse creado justo
      // antes de un corte de red. Ver `settleUnconfirmedAttempt`.
      const decision = await this.settleUnconfirmedAttempt(existing);
      if (decision === 'retire') {
        await this.retireAttempt(
          existing,
          'Intento anterior que no llegó a la pasarela; sustituido por uno nuevo',
          { supersededAmount: existing.amount, supersededAt: new Date().toISOString() }
        );
        return;
      }
      asked = decision === 'resolved';
    } else {
      try {
        await this.sync(existing.transactionId!);
        asked = true;
      } catch {
        // No se pudo preguntar. Se decide con lo que diga la fila local, que
        // es lo único disponible.
      }
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
   * La creación de un cobro falló. ¿Existe o no la transacción en Wompi?
   *
   * Antes todo fallo cerraba la fila como FAILED. Pero si la conexión se
   * cortaba *después* de que Wompi creara el cobro, el cliente reintentaba,
   * pagaba con un intento nuevo y el primero se aprobaba igual: dos cobros.
   * Ahora solo un rechazo explícito (`GatewayRejectedError`) cierra la fila
   * sin preguntar. Lo demás se busca por referencia: si existe, se sigue con
   * esa transacción como si la respuesta hubiera llegado; si Wompi dice que
   * no existe, se cierra; si no se le puede preguntar, la fila queda abierta
   * y marcada, y nadie puede abrir otro cobro hasta saberlo.
   */
  private async onCreationError(payment: IPayment, error: unknown): Promise<PaymentIntent> {
    if (error instanceof GatewayRejectedError) return this.failCreation(payment, error);

    const outcome = await this.reconcileByReference(payment);
    if (outcome.kind === 'found') return outcome.intent;
    if (outcome.kind === 'absent' || outcome.kind === 'unsupported') {
      return this.failCreation(payment, error);
    }

    const detail = ((error as Error)?.message || 'sin detalle').slice(0, 400);
    console.error('[PAYMENTS] No se sabe si la pasarela creó el cobro', {
      paymentId: payment._id.toString(),
      detail,
    });
    await Payment.updateOne(
      { _id: payment._id, status: PaymentStatus.PENDING },
      { $set: { 'metadata.creationUncertain': true, 'metadata.gatewayDetail': detail } }
    );
    throw new AppError(
      'No pudimos confirmar si el pago se procesó. No lo intentes otra vez todavía: revisa tu pedido en unos minutos.',
      502,
      'PAYMENT_UNCERTAIN'
    );
  }

  /**
   * Busca en la pasarela, por nuestra referencia, un intento que todavía no
   * tiene id de la pasarela. Si aparece, la fila asciende a ese id y su
   * estado pasa por `applyGatewayStatus` como cualquier otro.
   */
  private async reconcileByReference(payment: IPayment): Promise<
    | { kind: 'found'; intent: PaymentIntent }
    | { kind: 'absent' }
    | { kind: 'unknown' }
    | { kind: 'unsupported' }
  > {
    const provider = getPaymentProvider();
    if (!provider.findPaymentByReference || !payment.reference) return { kind: 'unsupported' };

    let intent: PaymentIntent | null;
    try {
      intent = await provider.findPaymentByReference(payment.reference);
    } catch (error) {
      console.error('[PAYMENTS] No se pudo buscar el cobro por referencia', {
        paymentId: payment._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'unknown' };
    }
    if (!intent) return { kind: 'absent' };

    await Payment.updateOne(
      { _id: payment._id, transactionId: payment.reference },
      {
        $set: {
          transactionId: intent.id,
          ...(intent.paymentMethodType ? { paymentMethodType: intent.paymentMethodType } : {}),
          ...(intent.rawStatus ? { gatewayStatus: intent.rawStatus } : {}),
        },
        $unset: { 'metadata.creationUncertain': '' },
      }
    );
    await this.applyGatewayStatus(intent.id, intent.status, intent.amount, {
      gatewayTransactionId: intent.id,
      currency: intent.currency,
      message: intent.declineReason,
      paymentMethodType: intent.paymentMethodType,
      rawStatus: intent.rawStatus,
      source: 'sync',
    });
    return { kind: 'found', intent };
  }

  /**
   * Resuelve, desde el barrido, un cobro cuya creación quedó en duda.
   * Si Wompi confirma que no existe, se cierra y el cliente puede reintentar.
   */
  async resolveUncertainCreation(paymentId: string): Promise<void> {
    const payment = await Payment.findOne({
      _id: paymentId,
      status: PaymentStatus.PENDING,
      'metadata.creationUncertain': true,
    });
    if (!payment || payment.transactionId !== payment.reference) return;

    const outcome = await this.reconcileByReference(payment);
    if (outcome.kind === 'absent') {
      await this.retireAttempt(payment, 'La pasarela confirmó que el cobro no llegó a crearse', {
        creationUncertain: false,
      });
    } else if (outcome.kind === 'unknown') {
      throw new Error('La pasarela no respondió a la búsqueda por referencia');
    }
  }

  /**
   * Qué hacer con un intento PENDING que todavía no tiene id de la pasarela.
   *
   *  · `busy`: no se puede decidir aún. Un cobro dentro de la app recién
   *    creado puede estar, en este mismo instante, esperando la respuesta de
   *    Wompi en otra petición (el doble toque); retirarlo abría un segundo
   *    cobro. Tampoco se retira uno marcado como incierto si Wompi no
   *    contesta.
   *  · `resolved`: Wompi lo tenía y la fila ya se sincronizó; hay que mirar
   *    su estado nuevo.
   *  · `retire`: Wompi confirma que no existe (o el proveedor no sabe
   *    buscar, que es lo de siempre): retirarlo no puede perder dinero.
   */
  private async settleUnconfirmedAttempt(payment: IPayment): Promise<'busy' | 'resolved' | 'retire'> {
    const native = Boolean(payment.metadata?.instrumentKind);
    const graceMs = (config.payments.wompi.httpTimeoutMs || 15_000) + 15_000;
    if (native && Date.now() - new Date(payment.createdAt).getTime() < graceMs) return 'busy';

    const outcome = await this.reconcileByReference(payment);
    if (outcome.kind === 'found') return 'resolved';
    if (outcome.kind === 'absent' || outcome.kind === 'unsupported') return 'retire';
    return payment.metadata?.creationUncertain || native ? 'busy' : 'retire';
  }

  /**
   * Cierra un intento que la pasarela no llegó a crear y responde al cliente.
   *
   * Antes el texto de la excepción salía tal cual hacia la app: "Wompi
   * rechazó la creación de la transacción (HTTP 422). {…json…}". Eso es un
   * nombre que mucha gente no reconoce, un código HTTP y un volcado de
   * validación, justo en el momento en que alguien está decidiendo si
   * confiar su tarjeta. Ahora el cliente ve `customerMessage` cuando la
   * pasarela sabe explicarse (`GatewayRejectedError`) y un genérico si no;
   * el detalle crudo queda en el registro y en `metadata.gatewayDetail` de
   * la fila, que es donde lo busca soporte.
   */
  private async failCreation(payment: IPayment, error: unknown): Promise<never> {
    const detail = ((error as Error)?.message || 'sin detalle').slice(0, 400);
    const customerMessage =
      error instanceof GatewayRejectedError
        ? error.customerMessage
        : 'No pudimos iniciar el pago. Intenta de nuevo o usa otro medio de pago.';

    console.error('[PAYMENTS] La pasarela no creó el cobro', {
      paymentId: payment._id.toString(),
      detail,
    });
    await this.retireAttempt(payment, customerMessage, { gatewayDetail: detail });
    throw new AppError(customerMessage, 502, 'GATEWAY_REJECTED');
  }

  /**
   * Closes a pending attempt without deleting it. The row stays resolvable
   * by reference, which is what lets a late gateway event about it be
   * recognised — and judged — instead of vanishing.
   */
  /**
   * Devuelve si de verdad lo retiró. El filtro exige `PENDING`, así que si
   * un webhook lo resolvió un instante antes, esto no pisa nada y dice que no.
   */
  private async retireAttempt(
    payment: IPayment,
    reason: string,
    metadata: Record<string, unknown> = {},
    source: 'admin' | 'client' = 'admin'
  ): Promise<boolean> {
    const now = new Date();
    const result = await Payment.updateOne(
      { _id: payment._id, status: PaymentStatus.PENDING },
      {
        $set: {
          status: PaymentStatus.FAILED,
          statusMessage: reason,
          metadata: { ...(payment.metadata ?? {}), voidedReason: reason, voidedAt: now.toISOString(), ...metadata },
        },
        $push: {
          statusHistory: { status: PaymentStatus.FAILED, source, message: reason, at: now },
        },
      }
    );
    return result.modifiedCount > 0;
  }

  /**
   * La persona dejó a medias la verificación del banco y quiere pagar de
   * otra forma.
   *
   * Wompi no deja anular un cobro pendiente (PSE, Bancolombia, 3D Secure):
   * su `void` es solo para tarjetas ya aprobadas. Así que esto no cancela
   * nada en la pasarela — suelta el intento en Zipp para que se pueda abrir
   * otro. Es la única excepción a "nunca un segundo cobro con uno vivo", y
   * por eso tiene tres condiciones:
   *
   *  1. Se le pregunta a Wompi primero. Si el pago ya entró, se dice eso y
   *     no se suelta nada. Si no se le puede preguntar, tampoco: "no sé" no
   *     es "no pagó".
   *  2. El retiro es condicional a `PENDING`: si el webhook gana la carrera,
   *     manda el webhook.
   *  3. Si el banco aprueba después de todas formas, `FAILED → PAID` sigue
   *     siendo legal y `onCaptured` lo retiene para revisión cuando el pedido
   *     ya estaba pagado con otro intento. El dinero nunca se pierde de vista.
   */
  async abandonAttempt(input: { userId: string; transactionId: string }): Promise<{
    status: 'approved' | 'declined' | 'abandoned';
  }> {
    const notFound = new AppError('Pago no encontrado', 404);
    const key = input.transactionId;

    const payment = await Payment.findOne({ $or: [{ transactionId: key }, { reference: key }] });
    if (!payment) throw notFound;
    if (payment.userId.toString() !== input.userId) throw notFound;
    if (payment.method === PaymentMethod.CASH_ON_DELIVERY) throw notFound;

    const outcome = (status: PaymentStatus) =>
      status === PaymentStatus.PAID ? 'approved' as const : 'declined' as const;

    // Ya resuelto: se dice cómo terminó, sin tocar nada.
    if (payment.status !== PaymentStatus.PENDING) return { status: outcome(payment.status) };

    const hasGatewayRecord = Boolean(
      payment.transactionId && payment.transactionId !== payment.reference
    );

    if (hasGatewayRecord) {
      try {
        await this.sync(payment.transactionId!);
      } catch {
        throw new AppError(
          'No pudimos confirmar con el banco si el pago entró. Espera un momento e inténtalo de nuevo.',
          502,
          'GATEWAY_ERROR'
        );
      }
    } else if ((await this.settleUnconfirmedAttempt(payment)) === 'busy') {
      throw new AppError(
        'No pudimos confirmar con el banco si el pago entró. Espera un momento e inténtalo de nuevo.',
        502,
        'GATEWAY_ERROR'
      );
    }
    const refreshed = await Payment.findById(payment._id);
    if (refreshed && refreshed.status !== PaymentStatus.PENDING) {
      return { status: outcome(refreshed.status) };
    }

    const retired = await this.retireAttempt(
      payment,
      'La persona abandonó el pago antes de terminarlo',
      { abandonedByClient: true, abandonedAt: new Date().toISOString() },
      'client'
    );

    if (!retired) {
      // Otro camino lo resolvió entre la consulta y el retiro.
      const latest = await Payment.findById(payment._id);
      return { status: outcome(latest?.status ?? PaymentStatus.FAILED) };
    }

    // Retirar el cobro no pasa por `applyGatewayStatus`, así que la
    // membresía que esperaba este cobro no se entera sola: quedaría en
    // PENDING para siempre. Si el banco aprueba después de todas formas,
    // `FAILED → PAID` la sigue activando.
    if (payment.type === PaymentType.PRO_SUBSCRIPTION) {
      await proService.releaseAbandonedAttempt(payment.userId.toString());
    }

    return { status: 'abandoned' };
  }

  /**
   * El pedido de un cobro, o `null` si ese cobro no es de ningún pedido.
   *
   * No es azúcar: `Order.findById(undefined)` no devuelve "nada", devuelve
   * lo que Mongo entienda por un filtro sin `_id`. Desde que existen cobros
   * sin pedido —la membresía Zipp Pro— cada consulta tiene que preguntarse
   * antes si hay pedido, y tenerlo en un solo sitio es lo que impide que a
   * la sexta se le olvide a alguien.
   */
  private orderOf(payment: IPayment): Promise<IOrder | null> {
    return payment.orderId ? Order.findById(payment.orderId) : Promise.resolve(null);
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
      const order = await this.orderOf(payment);
      return { order, changed: false };
    }

    const nextStatus = toPaymentStatus(status);

    if (payment.status === nextStatus) {
      // Otra entrega del mismo cobro aprobado. Si la primera se cortó
      // después del reclamo, aquí se termina lo que quedó pendiente; un
      // error se propaga para que el webhook responda 5xx y Wompi reintente.
      if (nextStatus === PaymentStatus.PAID) {
        await this.resumeCapture(payment._id.toString(), key);
      }
      const order = await this.orderOf(payment);
      return { order, changed: false };
    }

    // Un intento que cerramos nosotros (abandonado, sustituido, cambio de
    // método, pedido cancelado) no vuelve a abrirse porque la pasarela diga
    // que sigue pendiente. La tabla permite FAILED → PENDING para reintentos,
    // pero reabrirlo así le devolvía al pedido un `paymentStatus` de pago en
    // línea —aunque ya fuera en efectivo— y chocaba con el intento vigente en
    // el índice de "uno abierto por pedido". Si al final se aprueba,
    // FAILED → PAID sigue entrando y `onCaptured` decide.
    if (payment.status === PaymentStatus.FAILED && nextStatus === PaymentStatus.PENDING) {
      const order = await this.orderOf(payment);
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
      const order = await this.orderOf(payment);
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
      const order = await this.orderOf(payment);
      return { order, changed: false };
    }

    // Aviso en vivo a la pantalla de espera de la app. Va aquí, después del
    // reclamo atómico, porque este es el único punto por el que pasan tanto
    // el webhook como `sync` y solo quien gana la carrera llega: un cambio,
    // un aviso. El polling de la app queda de respaldo, no de mecanismo.
    emitToUser(claimed.userId.toString(), 'payment:updated', {
      orderId: claimed.orderId?.toString() ?? null,
      reference: claimed.reference,
      status: toClientStatus(nextStatus),
      declineReason: nextStatus === PaymentStatus.FAILED ? meta?.message : undefined,
    });

    // ── Cobros que no son de un pedido ──
    //
    // La membresía se desvía aquí, después del reclamo atómico y antes de
    // todo lo que da por supuesto que hay un pedido detrás. Pasa por el
    // mismo embudo a propósito: la tabla de transiciones, la comprobación
    // de importe y moneda, la idempotencia frente a un webhook repetido y
    // la carrera con `sync()` son exactamente las mismas preguntas, y
    // resolverlas por segunda vez en otro archivo sería resolverlas peor.
    if (claimed.type === PaymentType.PRO_SUBSCRIPTION) {
      await proService.settlePayment(claimed, nextStatus);
      return { order: null, changed: true };
    }

    const order = await this.orderOf(claimed);
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

    // El cliente cambió a efectivo mientras este intento seguía abierto en la
    // pasarela, y el banco lo aprobó tarde. Dar ese cobro por bueno dejaría
    // el pedido PAID con el dinero ya recibido en línea y el repartidor
    // cobrándolo otra vez en la puerta: dos cobros por un pedido.
    const methodChanged = order.paymentMethod !== PaymentMethod.ONLINE;

    // Otro intento del mismo pedido ya entró. Pasa cuando alguien abandona
    // la verificación del banco, paga con otro método y el banco aprueba el
    // primero de todas formas. Sin esto, el segundo cobro se asentaba en el
    // libro como un ingreso más —mismo importe, otra referencia— y nadie lo
    // habría visto: dinero cobrado dos veces por un solo pedido.
    const alreadyPaid = Boolean(
      await Payment.exists({
        orderId: order._id,
        _id: { $ne: payment._id },
        type: PaymentType.ORDER_PAYMENT,
        status: PaymentStatus.PAID,
        'metadata.requiresReview': { $ne: true },
      })
    );

    if (shortPaid || orderClosed || alreadyPaid || methodChanged) {
      const reason = orderClosed
        ? 'Se cobró un pedido que ya estaba cancelado o reembolsado'
        : methodChanged
          ? 'Se cobró en línea un pedido que el cliente ya cambió a otro método de pago'
          : alreadyPaid
          ? 'Se cobró dos veces el mismo pedido: ya estaba pagado con otro intento'
          : `Se cobró ${payment.amount} por un pedido que cuesta ${orderTotal}`;

      console.error('[PAYMENTS] Cobro que no puede darse por bueno', {
        key,
        paymentId: payment._id.toString(),
        orderId: order._id.toString(),
        paidAmount: payment.amount,
        orderTotal,
        orderStatus: order.status,
      });

      await this.holdForReview(order, payment, reason);

      // El pago queda PAID —el dinero entró— pero el pedido no avanza y
      // nada se libera. Queda dinero cobrado con un pedido sin cerrar, que
      // es visible y reparable; lo contrario es invisible y no lo es.
      return { order, changed: true };
    }

    // El dinero cubre el pedido y el pedido sigue vivo: se cierra el cobro.
    //
    // Las condiciones que hicieron válido el cobro viajan dentro de la
    // escritura: si entre la lectura de arriba y este punto el pedido se
    // canceló (o cambió de método), no se marca PAID. Sin esto, cobro y
    // cancelación a la vez dejaban un pedido cancelado con el dinero dentro,
    // sin reembolso y con los payouts liberados.
    const closedNow = await Order.updateOne(
      {
        _id: order._id,
        status: { $ne: OrderStatus.CANCELLED },
        paymentMethod: PaymentMethod.ONLINE,
        paymentStatus: { $ne: PaymentStatus.REFUNDED },
      },
      { $set: { paymentStatus: PaymentStatus.PAID } }
    );
    if (closedNow.matchedCount === 0) {
      await this.holdForReview(
        order,
        payment,
        'El pedido se cerró o cambió de método mientras entraba el cobro'
      );
      return { order, changed: true };
    }
    order.paymentStatus = PaymentStatus.PAID;

    await this.finishCapture(order, payment, key);
    return { order, changed: true };
  }

  /**
   * Lo que sigue a un pedido ya marcado PAID: asiento del cobro, liberación
   * de lo que se le debe al comercio y al domiciliario, y el aviso.
   *
   * Separado de `onCaptured` para poder repetirse. Antes vivía al final de
   * ese método, detrás del reclamo atómico del `Payment`: si algo fallaba
   * aquí (un corte de Mongo, un reinicio a mitad de despliegue), el
   * reintento de Wompi encontraba el pago ya PAID, lo daba por procesado y
   * nadie volvía a escribir el asiento ni a liberar los pagos. Cada paso es
   * idempotente —el asiento por referencia, la liberación solo mueve lo que
   * sigue ACCRUED—, así que repetirlo no duplica nada. La marca
   * `metadata.captureSettledAt` dice que ya no queda nada por hacer.
   */
  private async finishCapture(order: IOrder, payment: IPayment, key: string): Promise<void> {
    // Imported lazily: the ledger and payout services import models that
    // import this module, and a static cycle would leave one side undefined.
    const { ledgerService } = await import('../ledger.service');
    const { payoutService } = await import('../payout.service');

    const { pricingConfigService } = await import('../pricingConfig.service');
    const { estimateGatewayFee } = await import('../../utils/gatewayFee');
    const processingFee = estimateGatewayFee(
      await pricingConfigService.getCurrent(),
      payment.paymentMethodType,
      payment.amount
    );

    await ledgerService.recordPaymentCaptured({
      orderId: order._id,
      amount: payment.amount,
      processingFee,
      pricingConfigVersion: order.finance?.pricingConfigVersion ?? 0,
      transactionId: payment.transactionId ?? key,
      currency: order.finance?.currency,
    });

    // The money is ours, so what we owe becomes payable.
    await payoutService.release(order._id);

    await Payment.updateOne(
      { _id: payment._id },
      { $set: { 'metadata.captureSettledAt': new Date().toISOString() } }
    );

    // El comercio se entera ahora que el dinero entró, no al crear el pedido.
    // Va después del libro y de los payouts y sin esperar: así el aviso no
    // alarga el hueco entre marcar PAID y asentar el cobro. Si falla, el
    // pedido aparece igual al refrescar (lo decide `paymentStatus`, no el
    // socket), y si nadie lo acepta salta la alerta de pedido sin aceptar.
    import('../order.service')
      .then(({ orderService }) => orderService.announceToBusiness(order._id.toString()))
      .catch((err) =>
        console.error('[PAYMENTS] No se pudo anunciar el pedido al comercio', { orderId: order._id.toString(), err })
      );

    // ── El mandado empieza a buscar domiciliario aquí ──
    //
    // Un pedido normal arranca la búsqueda cuando el comercio lo marca
    // listo. Un mandado no tiene comercio que lo marque, así que el
    // disparador es el cobro — y tiene que serlo: mandar a alguien a
    // adelantar $50.000 de su bolsillo por un pedido que todavía no está
    // pagado sería ponerle su dinero a jugar por nosotros.
    //
    // `!order.dispatch`: solo si la búsqueda nunca arrancó. `startDispatch`
    // la reinicia desde cero, y una reanudación no debe borrar las rondas ya
    // ofrecidas.
    if (order.kind === OrderKind.ERRAND && !order.driverId && !order.dispatch) {
      import('../dispatch.service')
        .then(({ startDispatch }) => startDispatch(order._id.toString()))
        .catch((err) => console.error('[Errand] No se pudo iniciar el reparto:', err));
    }
  }

  /**
   * Termina un cobro aprobado que quedó a medias.
   *
   * El `Payment` pasa a PAID con un reclamo atómico y todo lo demás va
   * después. Si el proceso cae entre medias, el pago dice PAID y el resto
   * no ocurrió: el pedido sin marcar (el comercio nunca lo ve) o el asiento
   * y los pagos sin liberar. Esto lo retoma desde donde quedó. Lo llaman el
   * reintento del webhook, la consulta de estado y el barrido.
   *
   * Un candado corto en la fila evita que dos de ellos lo hagan a la vez.
   */
  async resumeCapture(paymentId: string, key?: string): Promise<boolean> {
    const now = new Date();
    const payment = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        type: PaymentType.ORDER_PAYMENT,
        method: PaymentMethod.ONLINE,
        status: PaymentStatus.PAID,
        'metadata.captureSettledAt': { $exists: false },
        'metadata.requiresReview': { $ne: true },
        $or: [
          { 'metadata.captureResumeLockUntil': { $exists: false } },
          { 'metadata.captureResumeLockUntil': { $lt: now.toISOString() } },
        ],
      },
      { $set: { 'metadata.captureResumeLockUntil': new Date(now.getTime() + 60_000).toISOString() } },
      { new: true }
    );
    if (!payment) return false;

    const releaseLock = () =>
      Payment.updateOne({ _id: payment._id }, { $unset: { 'metadata.captureResumeLockUntil': '' } });

    try {
      const order = await this.orderOf(payment);
      if (!order) {
        await releaseLock();
        return false;
      }
      const lookup = key ?? payment.transactionId ?? payment.reference ?? '';

      // El pedido todavía no refleja el cobro: se repite el juicio completo
      // (monto, pedido cerrado, cambio de método, doble cobro) desde cero.
      if (order.paymentStatus !== PaymentStatus.PAID && order.paymentStatus !== PaymentStatus.REFUNDED) {
        await this.onCaptured(order, payment, lookup);
        await releaseLock();
        return true;
      }

      // Reembolsado o cancelado: esas cuentas ya las deshizo quien canceló.
      if (order.paymentStatus === PaymentStatus.REFUNDED || order.status === OrderStatus.CANCELLED) {
        await Payment.updateOne(
          { _id: payment._id },
          {
            $set: { 'metadata.captureSettledAt': now.toISOString() },
            $unset: { 'metadata.captureResumeLockUntil': '' },
          }
        );
        return true;
      }

      // El pedido dice PAID. Si lo pagó *otro* intento anterior, este es un
      // segundo cobro que cayó antes de poder marcarse: se retiene igual que
      // lo habría retenido `onCaptured`, y nunca se asienta como ingreso.
      const other = await Payment.findOne({
        orderId: order._id,
        _id: { $ne: payment._id },
        type: PaymentType.ORDER_PAYMENT,
        status: PaymentStatus.PAID,
        'metadata.requiresReview': { $ne: true },
      }).sort({ processedAt: 1, _id: 1 });
      const otherIsFirst =
        other &&
        ((other.processedAt?.getTime() ?? 0) < (payment.processedAt?.getTime() ?? 0) ||
          ((other.processedAt?.getTime() ?? 0) === (payment.processedAt?.getTime() ?? 0) &&
            other._id.toString() < payment._id.toString()));
      if (otherIsFirst) {
        await this.holdForReview(
          order,
          payment,
          'Se cobró dos veces el mismo pedido: ya estaba pagado con otro intento'
        );
        await releaseLock();
        return true;
      }

      await this.finishCapture(order, payment, lookup);
      await releaseLock();
      return true;
    } catch (error) {
      await releaseLock().catch(() => undefined);
      throw error;
    }
  }

  /** Marca un cobro para que una persona lo revise y deja constancia. */
  private async holdForReview(order: IOrder, payment: IPayment, reason: string): Promise<void> {
    const orderTotal = order.finance?.customerTotal ?? order.total;
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { 'metadata.requiresReview': true, 'metadata.reviewReason': reason, 'metadata.reviewOpenedAt': new Date().toISOString() } }
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

    // A la bandeja del centro de incidentes: sin esto el cobro solo quedaba
    // en la bitácora y nadie lo trabajaba.
    import('../alerts.service')
      .then(({ notifyAlertsChanged }) => notifyAlertsChanged('payment_review'))
      .catch(() => undefined);
  }

  /**
   * Una persona de Finanzas cierra un cobro retenido: lo reembolsó por
   * fuera, lo aplicó a mano, o comprobó que no había nada que hacer. Solo
   * deja constancia; no mueve dinero (eso va por los reembolsos).
   */
  async resolveReview(input: { paymentId: string; adminId: string; note: string }): Promise<IPayment> {
    const resolved = await Payment.findOneAndUpdate(
      {
        _id: input.paymentId,
        'metadata.requiresReview': true,
        'metadata.reviewResolvedAt': { $exists: false },
      },
      {
        $set: {
          'metadata.reviewResolvedAt': new Date().toISOString(),
          'metadata.reviewResolvedBy': input.adminId,
          'metadata.reviewResolution': input.note,
        },
      },
      { new: true }
    );
    if (!resolved) {
      throw new AppError('No hay un cobro pendiente de revisión con ese identificador', 404);
    }
    import('../alerts.service')
      .then(({ notifyAlertsChanged }) => notifyAlertsChanged('payment_review'))
      .catch(() => undefined);
    return resolved;
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

  // ── Código de un solo uso (DaviPlata) ───────────────────────────────

  /**
   * El cobro sobre el que se puede pedir o validar un código.
   *
   * Un pago ajeno y uno inexistente responden lo mismo, igual que en
   * `PaymentController.status`: distinguirlos convierte el endpoint en un
   * oráculo con el que sondear referencias que no se tienen.
   */
  private async otpPayment(userId: string, key: string): Promise<IPayment> {
    const notFound = new AppError('Pago no encontrado', 404);

    const payment = await Payment.findOne({ $or: [{ transactionId: key }, { reference: key }] });
    if (!payment) throw notFound;
    if (payment.userId.toString() !== userId) throw notFound;
    if (payment.method !== PaymentMethod.ONLINE) throw notFound;

    // Un cobro ya resuelto no admite otro código. Sin esto, alguien con la
    // referencia de un pago fallido podría seguir pidiéndole códigos a
    // DaviPlata indefinidamente, a costa del comercio.
    if (payment.status !== PaymentStatus.PENDING) {
      throw new AppError('Este cobro ya se resolvió', 409, 'PAYMENT_NOT_PENDING');
    }

    if (payment.paymentMethodType !== 'DAVIPLATA') {
      throw new AppError('Este cobro no se confirma con un código', 409, 'OTP_NOT_APPLICABLE');
    }

    // La referencia es nuestra; el servicio de código es de la pasarela y
    // solo existe cuando ella ya abrió la transacción.
    if (!payment.transactionId || payment.transactionId === payment.reference) {
      throw new AppError('El cobro todavía no está listo', 409, 'PAYMENT_NOT_READY');
    }

    return payment;
  }

  /** Vuelve a pedirle a la pasarela que le mande el código a quien paga. */
  async resendOtp(input: { userId: string; transactionId: string }): Promise<{
    attempts?: OtpAttempts;
  }> {
    const provider = getPaymentProvider();
    if (!provider.resendOtp) {
      throw new AppError('Esta pasarela no reenvía códigos', 501, 'NOT_IMPLEMENTED');
    }

    const payment = await this.otpPayment(input.userId, input.transactionId);
    const attempts = await this.callOtp(payment, () => provider.resendOtp!(payment.transactionId!));

    return { attempts };
  }

  /**
   * Llama a un servicio de código y traduce lo que salga mal.
   *
   * Un "no" de la pasarela (`OtpRejectedError`) es un 422 con un mensaje que
   * la persona pueda entender, y antes se resincroniza el cobro: si Wompi lo
   * dio por terminado, el pedido tiene que enterarse ahora y no en el
   * próximo barrido. Un fallo de red es un 502: la pasarela no contestó, y
   * eso no es lo mismo que decir que no.
   */
  private async callOtp<T>(payment: IPayment, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof OtpRejectedError) {
        await this.sync(payment.transactionId!).catch(() => undefined);
        const message =
          error.reason === 'exhausted'
            ? 'Se agotaron los intentos con el código de DaviPlata. Este cobro se cancela solo en unos minutos; después puedes pagar con otro método.'
            : error.reason === 'expired'
              ? 'El código de DaviPlata venció. Este cobro se cancela solo en unos minutos; después puedes volver a intentarlo.'
              : 'DaviPlata ya cerró este cobro. Revisa el resultado en tu pedido.';
        throw new AppError(message, 422, 'OTP_REJECTED');
      }
      console.error('[PAYMENTS] Falló el servicio de código de la pasarela', {
        paymentId: payment._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError('No pudimos comunicarnos con DaviPlata. Intenta de nuevo.', 502, 'GATEWAY_ERROR');
    }
  }

  /**
   * Entrega el código que escribió quien paga.
   *
   * El resultado **no** se escribe aquí: se pasa por `applyGatewayStatus`,
   * el mismo camino del webhook y del polling, con su reclamo atómico. Un
   * código validado no puede ser una segunda puerta para marcar un pedido
   * como pagado; si lo fuera, habría dos sitios que mueven dinero y solo uno
   * comprueba el importe.
   */
  async validateOtp(input: { userId: string; transactionId: string; code: string }): Promise<{
    accepted: boolean;
    attempts?: OtpAttempts;
    intent: PaymentIntent;
  }> {
    const provider = getPaymentProvider();
    if (!provider.validateOtp) {
      throw new AppError('Esta pasarela no valida códigos', 501, 'NOT_IMPLEMENTED');
    }

    const payment = await this.otpPayment(input.userId, input.transactionId);
    const outcome = await this.callOtp(payment, () =>
      provider.validateOtp!(payment.transactionId!, input.code)
    );

    await this.applyGatewayStatus(
      payment.transactionId!,
      outcome.intent.status,
      outcome.intent.amount,
      {
        gatewayTransactionId: outcome.intent.id,
        currency: outcome.intent.currency,
        message: outcome.intent.declineReason,
        paymentMethodType: outcome.intent.paymentMethodType,
        rawStatus: outcome.intent.rawStatus,
        source: 'sync',
      }
    );

    return { accepted: outcome.accepted, attempts: outcome.attempts, intent: outcome.intent };
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

// ── Barrido de cobros en el aire ──────────────────────────────────────
//
// Un cobro asíncrono —Bancolombia, DaviPlata, PSE, Nequi— puede quedarse
// `PENDING` para siempre: basta que el webhook no llegue y que quien paga
// cierre la app antes de que el polling vea el desenlace. El dinero está en
// la pasarela y el pedido sigue sin aceptarse.
//
// Esto lo cierra preguntando. **Solo consulta**: nunca inventa un estado
// terminal. Inventarlo sería peor que el problema — un cobro real marcado
// como fallido deja dinero cobrado sin pedido detrás.

/** Cuánto se le da a un cobro antes de preguntar por él. */
const PENDING_SWEEP_MIN_AGE_MS = 2 * 60_000;

/**
 * A partir de aquí se deja de preguntar.
 *
 * Sin este tope, una fila que la pasarela ya no reconoce se consultaría cada
 * cinco minutos hasta el fin de los tiempos.
 */
const PENDING_SWEEP_MAX_AGE_MS = 24 * 60 * 60_000;

/** Cuántas filas por pasada. Acotado: cada una es una llamada a la pasarela. */
const PENDING_SWEEP_BATCH = 100;

let pendingSweepTimer: ReturnType<typeof setInterval> | null = null;

export async function sweepPendingPayments(now = new Date()): Promise<{
  checked: number;
  failed: number;
}> {
  const rows = await Payment.find({
    status: PaymentStatus.PENDING,
    method: PaymentMethod.ONLINE,
    updatedAt: {
      $lt: new Date(now.getTime() - PENDING_SWEEP_MIN_AGE_MS),
      $gt: new Date(now.getTime() - PENDING_SWEEP_MAX_AGE_MS),
    },
    transactionId: { $exists: true, $ne: null },
    // La referencia es nuestra; mientras `transactionId` siga siendo la
    // referencia, la pasarela no tiene ninguna transacción que consultar.
    $expr: { $ne: ['$transactionId', '$reference'] },
  })
    .sort({ updatedAt: 1 })
    .limit(PENDING_SWEEP_BATCH);

  let checked = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await paymentService.sync(row.transactionId!);
      checked += 1;
    } catch (error) {
      // Una pasarela caída no debe tumbar el barrido entero: la fila se
      // vuelve a mirar en la pasada siguiente.
      failed += 1;
      console.error('[PAYMENTS] El barrido no pudo consultar un cobro', {
        paymentId: row._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Cobros cuya creación se cortó por la red sin saber si Wompi los creó.
  // No tienen id de la pasarela que consultar, así que se buscan por
  // referencia (ver `PaymentService.onCreationError`).
  const uncertain = await Payment.find({
    status: PaymentStatus.PENDING,
    method: PaymentMethod.ONLINE,
    'metadata.creationUncertain': true,
    updatedAt: { $gt: new Date(now.getTime() - PENDING_SWEEP_MAX_AGE_MS) },
  })
    .select('_id')
    .limit(PENDING_SWEEP_BATCH);

  for (const row of uncertain) {
    try {
      await paymentService.resolveUncertainCreation(row._id.toString());
      checked += 1;
    } catch (error) {
      failed += 1;
      console.error('[PAYMENTS] El barrido no pudo resolver un cobro en duda', {
        paymentId: row._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { checked, failed };
}

/**
 * Cobros aprobados que quedaron a medias (ver `resumeCapture`).
 *
 * El webhook repetido y la consulta de estado ya los retoman, pero Wompi
 * deja de reintentar en algún momento y la app puede no volver a preguntar.
 * Se mira hacia atrás una semana: lo bastante para cubrir una caída larga, y
 * acotado para no recorrer el histórico entero en cada pasada.
 */
const UNSETTLED_CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export async function sweepUnsettledCaptures(now = new Date()): Promise<{
  resumed: number;
  failed: number;
}> {
  const rows = await Payment.find({
    type: PaymentType.ORDER_PAYMENT,
    method: PaymentMethod.ONLINE,
    status: PaymentStatus.PAID,
    'metadata.captureSettledAt': { $exists: false },
    'metadata.requiresReview': { $ne: true },
    processedAt: {
      $lt: new Date(now.getTime() - PENDING_SWEEP_MIN_AGE_MS),
      $gt: new Date(now.getTime() - UNSETTLED_CAPTURE_MAX_AGE_MS),
    },
  })
    .select('_id')
    .sort({ processedAt: 1 })
    .limit(PENDING_SWEEP_BATCH);

  let resumed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await paymentService.resumeCapture(row._id.toString())) resumed += 1;
    } catch (error) {
      failed += 1;
      console.error('[PAYMENTS] No se pudo terminar un cobro aprobado', {
        paymentId: row._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { resumed, failed };
}

export function startPendingPaymentSweeper(intervalMs = 5 * 60_000): void {
  if (pendingSweepTimer) return;
  pendingSweepTimer = setInterval(() => {
    sweepUnsettledCaptures()
      .catch((err) => console.error('[PAYMENTS] Falló el barrido de cobros a medias:', err))
      .then(() => sweepPendingPayments())
      // Primero se le pregunta a la pasarela y solo después se cierra lo que
      // sigue sin pagar: así un cobro que sí entró no se cancela.
      .then(() => import('../order.service'))
      .then(({ orderService }) => orderService.cancelAbandonedOnlineOrders())
      .catch((err) => console.error('[PAYMENTS] Falló el barrido de cobros pendientes:', err));
  }, intervalMs);
  // Que un temporizador de fondo no impida cerrar el proceso.
  pendingSweepTimer.unref?.();
}

export function stopPendingPaymentSweeper(): void {
  if (!pendingSweepTimer) return;
  clearInterval(pendingSweepTimer);
  pendingSweepTimer = null;
}
