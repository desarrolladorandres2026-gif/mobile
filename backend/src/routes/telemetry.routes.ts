import { Router } from 'express';
import { z } from 'zod';
import { ClientError } from '../models';
import { authenticate, validate } from '../middlewares';
import { sensitiveRateLimiter } from '../middlewares';
import { sendResponse } from '../utils';

const router = Router();

const crashSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(500),
    stack: z.string().max(4000).optional(),
    fatal: z.boolean().optional(),
    scope: z.string().max(120).optional(),
    orderId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    platform: z.string().max(60),
    appVersion: z.string().max(40),
    deviceId: z.string().max(120).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
    at: z.string().datetime(),
  }),
});

/**
 * Recibe un crash del teléfono.
 *
 * Va con el limitador de peticiones sensibles a propósito: un error de
 * render se repite en bucle mientras la pantalla siga montada, y aunque la
 * app ya deduplica por firma, el servidor no puede confiar en que el
 * cliente que le reporta un fallo esté sano — es literalmente lo contrario
 * de lo que el reporte dice.
 *
 * Nunca devuelve error al cliente por un reporte mal formado más allá de la
 * validación: quien está reportando un crash no tiene nada que hacer con un
 * 500, y reintentar sería empeorar la situación del teléfono.
 */
router.post(
  '/crash',
  authenticate,
  sensitiveRateLimiter,
  validate(crashSchema),
  async (req, res, next) => {
    try {
      await ClientError.create({
        userId: req.user!._id,
        message: req.body.message,
        stack: req.body.stack ?? null,
        fatal: !!req.body.fatal,
        scope: req.body.scope ?? null,
        orderId: req.body.orderId ?? null,
        platform: req.body.platform,
        appVersion: req.body.appVersion,
        deviceId: req.body.deviceId ?? null,
        extra: req.body.extra ?? null,
        at: new Date(req.body.at),
      });

      sendResponse(res, 201, 'Reporte recibido', null);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
