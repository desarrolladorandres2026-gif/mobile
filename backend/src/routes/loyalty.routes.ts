import { Router } from 'express';
import { z } from 'zod';
import { loyaltyService } from '../services/loyalty.service';
import { authenticate, authorize, validate } from '../middlewares';
import { sendResponse } from '../utils';
import { UserRole } from '../types';

const router = Router();

router.use(authenticate, authorize(UserRole.CLIENT));

/** Saldo y movimientos: la respuesta a "por qué tengo estos puntos". */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user!._id.toString();
    const [balance, history] = await Promise.all([
      loyaltyService.balanceOf(userId),
      loyaltyService.historyOf(userId),
    ]);
    sendResponse(res, 200, 'Tus puntos', { balance, history });
  } catch (error) { next(error); }
});

const redeemSchema = z.object({
  body: z.object({ points: z.number().int().min(1) }),
});

/**
 * Canjea puntos por un cupón.
 *
 * Devuelve el cupón entero para que la app pueda enseñar el código y
 * aplicarlo de una vez: obligar al cliente a copiarlo a mano después de
 * canjear es la forma más rápida de que no lo use.
 */
router.post('/redeem', validate(redeemSchema), async (req, res, next) => {
  try {
    const result = await loyaltyService.redeem(req.user!._id.toString(), req.body.points);
    sendResponse(res, 201, 'Puntos canjeados', result);
  } catch (error) { next(error); }
});

export default router;
