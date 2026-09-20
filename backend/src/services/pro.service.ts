import { Types } from 'mongoose';
import {
  ProSubscription,
  IProSubscription,
  ProSubscriptionStatus,
  isProActive,
  IPayment,
  SavedCard,
  User,
} from '../models';
import { AppError } from '../middlewares';
import { PaymentStatus } from '../types';
import {
  PRO_PLAN,
  ProPlan,
  PRO_RENEWAL_MAX_ATTEMPTS,
  PRO_RENEWAL_RETRY_HOURS,
  PRO_RENEWAL_LEAD_HOURS,
} from '../config/pro';
import { emitToUser } from '../sockets/emitter';
import { paymentService, type ClientInstrument, type PaymentIntent } from './payments';

/**
 * Zipp Pro: la membresía, de la venta al cobro mensual.
 *
 * Dos ideas sostienen todo lo demás:
 *
 *  1. **Ser Pro es una fecha, no un estado.** Mientras `currentPeriodEnd`
 *     esté en el futuro hay beneficios, aunque la persona haya cancelado:
 *     lo pagó. `isProActive` es la única definición, y la comparten el
 *     motor de precios y la pantalla.
 *  2. **El dinero no se decide aquí.** Esta clase pide el cobro y espera;
 *     quien dice si entró es Wompi, a través de `applyGatewayStatus`, que
 *     termina llamando a `settlePayment`. Activar la membresía en cuanto
 *     la app pulsa el botón sería regalarla.
 */

/** Lo que el motor de precios necesita saber para aplicar el trato. */
export interface ProBenefitsSnapshot {
  freeDelivery: boolean;
  freeDeliveryMinSubtotal: number;
  serviceFeeWaived: boolean;
}

export interface ProStatusView {
  /** Si hoy tiene beneficios. Es lo único que la pantalla necesita mirar. */
  member: boolean;
  status: ProSubscriptionStatus | 'none';
  plan: ProPlan;
  /** La primera vez que fue Pro; no se mueve al renovar. */
  since: Date | null;
  /** Hasta cuándo está pagado. Con `autoRenew`, también cuándo se cobra. */
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  /** Con qué tarjeta se renueva, para poder enseñarla y cambiarla. */
  card: { brand: string; lastFour: string } | null;
}

export interface SubscribeInput {
  userId: string;
  /**
   * Solo tarjeta —nueva guardada o ya guardada—. Nequi y PSE cobran una vez
   * y no se pueden volver a cobrar el mes que viene, así que aceptarlos
   * sería vender una suscripción que no puede renovarse.
   */
  instrument: Extract<ClientInstrument, { kind: 'card_token' } | { kind: 'saved_card' }>;
  acceptanceToken: string;
  personalDataAuthToken?: string;
  browserInfo?: Record<string, string>;
  /** Solo si la cuenta no tiene correo (registro por teléfono). */
  customerEmail?: string;
}

export class ProService {
  plan(): ProPlan {
    return PRO_PLAN;
  }

  /** La suscripción de esta persona, exista o no. */
  private find(userId: string): Promise<IProSubscription | null> {
    return ProSubscription.findOne({ userId });
  }

  async statusOf(userId: string): Promise<ProStatusView> {
    const sub = await this.find(userId);
    const member = isProActive(sub);

    let card: ProStatusView['card'] = null;
    if (sub?.savedCardId) {
      const saved = await SavedCard.findById(sub.savedCardId);
      if (saved) card = { brand: saved.brand, lastFour: saved.lastFour };
    }

    return {
      member,
      status: sub?.status ?? 'none',
      plan: PRO_PLAN,
      since: sub?.startedAt ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      autoRenew: sub?.autoRenew ?? false,
      card,
    };
  }

