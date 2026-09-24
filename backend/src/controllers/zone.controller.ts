import { Request, Response, NextFunction } from 'express';
import { zoneService } from '../services';
import { sendResponse, param, query } from '../utils';
import { cache, CachePrefix } from '../cache';
import { cacheHeaders } from '../middlewares/cacheControl';

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

  /**
   * Público: nombre, ciudad, polígono y pedido mínimo de las zonas activas.
   * Sin tarifas (son el pago al repartidor) y sin `includeInactive`: quien no
   * está autenticado no ve las zonas en preparación. El panel usa
   * `GET /zones/admin`.
   */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const city = query(req, 'city');
      // Las zonas cambian cuando administración las dibuja, no solas; toda
      // escritura en `Zone` limpia estas entradas al instante. La clave dice
      // `public` para no servir entradas antiguas que aún traían tarifas.
      const zones = await cache.wrap(
        `${CachePrefix.ZONES}${encodeURIComponent(city ?? '-').slice(0, 80)}:public`,
        600,
        () => zoneService.getPublic(city)
      );
      cacheHeaders(res, 'shared');
      sendResponse(res, 200, 'Zonas de cobertura', zones);
    } catch (error) { next(error); }
  }

  /** Panel (`zones:view`): todas las zonas, con tarifas y las inactivas. */
  async listAdmin(req: Request, res: Response, next: NextFunction) {
    try {
      const zones = await zoneService.getAll(query(req, 'city'), query(req, 'includeInactive') !== 'false');
      // Es la vista del panel, que relee justo después de editar; y lleva tarifas.
      res.setHeader('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Zonas de cobertura', zones);
    } catch (error) { next(error); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const zone = await zoneService.getPublicById(param(req, 'id'));
      sendResponse(res, 200, 'Zona', zone);
    } catch (error) { next(error); }
  }

  // ── Admin (permiso `zones:manage`; ver zone.routes.ts) ─────────────

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { reason, ...input } = req.body;
      const zone = await zoneService.create(input, { actorId: req.user!._id.toString(), reason, req });
      sendResponse(res, 201, 'Zona creada', zone);
    } catch (error) { next(error); }
  }

  /**
   * Editar una zona. Si cambia la tarifa, `reason` es obligatorio y se crea
   * una versión; ver `zoneService.update`.
   */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { reason, ...input } = req.body;
      const zone = await zoneService.update(param(req, 'id'), input, {
        actorId: req.user!._id.toString(),
        reason,
        req,
      });
      sendResponse(res, 200, 'Zona actualizada', zone);
    } catch (error) { next(error); }
  }

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      await zoneService.delete(param(req, 'id'), {
        actorId: req.user!._id.toString(),
        reason: req.body?.reason,
        req,
      });
      sendResponse(res, 200, 'Zona eliminada');
    } catch (error) { next(error); }
  }

  /** Historial de tarifas de la zona (`zones:view`). */
  async versions(req: Request, res: Response, next: NextFunction) {
    try {
      sendResponse(res, 200, 'Versiones de la zona', await zoneService.listVersions(param(req, 'id')));
    } catch (error) { next(error); }
  }
}

export const zoneController = new ZoneController();
