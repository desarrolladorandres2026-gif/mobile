import { Request, Response, NextFunction } from 'express';
import { offersService } from '../services';
import { sendResponse, query } from '../utils';
import { cache, CachePrefix } from '../cache';
import { cacheHeaders } from '../middlewares/cacheControl';

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

      const round3 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);
      const params = {
        lat: round3(num(req, 'lat')),
        lng: round3(num(req, 'lng')),
        maxDistance: maxDistance ? Math.round(Math.min(maxDistance, MAX_DISTANCE)) : undefined,
        city: query(req, 'city'),
        limit: limit ? Math.round(Math.min(Math.max(limit, 1), MAX_LIMIT)) : undefined,
      };
      const key = `${CachePrefix.OFFERS}${encodeURIComponent(params.city ?? '-').slice(0, 80)}:${params.lat ?? '-'}:${params.lng ?? '-'}:${params.maxDistance ?? '-'}:${params.limit ?? '-'}`;
      const offers = await cache.wrap(key, 60, () => offersService.getOffers(params));

      const total =
        offers.coupons.length + offers.products.length + offers.businesses.length;

      cacheHeaders(res, 'shared');
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
