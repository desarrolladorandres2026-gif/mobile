import { Request, Response, NextFunction } from 'express';
import { homeSectionsService } from '../services/homeSections.service';
import { sendResponse, query } from '../utils';
import { cache, CachePrefix } from '../cache';
import { cacheHeaders } from '../middlewares/cacheControl';

/** Un minuto: lo que tarda en verse un producto nuevo o un negocio que cerró. */
const HOME_SECTIONS_TTL_SECONDS = 60;

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Tres decimales son ~110 m: dos clientes de la misma cuadra comparten la
 * misma entrada de caché en vez de una por cada fix del GPS. Se calcula con
 * el valor redondeado —no solo se usa para la clave— para que lo cacheado
 * sea exactamente lo que esa clave promete.
 */
const round3 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);

export class HomeSectionsController {
  /** Las colecciones dinámicas del inicio, mezclando productos de varios comercios. */
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const lat = round3(numberOrUndefined(query(req, 'lat')));
      const lng = round3(numberOrUndefined(query(req, 'lng')));
      const rawDistance = numberOrUndefined(query(req, 'maxDistance'));
      const maxDistance = rawDistance === undefined ? undefined : Math.round(rawDistance);
      const city = query(req, 'city') || undefined;

      const key = `${CachePrefix.HOME}sections:${encodeURIComponent(city ?? '-').slice(0, 80)}:${lat ?? '-'}:${lng ?? '-'}:${maxDistance ?? '-'}`;
      const sections = await cache.wrap(key, HOME_SECTIONS_TTL_SECONDS, () =>
        homeSectionsService.getHomeSections({ lat, lng, maxDistance, city })
      );
      cacheHeaders(res, 'shared');
      sendResponse(res, 200, 'Colecciones del inicio', sections);
    } catch (error) { next(error); }
  }
}

export const homeSectionsController = new HomeSectionsController();
