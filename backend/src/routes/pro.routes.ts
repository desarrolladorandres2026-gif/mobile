import { Router } from 'express';
import { proService } from '../services/pro.service';
import { authenticate, authorize, validate, paymentInitiateRateLimiter } from '../middlewares';
import { subscribeProSchema } from '../validators/pro.validator';
import { sendResponse } from '../utils';
import { UserRole } from '../types';

const router = Router();

router.use(authenticate, authorize(UserRole.CLIENT));

/**
 * Estado de la membresía y, con él, el plan.
 *
 * Los dos juntos en una sola respuesta a propósito: la pantalla de Zipp Pro
 * tiene que pintar o la venta o el carnet, y con dos peticiones habría un
 * instante en el que sabe el precio pero aún no sabe si la persona ya lo
 * paga —que es justo el instante en el que enseñaría "hazte Pro" a alguien
 * que ya lo es—.
 */
router.get('/', async (req, res, next) => {
  try {
    const status = await proService.statusOf(req.user!._id.toString());
    sendResponse(res, 200, 'Zipp Pro', status);
  } catch (error) { next(error); }
});

/**
 * Arranca el cobro de la membresía.
 *
 * Responde con el intento de la pasarela, no con "ya eres Pro": eso lo
 * dirá el webhook. La app espera igual que espera el pago de un pedido —por
 * socket, y consultando de respaldo—.
 *
 * Comparte limitador con el inicio de cobro de un pedido: las dos cosas
 * crean transacciones reales en Wompi.
 */
router.post(
  '/subscribe',
  paymentInitiateRateLimiter,
  validate(subscribeProSchema),
  async (req, res, next) => {
    try {
      const result = await proService.subscribe({
        userId: req.user!._id.toString(),
        instrument: req.body.instrument,
        acceptanceToken: req.body.acceptanceToken,
        personalDataAuthToken: req.body.personalDataAuthToken,
        browserInfo: req.body.browserInfo,
        customerEmail: req.body.customerEmail,
      });

      // Misma forma que el cobro de un pedido, para que la app pueda
      // esperar el resultado con el mismo código.
      sendResponse(res, 201, 'Cobro iniciado', {
        paymentId: result.paymentId,
        reference: result.reference,
        transactionId: result.intent.id,
        status: result.intent.status,
        amount: result.intent.amount,
        declineReason: result.intent.declineReason,
        paymentMethodType: result.intent.paymentMethodType,
        threeDsChallengeHtml: result.intent.threeDsChallengeHtml,
      });
    } catch (error) { next(error); }
  }
);

/** Deja de renovar. El acceso sigue hasta el final del periodo pagado. */
router.post('/cancel', async (req, res, next) => {
  try {
    const status = await proService.cancel(req.user!._id.toString());
    sendResponse(res, 200, 'Tu membresía no se renovará', status);
  } catch (error) { next(error); }
});

/** Vuelve a activar la renovación de una membresía todavía vigente. */
router.post('/resume', async (req, res, next) => {
  try {
    const status = await proService.resume(req.user!._id.toString());
    sendResponse(res, 200, 'Tu membresía vuelve a renovarse', status);
  } catch (error) { next(error); }
});

export default router;
