import { Router } from 'express';
import { businessShareController } from '../controllers';

/**
 * Fuera de `/api/v1` a propósito: esta es la URL que se pega en WhatsApp,
 * y `api.<dominio>/negocio/:slug` es más corta y más presentable que
 * `api.<dominio>/api/v1/negocio/:slug`. Ver `businessShare.controller.ts`
 * para el porqué de toda esta ruta.
 */
const router = Router();

router.get('/:slug', (req, res, next) => businessShareController.preview(req, res, next));

export default router;
