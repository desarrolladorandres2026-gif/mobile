import { Request, Response, NextFunction } from 'express';
import { sendResponse } from '../utils';
import { adminSearchService } from '../services/adminSearch.service';

export const adminSearchController = {
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const { q, types } = req.query as unknown as { q: string; types?: any[] };
      const data = await adminSearchService.search(req, q, types);
      res.set('Cache-Control', 'no-store');
      sendResponse(res, 200, 'Resultados', data);
    } catch (e) { next(e); }
  },
};
