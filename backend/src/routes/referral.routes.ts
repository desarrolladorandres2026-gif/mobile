import { Router } from 'express';
import { z } from 'zod';
import { referralService } from '../services/referral.service';
import { authenticate, authorize, validate } from '../middlewares';
import { sendResponse } from '../utils';
import { UserRole } from '../types';

const router = Router();

router.use(authenticate, authorize(UserRole.CLIENT));

/** Mi código y cuánta gente he traído. */
router.get('/', async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Tus invitaciones', await referralService.statsFor(req.user!._id.toString()));
  } catch (error) { next(error); }
});

const applySchema = z.object({
  body: z.object({ code: z.string().trim().min(3).max(20) }),
});

/**
 * Usar el código de quien me invitó.
 *
 * Solo apunta quién trajo a quién: el premio se paga cuando este usuario
 * complete su primera compra.
 */
router.post('/apply', validate(applySchema), async (req, res, next) => {
  try {
    await referralService.attribute(req.user!._id.toString(), req.body.code);
    sendResponse(res, 200, 'Código aplicado. Tu recompensa llega con tu primer pedido.');
  } catch (error) { next(error); }
});

export default router;
