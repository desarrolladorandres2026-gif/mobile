import { Router, Request, Response, NextFunction } from 'express';
import { searchService, SortKey } from '../services/search.service';
import { authenticate, authorize } from '../middlewares';
import { UserRole } from '../types';
import { sendResponse, sendError, query, verifyAccessToken } from '../utils';

const router = Router();

const SORTS: SortKey[] = ['relevance', 'distance', 'rating', 'deliveryTime'];

/** Un número de la query, o `undefined` si no vino o no era un número. */
function num(req: Request, key: string): number | undefined {
  const raw = query(req, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readSort(req: Request): SortKey {
  const raw = query(req, 'sort');
  return SORTS.includes(raw as SortKey) ? (raw as SortKey) : 'relevance';
}

/**
 * Identifica al usuario si trae sesión, y sigue adelante si no.
 *
 * Local a este archivo y no un middleware compartido porque solo tiene
 * sentido aquí: buscar es público, así que rechazar a quien no ha entrado
 * sería cerrar la puerta justo a quien todavía está decidiendo si se
 * registra. Pero cuando sí hay sesión conviene saber de quién era la
 * búsqueda. Nunca falla: un token vencido o corrupto se trata igual que no
 * haber traído ninguno.
 */
function identifyIfPossible(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice(7));
      (req as Request & { searchUserId?: string }).searchUserId = payload.id;
    } catch {
      // Sin sesión utilizable. Es un caso normal, no un error.
    }
  }
  next();
}

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
      limit: num(req, 'limit') ?? 20,
      page: num(req, 'page') ?? 1,
      lat: num(req, 'lat'),
      lng: num(req, 'lng'),
      maxDistance: num(req, 'maxDistance'),
      sort: readSort(req),
    });
    sendResponse(res, 200, 'Resultados', results);
  } catch (error) { next(error); }
});

/** Sugerencias mientras se escribe. Pública por el mismo motivo. */
router.get('/suggest', async (req, res, next) => {
  try {
    const suggestions = await searchService.suggest(query(req, 'q') ?? '');
    sendResponse(res, 200, 'Sugerencias', suggestions);
  } catch (error) { next(error); }
});

router.get('/popular', async (req, res, next) => {
  try {
    sendResponse(res, 200, 'Lo más buscado', await searchService.popularTerms());
  } catch (error) { next(error); }
});

/**
 * Registra una búsqueda que el usuario confirmó.
 *
 * Endpoint aparte en vez de un efecto colateral del `GET` por dos razones:
 * el `GET` se repite mientras se escribe y contaría cada prefijo como una
 * búsqueda, y solo el cliente sabe cuántos resultados acabó viendo.
 */
router.post('/log', identifyIfPossible, async (req, res, next) => {
  try {
    const { term, resultCount, suggestedTerm } = req.body ?? {};
    if (typeof term !== 'string' || typeof resultCount !== 'number') {
      sendError(res, 400, 'Búsqueda no registrable');
      return;
    }

    await searchService.logSearch({
      term,
      userId: (req as Request & { searchUserId?: string }).searchUserId ?? null,
      resultCount,
      suggestedTerm: typeof suggestedTerm === 'string' ? suggestedTerm : null,
    });

    sendResponse(res, 200, 'Registrada');
  } catch (error) { next(error); }
});

/**
 * Qué busca la gente y qué busca sin encontrarlo.
 *
 * Solo administración: la lista de lo que falta en el catálogo es
 * inteligencia comercial, no un dato público.
 */
router.get(
  '/insights',
  authenticate,
  authorize(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      sendResponse(res, 200, 'Búsquedas', await searchService.insights(num(req, 'limit') ?? 25));
    } catch (error) { next(error); }
  }
);

export default router;
