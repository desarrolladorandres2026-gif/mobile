import { Request, Response, NextFunction } from 'express';
import { offersService } from '../services';
import { sendResponse, query } from '../utils';

/** Un número de la query, o `undefined` si no vino o no era un número. */
function num(req: Request, key: string): number | undefined {
  const raw = query(req, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Cuánto se puede pedir de una vez.
 *
 * El tope no es una optimización: sin él, `?limit=100000` convierte una
 * consulta pública y sin sesión en una descarga del catálogo entero.
 */
const MAX_LIMIT = 50;
const MAX_DISTANCE = 50_000;

export class OffersController {
  /**
   * Lo que está en oferta cerca de un punto.
   *
   * Pública a propósito, como `/search` y `/coupons/public`: mirar qué hay
   * rebajado es justo lo que hace alguien que todavía está decidiendo si se
   * registra, y exigirle sesión sería cerrarle la puerta en ese momento.
   */
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = num(req, 'limit');
      const maxDistance = num(req, 'maxDistance');

      const offers = await offersService.getOffers({
        lat: num(req, 'lat'),
        lng: num(req, 'lng'),
        maxDistance: maxDistance ? Math.min(maxDistance, MAX_DISTANCE) : undefined,
        city: query(req, 'city'),
        limit: limit ? Math.min(Math.max(limit, 1), MAX_LIMIT) : undefined,
      });

      const total =
        offers.coupons.length + offers.products.length + offers.businesses.length;

      sendResponse(
        res,
        200,
        total ? 'Ofertas disponibles' : 'Sin ofertas por ahora',
        offers
      );
    } catch (error) { next(error); }
  }
}

export const offersController = new OffersController();
