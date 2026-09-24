import { Request, Response, NextFunction } from 'express';
import { exploreLayoutService } from '../services/exploreLayout.service';
import { advertisementService } from '../services/advertisement.service';
import { dailySeed } from '../services/discovery.service';
import { sendResponse, query } from '../utils';
import { cache, CachePrefix } from '../cache';
import { cacheHeaders } from '../middlewares/cacheControl';
import { AdPlacement, daypartAt } from '../models';

/**
 * El feed de Explorar.
 *
 * Lo que se ve lo decide el layout publicado desde el panel
 * (`exploreLayout.service.ts`); aquí solo se arma la caché y se elige la
 * campaña pagada.
 *
 * La caché va por **versión publicada, zona y franja**: la parte cara —la
 * agregación con una rama por sección— se calcula una vez por combinación.
 * Publicar cambia la versión y con ella la clave, así que no hace falta
 * vaciar nada; las claves viejas caducan solas.
 *
 * La semilla de rotación sale de la zona y no de quien mira: el resultado
 * se comparte por zona, y antes la semilla dependía del primer usuario que
 * llenaba la caché — toda la zona veía la rotación de esa persona.
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
      // Las apps anteriores al constructor no mandan esto y reciben `entries`.
      const wantsLayout = query(req, 'layout') === '1';

      const now = new Date();
      const daypart = daypartAt(now);

      const zone = `${encodeURIComponent(city ?? '-').slice(0, 80)}:${lat ?? '-'}:${lng ?? '-'}:${maxDistance ?? '-'}`;
      const layout = await exploreLayoutService.getPublishedLayout();
      const key = `${CachePrefix.EXPLORE}feed:v${layout.version}:${zone}:${daypart}`;

      const resolved = await cache.wrap(key, EXPLORE_TTL_SECONDS, () =>
        exploreLayoutService.resolveLayout(layout.sections, {
          lat, lng, maxDistance, city, now, seed: dailySeed(zone, daypart, now),
        })
      );

      // La campaña va fuera de la caché compartida, en cada petición: si
      // viviera dentro, toda la zona vería la misma durante el minuto de TTL.
      const ad = await advertisementService.getActiveForApp({ city }, AdPlacement.EXPLORE);
      const sections = exploreLayoutService.withAd(resolved.sections, ad);

      // `private` y no `shared`: en cuanto el feed lleve una sección
      // derivada de los pedidos de quien mira, un proxy intermedio se la
      // serviría a otra persona.
      cacheHeaders(res, 'private');
      sendResponse(res, 200, 'Explorar', wantsLayout
        ? { sections, daypart, personalized: false, layoutVersion: layout.version }
        : { entries: exploreLayoutService.toLegacyEntries(sections), daypart, personalized: false });
    } catch (error) { next(error); }
  }
}

export const exploreController = new ExploreController();
