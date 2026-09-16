import { Router } from 'express';
import { z } from 'zod';
import { cartActivityService } from '../services/cartActivity.service';
import { authenticate, validate } from '../middlewares';
import { sendResponse } from '../utils';

const router = Router();

const syncSchema = z.object({
  body: z.object({
    businessId: z.string().length(24),
    businessName: z.string().min(1).max(200),
    itemCount: z.number().int().min(1),
    subtotal: z.number().min(0),
  }),
});

router.use(authenticate);

/** El teléfono avisa aquí cada vez que la bolsa cambia, para el recordatorio de bolsa abandonada. */
router.post('/sync', validate(syncSchema), async (req, res, next) => {
  try {
    await cartActivityService.sync(
      req.user!._id.toString(),
      req.body.businessId,
      req.body.businessName,
      req.body.itemCount,
      req.body.subtotal
    );
    sendResponse(res, 200, 'Bolsa sincronizada');
  } catch (error) { next(error); }
});

/** Bolsa vacía o pedido confirmado: ya no hay nada que recordar. */
router.delete('/', async (req, res, next) => {
  try {
    await cartActivityService.clear(req.user!._id.toString());
    sendResponse(res, 200, 'Bolsa limpiada');
  } catch (error) { next(error); }
});

export default router;
