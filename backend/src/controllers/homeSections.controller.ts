import { Request, Response, NextFunction } from 'express';
import { homeSectionsService } from '../services/homeSections.service';
import { sendResponse, query } from '../utils';

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export class HomeSectionsController {
  /** Las colecciones dinámicas del inicio, mezclando productos de varios comercios. */
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const sections = await homeSectionsService.getHomeSections({
        lat: numberOrUndefined(query(req, 'lat')),
        lng: numberOrUndefined(query(req, 'lng')),
        maxDistance: numberOrUndefined(query(req, 'maxDistance')),
        city: query(req, 'city') || undefined,
      });
      sendResponse(res, 200, 'Colecciones del inicio', sections);
    } catch (error) { next(error); }
  }
}

export const homeSectionsController = new HomeSectionsController();
