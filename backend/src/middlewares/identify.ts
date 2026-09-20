import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/token';

/**
 * Deja el id de quien mira, si trae sesión, y sigue adelante si no.
 *
 * Es lo que necesitan las pantallas **públicas que mejoran con sesión**:
 * buscar y explorar están abiertos a propósito —rechazar a quien no ha
 * entrado sería cerrarle la puerta justo a quien todavía está decidiendo si
 * se registra—, pero cuando sí hay alguien identificado conviene saber
 * quién: para atribuirle la búsqueda, o para que el feed pueda personalizar.
 *
 * **Nunca falla.** Un token vencido, corrupto o ausente se tratan igual: sin
 * sesión utilizable, que es un caso normal y no un error. Por eso no se
 * puede usar como sustituto de `authenticate` en nada que proteja algo.
 *
 * Deja el id en `optionalUserId` y **no** en `req.user`: ese lo rellena
 * `authenticate` con el documento completo, y dejarlo a medias haría que
 * cualquier código que lo lea crea que hay una sesión verificada detrás.
 */
export interface IdentifiedRequest extends Request {
  optionalUserId?: string;
}

export function identifyIfPossible(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice(7));
      (req as IdentifiedRequest).optionalUserId = payload.id;
    } catch {
      // Sin sesión utilizable. Es un caso normal, no un error.
    }
  }
  next();
}

/** El id de quien mira, o `null` si no hay sesión utilizable. */
export function viewerId(req: Request): string | null {
  return (req as IdentifiedRequest).optionalUserId ?? null;
}
