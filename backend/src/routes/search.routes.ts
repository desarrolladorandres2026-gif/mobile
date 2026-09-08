import { Router } from 'express';
import { searchService } from '../services/search.service';
import { sendResponse, query } from '../utils';

const router = Router();

/**
 * Búsqueda del catálogo.
 *
 * Pública a propósito: buscar es lo primero que hace alguien que todavía no
 * se ha registrado, y obligarle a crear una cuenta para averiguar si en su
 * pueblo hay lo que busca es la forma más rápida de perderlo.
 */
router.get('/', async (req, res, next) => {
  try {
    const results = await searchService.search(query(req, 'q') ?? '', {
      limit: Number(query(req, 'limit')) || 20,
    });
    sendResponse(res, 200, 'Resultados', results);
  } catch (error) { next(error); }
});

router.get('/popular', async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Lo más buscado', await searchService.popularTerms());
  } catch (error) { next(error); }
});

export default router;
