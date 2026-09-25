import { Router } from 'express';
import { z } from 'zod';
import { errandService } from '../services/errand.service';
import { authenticate, authorize, validate } from '../middlewares';
import { sendResponse, param } from '../utils';
import { UserRole } from '../types';

const router = Router();

router.use(authenticate);

const createSchema = z.object({
  body: z.object({
    description: z.string().trim().min(10).max(500),
    pickupAddress: z.string().trim().min(5).max(300),
    pickupLatitude: z.number().min(-90).max(90),
    pickupLongitude: z.number().min(-180).max(180),
    deliveryAddress: z.string().trim().min(5).max(300),
    deliveryLatitude: z.number().min(-90).max(90),
    deliveryLongitude: z.number().min(-180).max(180),
    estimatedCost: z.number().int().min(0).max(2_000_000),
    /**
     * El tope es obligatorio y tiene techo.
     *
     * El cliente autoriza una compra que todavía no ha visto: sin límite
     * está firmando un cheque en blanco, y el domiciliario tendría que
     * adelantar de su bolsillo una cifra desconocida.
     */
    maxCost: z.number().int().min(1).max(2_000_000),
    notes: z.string().trim().max(500).optional(),
    recipient: z
      .object({
        name: z.string().trim().min(2).max(80),
        phone: z.string().trim().min(7).max(20),
        note: z.string().trim().max(200).optional(),
      })
      .optional(),
  }),
});

router.post(
  '/',
  authorize(UserRole.CLIENT),
  validate(createSchema),
  async (req, res, next) => {
    try {
      const order = await errandService.create({
        ...req.body,
        clientId: req.user!._id.toString(),
      });
      sendResponse(res, 201, 'Mandado creado', order);
    } catch (error) { next(error); }
  }
);

const costSchema = z.object({
  body: z.object({
    actualCost: z.number().int().min(0).max(2_000_000),
    /**
     * Lo manda la app instalada, pero ya no se usa: el recibo se toma de la
     * evidencia de recogida del pedido (`declareCost`), no de una URL que
     * cualquiera puede escribir.
     */
    receiptUrl: z.string().max(2000).optional(),
  }),
});

router.post(
  '/:id/cost',
  authorize(UserRole.DRIVER),
  validate(costSchema),
  async (req, res, next) => {
    try {
      const order = await errandService.declareCost(
        param(req, 'id'),
        req.user!._id.toString(),
        req.body.actualCost
      );
      sendResponse(res, 200, 'Gasto registrado', order);
    } catch (error) { next(error); }
  }
);

export default router;
