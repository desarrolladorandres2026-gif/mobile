import { Request, Response, NextFunction } from 'express';
import { paymentService, isOnlinePaymentAvailable, refundService } from '../services';
import { toClientStatus, nativeCapabilities } from '../services/payments';
import { Order, Payment, toPublicCard } from '../models';
import { AppError } from '../middlewares';
import { sendResponse, param, query, clampLimit } from '../utils';
import { RefundKind, RefundStatus, UserRole } from '../types';
import { AuditAction, AuditSeverity, logAudit, Permission } from '../security';
import { can } from '../middlewares/auth';

export class PaymentController {
  /** Lets checkout know whether to offer online payment at all. */
  async methods(_req: Request, res: Response, next: NextFunction) {
    try {
      const online = isOnlinePaymentAvailable();
      const { pricingConfigService } = await import('../services');
      const config = await pricingConfigService.getCurrent();

      sendResponse(res, 200, 'Métodos de pago', {
        online,
        cashOnDelivery: config.cashOnDeliveryEnabled,
        cashOnDeliveryMaxAmount: config.cashOnDeliveryMaxAmount,
        // Qué se puede cobrar dentro de la app. Con `native` en falso la app
        // usa el Web Checkout de siempre.
        inApp: online ? nativeCapabilities() : { native: false, pse: false, savedCards: false },
      });
    } catch (error) { next(error); }
  }

