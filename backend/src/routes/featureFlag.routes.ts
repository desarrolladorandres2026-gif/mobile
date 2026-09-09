import { Router } from 'express';
import { featureFlagService } from '../services/featureFlag.service';
import { authenticate } from '../middlewares';
import { sendResponse } from '../utils';

const router = Router();

/**
 * Los interruptores resueltos para quien pregunta.
 *
 * `resolveAll` existía desde el principio, con el comentario "para
 * mandárselos a la app", y no había ninguna ruta que lo expusiera: el
 * servidor sabía repartir por audiencia y por porcentaje, y la app no podía
 * leer ni un flag.
 *
 * Eso ya costó una vez. El comentario de `featureFlag.service` cuenta que el
 * despacho automático se desplegó y habría roto la operación porque la app
 * del domiciliario no sabía enseñar una oferta — exactamente el problema que
 * un interruptor consultable evita.
 *
 * Pide sesión porque el reparto por porcentaje es estable **por usuario**:
 * sin saber quién pregunta, un mismo teléfono caería de un lado u otro entre
 * pantallas, y un reparto que parpadea es peor que no tener reparto. Si algún
 * día hace falta consultarlos antes de iniciar sesión, el camino es un
 * middleware de autenticación opcional, no quitar el `authenticate`.
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const flags = await featureFlagService.resolveAll({
      userId: req.user!._id.toString(),
      role: req.user!.role,
    });
    sendResponse(res, 200, 'Interruptores', flags);
  } catch (error) {
    next(error);
  }
});

export default router;
