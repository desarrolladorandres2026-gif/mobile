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
} from '../middlewares';
import { refundSchema } from '../validators/finance.validator';
import {
  initiatePaymentSchema,
  paymentStatusSchema,
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
router.get(
  '/status/:transactionId',
  authenticate,
  paymentStatusRateLimiter,
  validate(paymentStatusSchema),
  (req, res, next) => paymentController.status(req, res, next)
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
