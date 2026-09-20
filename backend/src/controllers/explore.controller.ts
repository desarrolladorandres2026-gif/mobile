import { Request, Response, NextFunction } from 'express';
import { exploreService } from '../services/explore.service';
import { sendResponse, query } from '../utils';
import { cache, CachePrefix } from '../cache';
import { cacheHeaders } from '../middlewares/cacheControl';
import { daypartAt } from '../models';

/**
 * El feed de Explorar.
 *
 * La caché va en dos capas y esa división es lo importante: la parte **cara**
 * —la agregación con una rama por colección— se calcula una vez por zona y
 * franja, y solo lo que depende de quien mira se guarda por usuario. Cachear
 * el feed entero por usuario multiplicaría las claves por usuarios activos y
 * tiraría la caché al suelo.
 *
 * Hoy solo existe la capa compartida. La personal llega con el perfil de
 * gustos, y su clave y su TTL ya están decididos: `explore:u:{userId}:…`,
 * cinco minutos.
 */

/** Un minuto, igual que el inicio: lo que tarda en verse un producto nuevo. */
const EXPLORE_TTL_SECONDS = 60;

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Tres decimales son ~110 m: la cuadra entera comparte entrada de caché. */
const round3 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);

export class ExploreController {
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const lat = round3(numberOrUndefined(query(req, 'lat')));
      const lng = round3(numberOrUndefined(query(req, 'lng')));
      const rawDistance = numberOrUndefined(query(req, 'maxDistance'));
      const maxDistance = rawDistance === undefined ? undefined : Math.round(rawDistance);
      const city = query(req, 'city') || undefined;
      const userId = (req as any).user?.id as string | undefined;

      const now = new Date();
      const daypart = daypartAt(now);

      // La franja entra en la clave: el feed de la mañana y el de la noche
      // son feeds distintos, y sin esto el primero se serviría durante el
      // minuto siguiente al cambio de franja.
      const zone = `${encodeURIComponent(city ?? '-').slice(0, 80)}:${lat ?? '-'}:${lng ?? '-'}:${maxDistance ?? '-'}`;
      const key = `${CachePrefix.EXPLORE}feed:${zone}:${daypart}`;

      const feed = await cache.wrap(key, EXPLORE_TTL_SECONDS, () =>
        exploreService.getExploreFeed({ lat, lng, maxDistance, city, userId, now })
      );

      // `private` y no `shared`: en cuanto el feed lleve una sección
      // derivada de los pedidos de quien mira, un proxy intermedio se la
      // serviría a otra persona.
      cacheHeaders(res, 'private');
      sendResponse(res, 200, 'Explorar', feed);
    } catch (error) { next(error); }
  }
}

export const exploreController = new ExploreController();