  /**
   * Llave pública y consentimientos vigentes, para que la app pueda
   * tokenizar la tarjeta contra Wompi por su cuenta.
   *
   * Nada de lo que sale de aquí es secreto —la llave pública está pensada
   * para viajar al dispositivo y los tokens de aceptación son los mismos
   * para todo el comercio—, pero sigue detrás de `authenticate` porque no
   * hay razón para que esto sea también un proxy abierto hacia Wompi.
   */
  async checkoutConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      const data = await paymentService.getCheckoutConfig();
      sendResponse(res, 200, 'Configuración de pago', data);
    } catch (error) { next(error); }
  }

  /** Starts a gateway payment for an order the caller owns. */
  async initiate(req: Request, res: Response, next: NextFunction) {
    try {
      // Solo del parámetro de ruta, que es lo que el esquema valida.
      // `|| req.body.orderId` dejaba entrar un identificador sin validar
      // por un camino que `initiatePaymentSchema` no cubre.
      const orderId = param(req, 'orderId');
      const order = await Order.findById(orderId);

      // Un pedido ajeno responde lo mismo que uno inexistente: un 403
      // confirmaba la existencia del pedido de otra persona.
      if (!order || order.clientId.toString() !== req.user!._id.toString()) {
        throw new AppError('Pedido no encontrado', 404);
      }

      const result = await paymentService.initiate({
        orderId: order._id.toString(),
        userId: req.user!._id.toString(),
        amount: order.finance?.customerTotal ?? order.total,
        description: `Pedido ${order.orderNumber}`,
        customer: {
          name: req.user!.name,
          phone: req.user!.phone,
          email: req.user!.email,
        },
        redirectUrl: req.body.redirectUrl,
      });

      sendResponse(res, 201, 'Pago iniciado', {
        paymentId: result.paymentId,
        transactionId: result.intent.id,
        status: result.intent.status,
        checkoutUrl: result.intent.checkoutUrl,
        declineReason: result.intent.declineReason,
        amount: result.intent.amount,
      });
    } catch (error) { next(error); }
  }

  /**
   * Cobra dentro de la app con un instrumento ya capturado en el
   * dispositivo. La tarjeta llega tokenizada; el esquema rechaza cualquier
   * dato crudo antes de que alcance este punto.
   */
  async payNative(req: Request, res: Response, next: NextFunction) {
    try {
      const orderId = param(req, 'orderId');
      const order = await Order.findById(orderId);

      // Ajeno e inexistente responden igual, como en `initiate`.
      if (!order || order.clientId.toString() !== req.user!._id.toString()) {
        throw new AppError('Pedido no encontrado', 404);
      }

      // El correo de la cuenta manda. `receiptEmail` es el que quedó
      // definido en Mi cuenta la primera vez que se pidió; el del cuerpo es
      // solo el respaldo de esa primera vez, antes de que exista.
      const email = req.user!.email || req.user!.receiptEmail || req.body.customerEmail;
      if (!email) {
        throw new AppError(
          'Necesitamos un correo para enviarte el comprobante del pago',
          422,
          'EMAIL_REQUIRED'
        );
      }

      const result = await paymentService.initiateNative({
        orderId: order._id.toString(),
        userId: req.user!._id.toString(),
        amount: req.body.amount,
        description: `Pedido ${order.orderNumber}`,
        customer: { name: req.user!.name, phone: req.user!.phone, email },
        instrument: req.body.instrument,
        acceptanceToken: req.body.acceptanceToken,
        personalDataAuthToken: req.body.personalDataAuthToken,
        browserInfo: req.body.browserInfo,
      });

      // Forma propia, nunca el `PaymentIntent` entero: `raw` arrastra la
      // transacción de Wompi con datos del medio de pago.
      sendResponse(res, 201, 'Cobro iniciado', {
        paymentId: result.paymentId,
        reference: result.reference,
        transactionId: result.intent.id,
        status: result.intent.status,
        amount: result.intent.amount,
        declineReason: result.intent.declineReason,
        paymentMethodType: result.intent.paymentMethodType,
        asyncPaymentUrl: result.intent.asyncPaymentUrl,
        threeDsChallengeHtml: result.intent.threeDsChallengeHtml,
        // DaviPlata: la pasarela ya le mandó un código a quien paga y espera
        // a que lo escriba. Es un booleano, no la dirección del servicio.
        otpRequired: result.intent.otpRequired,
      });
    } catch (error) { next(error); }
  }

  /**
   * La persona deja a medias la verificación del banco para pagar de otra
   * forma. No anula nada en la pasarela —Wompi no lo permite con un cobro
   * pendiente—: suelta el intento en Zipp, después de preguntarle a Wompi.
   */
  async abandon(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await paymentService.abandonAttempt({
        userId: req.user!._id.toString(),
        transactionId: param(req, 'transactionId'),
      });

      const message =
        result.status === 'approved' ? 'El pago ya estaba aprobado'
        : result.status === 'declined' ? 'El pago ya había terminado sin aprobarse'
        : 'Pago cancelado';

      sendResponse(res, 200, message, result);
    } catch (error) { next(error); }
  }

  // ── Código de un solo uso (DaviPlata) ──
  //
  // Dos endpoints muy pequeños que solo hacen de puente: la dirección del
  // servicio de código y el `Bearer` que la autoriza se quedan en el
  // servidor. Si viajaran al teléfono, cualquiera que leyese el tráfico de
  // la app podría confirmar ese cobro por su cuenta.

  async resendOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await paymentService.resendOtp({
        userId: req.user!._id.toString(),
        transactionId: param(req, 'transactionId'),
      });

      sendResponse(res, 200, 'Te reenviamos el código', result);
    } catch (error) { next(error); }
  }

  async validateOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await paymentService.validateOtp({
        userId: req.user!._id.toString(),
        transactionId: param(req, 'transactionId'),
        code: req.body.code,
      });

      // Forma propia, nunca el `PaymentIntent` entero: `raw` arrastra la
      // transacción de Wompi con datos del medio de pago.
      sendResponse(res, 200, result.accepted ? 'Código verificado' : 'Código incorrecto', {
        accepted: result.accepted,
        attempts: result.attempts,
        status: result.intent.status,
        declineReason: result.intent.declineReason,
      });
    } catch (error) { next(error); }
  }

  async pseBanks(_req: Request, res: Response, next: NextFunction) {
    try {
      const banks = await paymentService.listPseBanks();
      sendResponse(res, 200, 'Bancos PSE', banks);
    } catch (error) { next(error); }
  }


  // ── Tarjetas guardadas ──
  // Siempre sobre `req.user`: ninguna de estas rutas acepta un userId.

  async listCards(req: Request, res: Response, next: NextFunction) {
    try {
      const cards = await paymentService.listCards(req.user!._id.toString());
      sendResponse(res, 200, 'Tarjetas guardadas', cards);
    } catch (error) { next(error); }
  }

  async saveCard(req: Request, res: Response, next: NextFunction) {
    try {
      const email = req.user!.email || req.user!.receiptEmail || req.body.customerEmail;
      if (!email) {
        throw new AppError('Necesitamos un correo para guardar la tarjeta', 422, 'EMAIL_REQUIRED');
      }
      const card = await paymentService.saveCard({
        userId: req.user!._id.toString(),
        token: req.body.token,
        display: req.body.card,
        customerEmail: email,
        acceptanceToken: req.body.acceptanceToken,
        personalDataAuthToken: req.body.personalDataAuthToken,
      });
      sendResponse(res, 201, 'Tarjeta guardada', toPublicCard(card));
    } catch (error) { next(error); }
  }

  async deleteCard(req: Request, res: Response, next: NextFunction) {
    try {
      await paymentService.deleteCard(req.user!._id.toString(), param(req, 'id'));
      sendResponse(res, 200, 'Tarjeta eliminada', null);
    } catch (error) { next(error); }
  }
  /**
   * Gateway callback.
   *
   * Answers 200 for anything successfully handled, duplicates included: a
   * duplicate is not an error, it is the expected behaviour of at-least-once
   * delivery, and a non-2xx would make the gateway retry it forever.
   *
   * The two non-2xx answers are deliberate. An unverifiable signature gets
   * 401 and should never be retried. A failure *while applying* a verified
   * event propagates as 5xx — PaymentService releases its deduplication
   * claim first, so the gateway's retry genuinely reprocesses instead of
   * being waved through as "already handled".
   */
  async webhook(req: Request, res: Response, next: NextFunction) {
    try {
      const signature =
        (req.headers['x-signature'] as string) ||
        (req.headers['x-webhook-signature'] as string) ||
        '';

      // Fail closed. Re-serialising the parsed body was never a real
      // fallback: by this point mongo-sanitize and sanitizeRequest have both
      // rewritten it, and a provider that signs the exact bytes (the sandbox
      // one does) could never verify against it. A missing raw body means
      // the capture in app.ts no longer covers this route — a deployment
      // bug that should be loud, not one that quietly rejects every event
      // as an invalid signature.
      const rawBody = (req as Request & { rawBody?: string }).rawBody;
      if (!rawBody) {
        console.error('[PAYMENTS] Webhook sin cuerpo crudo — revisa WEBHOOK_PATHS en app.ts', {
          path: req.originalUrl,
        });
        throw new AppError('No se pudo verificar la notificación', 500);
      }

      const result = await paymentService.handleWebhook(rawBody, signature);

      if (!result.accepted) {
        return res.status(401).json({ success: false, message: result.reason });
      }

      return res.status(200).json({
        success: true,
        duplicated: result.duplicated,
        // Firma válida pero nada que aplicar (otro tipo de evento de la
        // pasarela). Se responde 200 para que deje de reintentarlo.
        ...(result.ignored ? { ignored: true } : {}),
      });
    } catch (error) { next(error); }
  }

  /**
   * Looks up a payment either by our own reference or by the gateway's
   * transaction id — the mobile app only ever has the reference (handed
   * back from `initiate`), since a redirect-based gateway like Wompi does
   * not assign its own id until the customer completes the checkout.
   */
  async status(req: Request, res: Response, next: NextFunction) {
    try {
      const key = param(req, 'transactionId');
      const payment = await Payment.findOne({ $or: [{ transactionId: key }, { reference: key }] });

      // Un pago ajeno y uno inexistente responden lo mismo, igual que en
      // `resolveOrderAccess`. Distinguirlos convertía este endpoint en un
      // oráculo: un 403 confirmaba que esa referencia existe, y con eso se
      // puede sondear el espacio de referencias sin tener ninguna.
      const notFound = new AppError('Pago no encontrado', 404);
      if (!payment) throw notFound;
      if (
        req.user!.role !== UserRole.ADMIN &&
        payment.userId.toString() !== req.user!._id.toString()
      ) {
        throw notFound;
      }

      // The reference is only upgraded to a real gateway id once a webhook
      // (or a previous sync) has reported one. Before that, the gateway has
      // no record to ask about yet — a pending Web Checkout the customer
      // hasn't finished — so it is answered from the local row instead of
      // calling out and getting a 404.
      const hasGatewayRecord = Boolean(payment.transactionId) && payment.transactionId !== payment.reference;

      if (!hasGatewayRecord) {
        const status = toClientStatus(payment.status);

        return sendResponse(res, 200, 'Estado del pago', {
          id: payment.reference ?? payment.transactionId,
          status,
          amount: payment.amount,
          currency: payment.currency,
          // Nulo en el cobro de la membresía, que no cuelga de ningún
          // pedido. La app lo usa para saber a qué espera cada pantalla.
          orderId: payment.orderId?.toString() ?? null,
          declineReason: payment.statusMessage,
        });
      }

      const intent = await paymentService.sync(payment.transactionId!);

      // Se responde una forma propia y estable, no el `PaymentIntent` entero.
      // Ese objeto arrastra `raw`, que es la transacción tal cual la
      // devuelve la pasarela —datos del cliente, detalle del medio de pago,
      // identificadores internos del comercio— y no hay ninguna razón para
      // que salga de aquí. Además es la misma forma que devuelve la rama de
      // arriba: antes el mismo endpoint contestaba dos estructuras distintas
      // según si la pasarela ya conocía el pago.
      sendResponse(res, 200, 'Estado del pago', {
        id: payment.reference ?? intent.id,
        status: intent.status,
        amount: intent.amount,
        currency: intent.currency,
        orderId: payment.orderId?.toString() ?? null,
        declineReason: intent.declineReason,
        paymentMethodType: intent.paymentMethodType,
        // El reto 3D Secure no llega al crear la transacción: Wompi lo
        // publica después, mientras la app consulta. Viaja aquí para que la
        // pantalla de espera lo abra en cuanto exista. Es HTML del emisor de
        // la tarjeta y la app solo lo pinta dentro de su WebView acotado.
        ...(intent.threeDsChallengeHtml ? { threeDsChallengeHtml: intent.threeDsChallengeHtml } : {}),
        ...(intent.asyncPaymentUrl ? { asyncPaymentUrl: intent.asyncPaymentUrl } : {}),
        ...(intent.otpRequired ? { otpRequired: true } : {}),
      });
    } catch (error) { next(error); }
  }

  async forOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await Order.findById(param(req, 'orderId'));
      if (!order) throw new AppError('Pedido no encontrado', 404);
      if (
        req.user!.role !== UserRole.ADMIN &&
        order.clientId.toString() !== req.user!._id.toString()
      ) {
        // Mismo criterio que en `status`: no se confirma la existencia de
        // un pedido ajeno.
        throw new AppError('Pedido no encontrado', 404);
      }
      // H4: el Payment crudo (metadata, transactionId, reference) es dinero.
      // El panel admin no consume este endpoint, así que sin `finance:view` se niega.
      if (req.user!.role === UserRole.ADMIN && !can(req, Permission.FINANCE_VIEW)) {
        throw new AppError('No tienes permiso para ver los pagos de este pedido', 403);
      }
      const payments = await paymentService.getForOrder(order._id.toString());
      sendResponse(res, 200, 'Pagos del pedido', payments);
    } catch (error) { next(error); }
  }

  // ── Admin ──

  async refund(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await refundService.issue({
        orderId: param(req, 'orderId'),
        amount: req.body.amount,
        reason: req.body.reason || 'Reembolso solicitado por administración',
        kind: req.body.amount ? RefundKind.PARTIAL : RefundKind.FULL,
        requestedBy: req.user!._id.toString(),
        idempotencyKey: req.body.idempotencyKey,
      });
      void logAudit(req, {
        action: AuditAction.REFUND_ISSUED,
        entity: 'order',
        entityId: param(req, 'orderId'),
        severity: AuditSeverity.HIGH,
        description: `Reembolso por pasarela de $${refund.amount.toLocaleString('es-CO')} (${refund.status})`,
        metadata: { refundId: String(refund._id), amount: refund.amount, status: refund.status },
      });
      sendResponse(res, 201, 'Reembolso procesado', refund);
    } catch (error) { next(error); }
  }

  /**
   * Registra un contracargo que la pasarela ya ejecutó.
   *
   * `reference` viene del esquema y es obligatoria: es la clave de
   * idempotencia. Rellenarla con la hora actual cuando faltaba —que es lo
   * que se hacía— convertía cada reintento en un contracargo nuevo por el
   * mismo dinero.
   */
  async chargeback(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await refundService.recordChargeback({
        orderId: param(req, 'orderId'),
        amount: req.body.amount,
        reference: req.body.reference,
      });
      void logAudit(req, {
        action: AuditAction.CHARGEBACK_RECORDED,
        entity: 'order',
        entityId: param(req, 'orderId'),
        severity: AuditSeverity.HIGH,
        description: `Contracargo registrado por $${refund.amount.toLocaleString('es-CO')}, ref. ${req.body.reference}`,
        metadata: { refundId: String(refund._id), reference: req.body.reference, amount: refund.amount },
      });
      sendResponse(res, 201, 'Contracargo registrado', refund);
    } catch (error) { next(error); }
  }

  /** Bandeja de reembolsos y contracargos de toda la plataforma. */
  async listAllRefunds(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await refundService.listAll({
        status: query(req, 'status') as RefundStatus | undefined,
        kind: query(req, 'kind') as RefundKind | undefined,
        attention: query(req, 'attention') === 'true',
        page: Number(query(req, 'page')) || 1,
        limit: clampLimit(query(req, 'limit'), 100, 25),
      });
      sendResponse(res, 200, 'Reembolsos', { items: result.items, totals: result.totals }, result.meta);
    } catch (error) { next(error); }
  }

  /** Cierra un cobro retenido para revisión (centro de incidentes). */
  async resolveReview(req: Request, res: Response, next: NextFunction) {
    try {
      const payment = await paymentService.resolveReview({
        paymentId: param(req, 'paymentId'),
        adminId: req.user!._id.toString(),
        note: req.body.note,
      });
      void logAudit(req, {
        action: AuditAction.PAYMENT_REVIEW_RESOLVED,
        entity: 'payment',
        entityId: payment._id.toString(),
        severity: AuditSeverity.HIGH,
        description: `Cobro retenido de $${payment.amount.toLocaleString('es-CO')} marcado como resuelto`,
        metadata: {
          orderId: payment.orderId?.toString(),
          reviewReason: payment.metadata?.reviewReason,
          note: req.body.note,
        },
      });
      sendResponse(res, 200, 'Cobro marcado como resuelto', {
        paymentId: payment._id.toString(),
        reviewResolvedAt: payment.metadata?.reviewResolvedAt,
      });
    } catch (error) { next(error); }
  }

  async listRefunds(req: Request, res: Response, next: NextFunction) {
    try {
      const refunds = await refundService.listForOrder(param(req, 'orderId'));
      sendResponse(res, 200, 'Reembolsos del pedido', refunds);
    } catch (error) { next(error); }
  }

  /**
   * Reembolso ya hecho por fuera de ZIPP (dashboard de Wompi), porque la
   * pasarela no admite reembolsos parciales por API. No mueve dinero real
   * en la pasarela: solo reparte contablemente y deja auditoría.
   */
  async refundExternal(req: Request, res: Response, next: NextFunction) {
    try {
      const refund = await refundService.issueExternal({
        orderId: param(req, 'orderId'),
        amount: req.body.amount,
        reason: req.body.reason,
        externalReference: req.body.externalReference,
        requestedBy: req.user!._id.toString(),
      });
      void logAudit(req, {
        action: AuditAction.REFUND_ISSUED,
        entity: 'order',
        entityId: param(req, 'orderId'),
        severity: AuditSeverity.HIGH,
        description: `Reembolso externo registrado por $${req.body.amount?.toLocaleString?.('es-CO') ?? req.body.amount}, ref. ${req.body.externalReference}`,
        metadata: { refundId: String(refund._id), externalReference: req.body.externalReference },
      });
      sendResponse(res, 201, 'Reembolso externo registrado', refund);
    } catch (error) { next(error); }
  }
}

export const paymentController = new PaymentController();
