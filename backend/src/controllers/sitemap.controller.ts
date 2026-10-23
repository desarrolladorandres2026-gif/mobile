import { Request, Response, NextFunction } from 'express';
import { getSitemapXml } from '../services/sitemap.service';

export const sitemapController = {
  async get(_req: Request, res: Response, next: NextFunction) {
    try {
      const xml = await getSitemapXml();
      res.status(200).type('application/xml').set('Cache-Control', 'public, max-age=600').send(xml);
    } catch (error) { next(error); }
  },
};
