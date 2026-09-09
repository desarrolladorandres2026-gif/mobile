import { Router } from 'express';
import { offersController } from '../controllers';

const router = Router();

// Pública: mirar qué está en oferta es lo primero que hace alguien que
// todavía no se ha registrado, igual que en `/search` y `/coupons/public`.
router.get('/', (req, res, next) => offersController.get(req, res, next));

export default router;
