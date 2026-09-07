import { Request, Response, NextFunction } from 'express';
import { zoneService } from '../services';
import { sendResponse, param, query } from '../utils';

export class ZoneController {
  /** Public: "do you deliver to this address?" */
  async checkCoverage(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await zoneService.checkCoverage(
        Number(req.query.lat),
        Number(req.query.lng),
        query(req, 'businessId')
      );
      sendResponse(res, 200, result.covered ? 'Cobertura disponible' : 'Sin cobertura', result);
    } catch (error) { next(error); }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const zones = await zoneService.getAll(
        query(req, 'city'),
        query(req, 'includeInactive') === 'true'
      );
      sendResponse(res, 200, 'Zonas de cobertura', zones);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const zone = await zoneService.getById(param(req, 'id'));
      sendResponse(res, 200, 'Zona', zone);
    } catch (error) { next(error); }
  }

  // ── Admin ──────────────────────────────────────────────────────────

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const zone = await zoneService.create(req.body);
      sendResponse(res, 201, 'Zona creada', zone);
    } catch (error) { next(error); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const zone = await zoneService.update(param(req, 'id'), req.body);
      sendResponse(res, 200, 'Zona actualizada', zone);
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      await zoneService.delete(param(req, 'id'));
      sendResponse(res, 200, 'Zona eliminada');
    } catch (error) { next(error); }
  }
}

export const zoneController = new ZoneController();
