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
import { PaymentType, PaymentStatus, PaymentMethod, OrderStatus } from '../../types';
import { AuditAction, AuditSeverity, logSystemAudit } from '../../security';
import { PaymentProvider, PaymentIntent, PaymentIntentStatus } from './provider';
import { SandboxPaymentProvider } from './sandbox.provider';
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
  amount: number;
  description: string;
  customer: { name: string; phone?: string; email?: string };
  redirectUrl?: string;
  /** Client-supplied key so a retried checkout reuses the same intent. */
  idempotencyKey?: string;
}

interface GatewayStatusMeta {
  /** The gateway's own transaction id, when it differs from the lookup key. */
  gatewayTransactionId?: string;
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

    // A retried checkout must not create a second charge.
    const existing = await Payment.findOne({
      orderId: input.orderId,
      status: { $in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
    });

    // Reusing a pending attempt is only safe while it is for the same money.
    // If the order's total moved since, the old reference is bound — through
    // Wompi's integrity signature — to an amount we would no longer accept:
    // its webhook would fail the amount check and the payment would be lost.
    // A changed total therefore gets a brand-new reference, and the row's
    // amount is re-synced so the local record always matches what was signed.
    const amountUnchanged = !existing || existing.amount === amount;

    if (existing?.transactionId && amountUnchanged) {
      try {
        const intent = await provider.getPayment(existing.transactionId);
        return { intent, paymentId: existing._id.toString() };
      } catch {
        // The gateway has no record yet — e.g. a Wompi Web Checkout the
        // customer never opened or completed. Fall through and rebuild the
        // same intent instead of failing the retry.
      }
    }

    const reference =
      (amountUnchanged && existing?.reference) || generatePaymentReference(input.orderId);

    const intent = await provider.createPayment({
      orderId: input.orderId,
      userId: input.userId,
      amount,
      currency: config.payments.currency,
      description: input.description,
      customer: input.customer,
      redirectUrl: input.redirectUrl,
      reference,
    });

    const payment: IPayment = existing
      ? Object.assign(existing, {
          reference,
          transactionId: intent.id,
          // Kept in lockstep with what the gateway was actually asked to
          // charge. Leaving the old figure here is what made a re-priced
          // retry fail its own webhook's amount check.
          amount,
          metadata: {
            ...(existing.metadata ?? {}),
            ...(amountUnchanged
              ? {}
              : {
                  supersededReference: existing.reference,
                  supersededAmount: existing.amount,
                  supersededAt: new Date().toISOString(),
                }),
          },
        })
      : new Payment({
          orderId: input.orderId,
          userId: input.userId,
          type: PaymentType.ORDER_PAYMENT,
          method: PaymentMethod.ONLINE,
          status: PaymentStatus.PENDING,
          amount,
          currency: config.payments.currency,
          reference,
          transactionId: intent.id,
        });

    if (!existing) {
      payment.statusHistory.push({
        status: PaymentStatus.PENDING,
        gatewayStatus: intent.status,
        source: 'create',
        at: new Date(),
      });
    }
    await payment.save();

    // Synchronous providers can already be terminal. Route it through the
    // same authority the webhook uses rather than special-casing it.
    if (intent.status === 'approved' || intent.status === 'declined') {
      await this.applyGatewayStatus(intent.id, intent.status, intent.amount, { source: 'create' });
    }

    return { intent, paymentId: payment._id.toString() };
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

    const gatewayStatus = meta?.rawStatus ?? status;

    payment.statusHistory.push({
      status: nextStatus,
      gatewayStatus,
      message: meta?.message,
      source: meta?.source ?? 'webhook',
      at: new Date(),
    });
    payment.status = nextStatus;
    payment.gatewayStatus = gatewayStatus;
    if (meta?.message) payment.statusMessage = meta.message;
    if (meta?.paymentMethodType) payment.method = meta.paymentMethodType;
    // Upgrades the placeholder (our reference) to the gateway's real id,
    // once it exists — harmless no-op for providers that had it from the start.
    if (meta?.gatewayTransactionId) payment.transactionId = meta.gatewayTransactionId;
    payment.processedAt = nextStatus === PaymentStatus.PAID ? new Date() : payment.processedAt;
    await payment.save();

    const order = await Order.findById(payment.orderId);
    if (!order) return { order: null, changed: true };

    order.paymentStatus = nextStatus;
    await order.save();

    // Imported lazily: the ledger and payout services import models that
    // import this module, and a static cycle would leave one side undefined.
    if (nextStatus === PaymentStatus.PAID) {
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
  ): Promise<{ accepted: boolean; duplicated: boolean; reason?: string }> {
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

    const event = provider.parseWebhook(payload);
    if (!event) {
      return { accepted: false, duplicated: false, reason: 'evento no reconocido' };
    }

    const body = payload as Record<string, unknown>;
    const eventKey =
      typeof body.eventId === 'string' && body.eventId
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

      payment.statusHistory.push({
        status: PaymentStatus.CASH_RECEIVED,
        source: 'cash',
        message: input.note?.slice(0, 200) || 'El domiciliario recibió el efectivo',
        at: now,
      });
      payment.statusHistory.push({
        status: PaymentStatus.PAID,
        source: 'cash',
        message: 'Cobro en efectivo completado',
        at: now,
      });
      payment.status = PaymentStatus.PAID;
      payment.processedAt = now;
      payment.statusMessage = 'Cobrado en efectivo por el domiciliario';
    } else {
      if (!canTransitionPayment(previousStatus, PaymentStatus.CASH_NOT_RECEIVED)) {
        throw new AppError(
          `No se puede reportar un faltante desde el estado "${previousStatus}"`,
          409
        );
      }

      payment.statusHistory.push({
        status: PaymentStatus.CASH_NOT_RECEIVED,
        source: 'cash',
        message: input.note?.slice(0, 200) || 'El domiciliario no recibió el efectivo',
        at: now,
      });
      payment.status = PaymentStatus.CASH_NOT_RECEIVED;
      payment.statusMessage = 'Efectivo no recibido: pendiente de revisión';
    }

    await payment.save();

    order.paymentStatus = payment.status;
    await order.save();

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
    for (const payment of open) {
      payment.statusHistory.push({
        status: PaymentStatus.FAILED,
        source: 'admin',
        message: reason,
        at: now,
      });
      payment.status = PaymentStatus.FAILED;
      payment.statusMessage = reason;
      payment.metadata = {
        ...(payment.metadata ?? {}),
        voidedReason: reason,
        voidedAt: now.toISOString(),
      };
      await payment.save();
    }

    return { voided: open.length };
  }
}

export const paymentService = new PaymentService();
