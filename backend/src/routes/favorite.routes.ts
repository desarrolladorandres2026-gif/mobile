import { Router } from 'express';
import { z } from 'zod';
import { favoriteService } from '../services/favorite.service';
import { authenticate, validate } from '../middlewares';
import { sendResponse, param } from '../utils';

const router = Router();

const kindSchema = z.enum(['business', 'product']);

const addSchema = z.object({
  body: z.object({
    kind: kindSchema,
    targetId: z.string().length(24),
  }),
});

const importSchema = z.object({
  body: z.object({
    items: z
      .array(z.object({ kind: kindSchema, targetId: z.string().length(24) }))
      .max(200),
  }),
});

router.use(authenticate);

/** La lista con su contenido, para la pantalla de favoritos. */
router.get('/', async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Favoritos', await favoriteService.list(req.user!._id.toString()));
  } catch (error) { next(error); }
});

/**
 * Solo los ids.
 *
 * Es lo que necesita el resto de la app para pintar el corazón lleno en una
 * lista de treinta negocios sin traerse treinta negocios otra vez.
 */
router.get('/ids', async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Favoritos', await favoriteService.ids(req.user!._id.toString()));
  } catch (error) { next(error); }
});

router.post('/', validate(addSchema), async (req, res, next) => {
  try {
    const favorite = await favoriteService.add(
      req.user!._id.toString(),
      req.body.kind,
      req.body.targetId
    );
    sendResponse(res, 201, 'Agregado a favoritos', favorite);
  } catch (error) { next(error); }
});

router.delete('/:kind/:targetId', async (req, res, next) => {
  try {
    await favoriteService.remove(
      req.user!._id.toString(),
      param(req, 'kind') as 'business' | 'product',
      param(req, 'targetId')
    );
    sendResponse(res, 200, 'Quitado de favoritos');
  } catch (error) { next(error); }
});

/**
 * Sube de una vez lo que la app tenía guardado en el teléfono.
 *
 * Migración de un solo uso por usuario: sin ella, estrenar la
 * sincronización empezaría vaciándole la lista al cliente.
 */
router.post('/import', validate(importSchema), async (req, res, next) => {
  try {
    const imported = await favoriteService.importLocal(
      req.user!._id.toString(),
      req.body.items
    );
    sendResponse(res, 200, 'Favoritos sincronizados', { imported });
  } catch (error) { next(error); }
});

export default router;
