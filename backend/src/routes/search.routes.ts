import { Router, Request } from 'express';
import { z } from 'zod';
import { searchService, SortKey } from '../services/search.service';
import { authenticate, authorize, identifyIfPossible, viewerId } from '../middlewares';
import { requirePermission } from '../middlewares/auth';
import { Permission } from '../security';
import { UserRole } from '../types';
import { sendResponse, sendError, query, param } from '../utils';
import { validate } from '../middlewares';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { searchRuleService } from '../services/searchRule.service';

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
      userId: viewerId(req),
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
  requirePermission(Permission.CONTENT_VIEW),
  async (req, res, next) => {
    try {
      sendResponse(res, 200, 'Búsquedas', await searchService.insights(num(req, 'limit') ?? 25));
    } catch (error) { next(error); }
  }
);

// ── Reglas de búsqueda (sinónimo, redirección, atendido) ──

const ruleSchema = z.object({
  body: z
    .object({
      term: z.string().trim().min(2).max(100),
      kind: z.enum(['synonym', 'redirect', 'handled']),
      synonymOf: z.string().trim().min(2).max(100).optional(),
      redirect: z
        .object({
          kind: z.enum(['category', 'business']),
          category: z.string().max(40).optional(),
          businessId: z.string().max(24).optional(),
        })
        .strict()
        .optional(),
      note: z.string().trim().max(200).optional(),
    })
    .strict(),
});

const ruleIdSchema = z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }) });

router.get(
  '/rules',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.CONTENT_VIEW),
  async (_req, res, next) => {
    try {
      sendResponse(res, 200, 'Reglas de búsqueda', await searchRuleService.listRules());
    } catch (error) { next(error); }
  }
);

router.put(
  '/rules',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.CONTENT_MANAGE),
  validate(ruleSchema),
  async (req, res, next) => {
    try {
      const rule = await searchRuleService.upsertRule(req.body, req.user!._id.toString());
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'search_rule',
        entityId: String(rule._id),
        severity: AuditSeverity.MEDIUM,
        description: `Regla de búsqueda "${rule.termRaw}": ${rule.kind}`,
        metadata: { kind: rule.kind, synonymOf: rule.synonymOf, redirect: rule.redirect },
      });
      sendResponse(res, 200, 'Regla guardada', rule);
    } catch (error) { next(error); }
  }
);

router.delete(
  '/rules/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  requirePermission(Permission.CONTENT_MANAGE),
  validate(ruleIdSchema),
  async (req, res, next) => {
    try {
      await searchRuleService.removeRule(param(req, 'id'));
      void logAudit(req, {
        action: AuditAction.SETTINGS_UPDATED,
        entity: 'search_rule',
        entityId: param(req, 'id'),
        severity: AuditSeverity.MEDIUM,
        description: 'Regla de búsqueda eliminada',
      });
      sendResponse(res, 200, 'Regla eliminada');
    } catch (error) { next(error); }
  }
);

export default router;
