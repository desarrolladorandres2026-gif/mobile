import { Router, json, type NextFunction, type Request, type Response } from 'express';
import { cspReportService } from '../services/cspReport.service';
import { cspReportRateLimiter } from '../middlewares';

const router = Router();

/**
 * Destino de `report-uri` / `Reporting-Endpoints` de la CSP de los paneles (M-025).
 *
 * Sin sesión —el navegador no la manda—, con su propio límite por IP, con un cuerpo
 * de hasta 16 kB y con su propio lector: el parser global solo entiende
 * `application/json`, y los navegadores mandan `application/csp-report` o
 * `application/reports+json`. Responde siempre 204: quien reporta no puede hacer
 * nada con un error, y un 4xx le diría a un atacante qué forma esperamos.
 */
router.post(
  '/',
  cspReportRateLimiter,
  json({ type: ['application/csp-report', 'application/reports+json'], limit: '16kb' }),
  // Un cuerpo roto o demasiado grande no es un error de nadie: 204 y a otra cosa.
  (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(204).end();
  },
  async (req: Request, res: Response) => {
    try {
      await cspReportService.record(req.body);
    } catch (error) {
      console.error('[CSP] No se pudo guardar un reporte:', (error as Error).message);
    }
    res.status(204).end();
  }
);

export default router;
