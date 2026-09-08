import { Router } from 'express';
import { z } from 'zod';
import { sosService } from '../services/sos.service';
import { authenticate, authorize, validate } from '../middlewares';
import { sendResponse, param } from '../utils';
import { UserRole } from '../types';

const router = Router();

router.use(authenticate);

const triggerSchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    note: z.string().trim().max(300).optional(),
  }),
});

/**
 * Botón de pánico.
 *
 * Sin límite de frecuencia a propósito: una persona en peligro puede pulsar
 * tres veces, y negarle la tercera por haber pulsado dos es exactamente el
 * fallo que no se puede cometer aquí. El servicio reutiliza la alerta
 * abierta en vez de multiplicarlas.
 */
router.post(
  '/',
  authorize(UserRole.DRIVER),
  validate(triggerSchema),
  async (req, res, next) => {
    try {
      const alert = await sosService.trigger(req.user!._id.toString(), req.body);
      sendResponse(res, 201, 'Alerta enviada. Vamos en camino.', alert);
    } catch (error) { next(error); }
  }
);

// ── Panel de administración ──

router.get('/active', authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Emergencias activas', await sosService.active());
  } catch (error) { next(error); }
});

router.get('/history', authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Historial de emergencias', await sosService.history());
  } catch (error) { next(error); }
});

router.patch('/:id/acknowledge', authorize(UserRole.ADMIN), async (req, res, next) => {
  try {
    const alert = await sosService.acknowledge(param(req, 'id'), req.user!._id.toString());
    sendResponse(res, 200, 'Alerta atendida', alert);
  } catch (error) { next(error); }
});

const resolveSchema = z.object({
  body: z.object({
    resolution: z.string().trim().min(3).max(500),
    falseAlarm: z.boolean().optional(),
  }),
});

router.patch(
  '/:id/resolve',
  authorize(UserRole.ADMIN),
  validate(resolveSchema),
  async (req, res, next) => {
    try {
      const alert = await sosService.resolve(
        param(req, 'id'),
        req.user!._id.toString(),
        req.body.resolution,
        req.body.falseAlarm
      );
      sendResponse(res, 200, 'Emergencia cerrada', alert);
    } catch (error) { next(error); }
  }
);

export default router;
