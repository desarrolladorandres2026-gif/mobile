import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import {
  authenticate,
  authorize,
  validate,
  requireFinanceAdmin,
  paymentInitiateRateLimiter,
  paymentStatusRateLimiter,
  paymentWebhookRateLimiter,
  paymentOtpRateLimiter,
} from '../middlewares';
import { refundSchema } from '../validators/finance.validator';
import {
  initiatePaymentSchema,
  payNativeSchema,
  saveCardSchema,
  savedCardParamsSchema,
  paymentStatusSchema,
  otpResendSchema,
  otpValidateSchema,
  orderPaymentsSchema,
  chargebackSchema,
} from '../validators/payment.validator';
import { UserRole } from '../types';

const router = Router();

/**
 * Gateway callback. Unauthenticated by necessity — the provider has no
 * session — and authorised instead by an HMAC signature over the raw body,
 * verified in PaymentService.handleWebhook before anything is read.
 *
 * No body validation here on purpose: the payload's shape is the gateway's
 * to define, and the signature already covers its integrity. The limiter is
 * a ceiling on forged floods, set high enough not to interfere with the
 * gateway's own retries.
 */
router.post('/webhook', paymentWebhookRateLimiter, (req, res, next) =>
  paymentController.webhook(req, res, next)
);

// Which methods checkout may offer. Public: the client needs it before login.
router.get('/methods', (req, res, next) => paymentController.methods(req, res, next));

// Llave pública y tokens de aceptación para el cobro dentro de la app.
// Autenticado: no es secreto, pero tampoco tiene por qué ser un proxy
// abierto hacia Wompi.
router.get('/checkout-config', authenticate, (req, res, next) =>
  paymentController.checkoutConfig(req, res, next)
);

// ── Customer ──
// `redirectUrl` is checked against an allowlist before it can reach the
// gateway's redirect-url parameter — see validators/payment.validator.ts.
router.post(
  '/orders/:orderId/pay',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentInitiateRateLimiter,
  validate(initiatePaymentSchema),
  (req, res, next) => paymentController.initiate(req, res, next)
);
// Cobro dentro de la app. Convive con `/pay` (redirección) mientras haya
// versiones de la app instaladas que solo conocen ese camino.
router.post(
  '/orders/:orderId/pay-native',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentInitiateRateLimiter,
  validate(payNativeSchema),
  (req, res, next) => paymentController.payNative(req, res, next)
);
router.get('/pse-banks', authenticate, (req, res, next) =>
  paymentController.pseBanks(req, res, next)
);

// Tarjetas guardadas del propio usuario. Guardar y borrar comparten el
// limitador de inicio de cobro: guardar llama a la pasarela.
router.get('/cards', authenticate, authorize(UserRole.CLIENT), (req, res, next) =>
  paymentController.listCards(req, res, next)
);
router.post(
  '/cards',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentInitiateRateLimiter,
  validate(saveCardSchema),
  (req, res, next) => paymentController.saveCard(req, res, next)
);
router.delete(
  '/cards/:id',
  authenticate,
  authorize(UserRole.CLIENT),
  validate(savedCardParamsSchema),
  (req, res, next) => paymentController.deleteCard(req, res, next)
);
router.get(
  '/status/:transactionId',
  authenticate,
  paymentStatusRateLimiter,
  validate(paymentStatusSchema),
  (req, res, next) => paymentController.status(req, res, next)
);

// Dejar a medias la verificación del banco para pagar de otra forma. Con el
// limitador de consultas: cada llamada le pregunta a Wompi una vez.
router.post(
  '/status/:transactionId/abandon',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentStatusRateLimiter,
  validate(paymentStatusSchema),
  (req, res, next) => paymentController.abandon(req, res, next)
);

// DaviPlata confirma el cobro con un código que la pasarela le manda por SMS
// a quien paga. Con su propio limitador —no el de consultas—: cada llamada
// gasta un SMS o un intento de los pocos que da Wompi.
router.post(
  '/status/:transactionId/otp/resend',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentOtpRateLimiter,
  validate(otpResendSchema),
  (req, res, next) => paymentController.resendOtp(req, res, next)
);
router.post(
  '/status/:transactionId/otp/validate',
  authenticate,
  authorize(UserRole.CLIENT),
  paymentOtpRateLimiter,
  validate(otpValidateSchema),
  (req, res, next) => paymentController.validateOtp(req, res, next)
);

router.get('/orders/:orderId', authenticate, validate(orderPaymentsSchema), (req, res, next) =>
  paymentController.forOrder(req, res, next)
);

// ── Finance admin ──
// Refunds and chargebacks move real money, so they sit behind the narrower
// finance gate rather than plain admin.
router.post(
  '/orders/:orderId/refund',
  authenticate,
  authorize(UserRole.ADMIN),
  requireFinanceAdmin,
  validate(refundSchema),
  (req, res, next) => paymentController.refund(req, res, next)
);
router.post(
  '/orders/:orderId/chargeback',
  authenticate,
  authorize(UserRole.ADMIN),
  requireFinanceAdmin,
  validate(chargebackSchema),
  (req, res, next) => paymentController.chargeback(req, res, next)
);
router.get(
  '/orders/:orderId/refunds',
  authenticate,
  authorize(UserRole.ADMIN),
  validate(orderPaymentsSchema),
  (req, res, next) => paymentController.listRefunds(req, res, next)
);

export default router;