  /**
   * Lo que el pedido de esta persona tiene derecho a descontar.
   *
   * `null` cuando no es Pro, y no un objeto con todo apagado: quien llama
   * distingue así "no hay trato" de "hay trato y no alcanza el mínimo", que
   * es lo que permite enseñarle al cliente cuánto le falta.
   */
  async benefitsFor(userId: string): Promise<ProBenefitsSnapshot | null> {
    const sub = await this.find(userId);
    if (!isProActive(sub)) return null;

    const { freeDelivery, serviceFeeWaived } = PRO_PLAN.benefits;
    return {
      freeDelivery: freeDelivery.enabled,
      freeDeliveryMinSubtotal: freeDelivery.minSubtotal,
      serviceFeeWaived: serviceFeeWaived.enabled,
    };
  }

  /**
   * Arranca el cobro de la membresía.
   *
   * Devuelve el intento tal cual lo dejó la pasarela: casi siempre
   * `pending`, a veces con un reto 3D Secure. La membresía **no** se
   * enciende aquí.
   */
  async subscribe(input: SubscribeInput): Promise<{
    intent: PaymentIntent;
    paymentId: string;
    reference: string;
  }> {
    const user = await User.findById(input.userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const existing = await this.find(input.userId);
    if (isProActive(existing)) {
      throw new AppError('Ya tienes Zipp Pro activo', 409, 'PRO_ALREADY_ACTIVE');
    }

    // Una tarjeta nueva tiene que guardarse: el token de Wompi es de un
    // solo uso, así que sin fuente de pago guardada el mes que viene no
    // habría con qué cobrar. Se exige aquí y no se fuerza en silencio,
    // porque guardar una tarjeta necesita el consentimiento de la persona.
    if (input.instrument.kind === 'card_token' && !input.instrument.save) {
      throw new AppError(
        'Para suscribirte hay que guardar la tarjeta: es con la que se renueva cada mes',
        400,
        'PRO_CARD_MUST_BE_SAVED'
      );
    }

    const email = user.email || input.customerEmail;
    if (!email) {
      throw new AppError(
        'Necesitamos un correo para enviarte el comprobante de tu membresía',
        422,
        'EMAIL_REQUIRED'
      );
    }

    const plan = PRO_PLAN;

    // La suscripción existe antes que el cobro, en PENDING: si el webhook
    // llega antes de que esta petición termine —pasa, y con tarjeta pasa en
    // segundos— tiene que encontrar algo que activar.
    const sub = await ProSubscription.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          status: ProSubscriptionStatus.PENDING,
          planId: plan.id,
          price: plan.price,
          currency: plan.currency,
          autoRenew: true,
          renewalFailures: 0,
        },
        $setOnInsert: { userId: new Types.ObjectId(input.userId) },
      },
      { upsert: true, new: true, runValidators: true }
    );

    const result = await paymentService.initiateProNative({
      userId: input.userId,
      amount: plan.price,
      description: `${plan.name} · ${plan.periodDays} días`,
      customer: { name: user.name, phone: user.phone, email },
      instrument: input.instrument,
      acceptanceToken: input.acceptanceToken,
      personalDataAuthToken: input.personalDataAuthToken,
      browserInfo: input.browserInfo,
      metadata: { planId: plan.id, subscriptionId: sub!._id.toString() },
    });

    await ProSubscription.updateOne(
      { _id: sub!._id },
      {
        $set: {
          lastPaymentId: new Types.ObjectId(result.paymentId),
          ...(result.savedCardId ? { savedCardId: new Types.ObjectId(result.savedCardId) } : {}),
        },
      }
    );

    return { intent: result.intent, paymentId: result.paymentId, reference: result.reference };
  }

  /**
   * Las consecuencias de lo que dijo la pasarela sobre un cobro de
   * membresía. La llama `PaymentService.applyGatewayStatus` y solo ella,
   * una vez por transición y después del reclamo atómico.
   */
  async settlePayment(payment: IPayment, status: PaymentStatus): Promise<void> {
    const userId = payment.userId.toString();
    const sub = await this.find(userId);

    if (!sub) {
      // Un cobro de membresía sin membresía que activar. No debería poder
      // pasar —`subscribe` crea el documento antes de cobrar— y si pasa,
      // hay dinero cobrado sin contrapartida: se grita, no se ignora.
      console.error('[PRO] Cobro de membresía sin suscripción asociada', {
        paymentId: payment._id.toString(),
        userId,
      });
      return;
    }

    if (status === PaymentStatus.PAID) {
      await this.activate(sub, payment);
      return;
    }

    if (status !== PaymentStatus.FAILED) return;

    // Un rechazo mientras el periodo pagado sigue vivo es un fallo de
    // renovación: no se toca el acceso, se cuenta el intento y el barrido
    // lo volverá a intentar. Un rechazo sin periodo vivo es sencillamente
    // que no llegó a haber membresía.
    const live = isProActive(sub);
    await ProSubscription.updateOne(
      { _id: sub._id },
      {
        $inc: { renewalFailures: 1 },
        $set: {
          lastRenewalAttemptAt: new Date(),
          ...(live ? {} : { status: ProSubscriptionStatus.EXPIRED }),
        },
      }
    );

    emitToUser(userId, 'pro:updated', { member: live });
  }

  /** Enciende (o extiende) la membresía tras un cobro aprobado. */
  private async activate(sub: IProSubscription, payment: IPayment): Promise<void> {
    const now = new Date();

    // Una renovación que llega antes de que venza el periodo actual se
    // encadena a su final, no a hoy: si no, renovar tres días antes
    // regalaría… perdón, *robaría* esos tres días ya pagados.
    const base =
      sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime()
        ? sub.currentPeriodEnd
        : now;

    const end = new Date(base.getTime() + PRO_PLAN.periodDays * 24 * 60 * 60_000);

    await ProSubscription.updateOne(
      { _id: sub._id },
      {
        $set: {
          status: ProSubscriptionStatus.ACTIVE,
          startedAt: sub.startedAt ?? now,
          currentPeriodStart: base,
          currentPeriodEnd: end,
          autoRenew: true,
          renewalFailures: 0,
          lastRenewalAttemptAt: now,
          lastPaymentId: payment._id,
        },
      }
    );

    emitToUser(sub.userId.toString(), 'pro:updated', {
      member: true,
      currentPeriodEnd: end.toISOString(),
    });
  }

  /**
   * Cancela la renovación. **No** quita el acceso: lo que se pagó, se
   * disfruta hasta el final del periodo.
   */
  async cancel(userId: string): Promise<ProStatusView> {
    const sub = await this.find(userId);
    if (!sub || !isProActive(sub)) {
      throw new AppError('No tienes una membresía activa', 404, 'PRO_NOT_ACTIVE');
    }

    await ProSubscription.updateOne(
      { _id: sub._id },
      {
        $set: {
          status: ProSubscriptionStatus.CANCELLED,
          autoRenew: false,
          cancelledAt: new Date(),
        },
      }
    );

    return this.statusOf(userId);
  }

  /** Vuelve a activar la renovación de una membresía aún vigente. */
  async resume(userId: string): Promise<ProStatusView> {
    const sub = await this.find(userId);
    if (!sub || !isProActive(sub)) {
      throw new AppError('No tienes una membresía activa', 404, 'PRO_NOT_ACTIVE');
    }

    await ProSubscription.updateOne(
      { _id: sub._id },
      {
        $set: {
          status: ProSubscriptionStatus.ACTIVE,
          autoRenew: true,
          cancelledAt: null,
          renewalFailures: 0,
        },
      }
    );

    return this.statusOf(userId);
  }

  /**
   * Cobra lo que vence y da por vencido lo que ya no se puede cobrar.
   *
   * Es lo único que mira el reloj en toda la membresía. Devuelve el
   * recuento para poder probarlo sin esperar a que pase una hora.
   */
  async sweepRenewals(now = new Date()): Promise<{ charged: number; expired: number }> {
    const retryBefore = new Date(now.getTime() - PRO_RENEWAL_RETRY_HOURS * 60 * 60_000);
    // Se cobra con antelación para que la membresía no parpadee: ver
    // `PRO_RENEWAL_LEAD_HOURS`.
    const dueBefore = new Date(now.getTime() + PRO_RENEWAL_LEAD_HOURS * 60 * 60_000);

    const due = await ProSubscription.find({
      status: ProSubscriptionStatus.ACTIVE,
      autoRenew: true,
      currentPeriodEnd: { $lte: dueBefore },
      savedCardId: { $ne: null },
      renewalFailures: { $lt: PRO_RENEWAL_MAX_ATTEMPTS },
      $or: [{ lastRenewalAttemptAt: null }, { lastRenewalAttemptAt: { $lte: retryBefore } }],
    }).limit(200);

    let charged = 0;
    for (const sub of due) {
      try {
        await this.chargeRenewal(sub);
        charged += 1;
      } catch (error) {
        // Un fallo cobrando a una persona no puede parar la cola. Se anota
        // el intento para que el reintento respete su espera.
        console.error('[PRO] Falló la renovación', {
          userId: sub.userId.toString(),
          error: (error as Error).message,
        });
        await ProSubscription.updateOne(
          { _id: sub._id },
          { $inc: { renewalFailures: 1 }, $set: { lastRenewalAttemptAt: now } }
        );
      }
    }

    // Lo que venció y ya no va a cobrarse: o no renueva, o se agotaron los
    // reintentos, o nunca hubo tarjeta con la que volver a intentarlo.
    const expired = await ProSubscription.updateMany(
      {
        status: { $in: [ProSubscriptionStatus.ACTIVE, ProSubscriptionStatus.CANCELLED] },
        currentPeriodEnd: { $lte: now },
        $or: [
          { autoRenew: false },
          { savedCardId: null },
          { renewalFailures: { $gte: PRO_RENEWAL_MAX_ATTEMPTS } },
        ],
      },
      { $set: { status: ProSubscriptionStatus.EXPIRED } }
    );

    return { charged, expired: expired.modifiedCount };
  }

  /** Un cobro de renovación contra la tarjeta guardada. */
  private async chargeRenewal(sub: IProSubscription): Promise<void> {
    const user = await User.findById(sub.userId);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const email = user.email;
    if (!email) {
      // Sin correo no hay cobro posible en Wompi. Es un dato que la cuenta
      // tenía al suscribirse, así que llegar aquí significa que lo quitó.
      throw new AppError('La cuenta ya no tiene correo para el comprobante', 422);
    }

    // El consentimiento de una renovación no lo da nadie en pantalla: se
    // pide a la pasarela en el momento del cobro, que es lo que Wompi exige
    // en toda transacción.
    const config = await paymentService.getCheckoutConfig();

    await ProSubscription.updateOne(
      { _id: sub._id },
      { $set: { lastRenewalAttemptAt: new Date() } }
    );

    await paymentService.initiateProNative({
      userId: sub.userId.toString(),
      amount: PRO_PLAN.price,
      description: `${PRO_PLAN.name} · renovación`,
      customer: { name: user.name, phone: user.phone, email },
      instrument: { kind: 'saved_card', savedCardId: sub.savedCardId!.toString(), installments: 1 },
      acceptanceToken: config.acceptanceToken,
      metadata: { planId: PRO_PLAN.id, subscriptionId: sub._id.toString(), renewal: true },
    });
  }
}

export const proService = new ProService();

let renewalTimer: NodeJS.Timeout | null = null;

/** Arranca el barrido de renovaciones. Idempotente. */
export function startProRenewalSweeper(intervalMs = 60 * 60_000): void {
  if (renewalTimer) return;
  renewalTimer = setInterval(() => {
    proService
      .sweepRenewals()
      .catch((err) => console.error('[PRO] Falló el barrido de renovaciones:', err));
  }, intervalMs);

  // No debe mantener vivo el proceso por sí solo.
  renewalTimer.unref?.();
}

export function stopProRenewalSweeper(): void {
  if (!renewalTimer) return;
  clearInterval(renewalTimer);
  renewalTimer = null;
}
