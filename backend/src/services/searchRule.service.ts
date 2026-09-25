import { Types } from 'mongoose';
import { Business, SearchRule, ISearchRule, SearchRuleKind } from '../models';
import { BusinessCategory } from '../types/enums';
import { normalize } from '../utils/text';
import { cache } from '../cache';
import { AppError } from '../middlewares/errorHandler';
import { VISIBLE_BUSINESS } from '../utils/catalogQuery';

/**
 * Reglas de búsqueda: sinónimos, redirecciones y "atendido".
 *
 * Se leen en cada búsqueda, así que van por la caché de 60 s en un solo
 * mapa (son unas pocas decenas de reglas) y se invalidan al escribir.
 */

const CACHE_KEY = 'search:rules';
const CACHE_TTL_SECONDS = 60;

export interface RuleView {
  kind: SearchRuleKind;
  synonymOf: string | null;
  redirect: { kind: 'category' | 'business'; category?: string; businessId?: string; label?: string } | null;
}

async function loadAll(): Promise<Record<string, RuleView>> {
  const rules = await SearchRule.find().lean();
  const businessIds = rules
    .map((r) => r.redirect?.businessId)
    .filter((id): id is Types.ObjectId => !!id);
  const businesses = businessIds.length
    ? await Business.find({ _id: { $in: businessIds } }).select('name').lean()
    : [];
  const nameOf = new Map(businesses.map((b) => [String(b._id), b.name as string]));

  const out: Record<string, RuleView> = {};
  for (const r of rules) {
    out[r.term] = {
      kind: r.kind,
      synonymOf: r.synonymOf ?? null,
      redirect: r.redirect
        ? {
            kind: r.redirect.kind,
            ...(r.redirect.category ? { category: r.redirect.category } : {}),
            ...(r.redirect.businessId
              ? { businessId: String(r.redirect.businessId), label: nameOf.get(String(r.redirect.businessId)) }
              : {}),
          }
        : null,
    };
  }
  return out;
}

/** La regla de un término, o `null`. Con la caché caída, va a Mongo. */
export async function ruleFor(term: string): Promise<RuleView | null> {
  const all = await cache.wrap(CACHE_KEY, CACHE_TTL_SECONDS, loadAll);
  return all[normalize(term)] ?? null;
}

export interface RuleInput {
  term: string;
  kind: SearchRuleKind;
  synonymOf?: string;
  redirect?: { kind: 'category' | 'business'; category?: string; businessId?: string };
  note?: string;
}

export async function upsertRule(input: RuleInput, adminId: string): Promise<ISearchRule> {
  const term = normalize(input.term.trim());
  if (term.length < 2) throw new AppError('El término es demasiado corto', 400);

  let synonymOf: string | null = null;
  let redirect: ISearchRule['redirect'] = null;

  if (input.kind === 'synonym') {
    synonymOf = normalize((input.synonymOf ?? '').trim());
    if (synonymOf.length < 2) throw new AppError('Indica el término al que equivale', 400);
    if (synonymOf === term) throw new AppError('Un término no puede ser sinónimo de sí mismo', 400);
    // Un destino que tampoco devuelve nada sería una regla decorativa. Se
    // comprueba contra el catálogo con el mismo diccionario que la búsqueda.
    const { searchService } = await import('./search.service');
    const probe = await searchService.search(synonymOf, { limit: 1, skipRules: true });
    if (!probe.businesses.length && !probe.products.length) {
      throw new AppError(`"${synonymOf}" tampoco devuelve resultados: elige un término que exista en el catálogo`, 400);
    }
  }

  if (input.kind === 'redirect') {
    const r = input.redirect;
    if (!r) throw new AppError('Indica a dónde se redirige', 400);
    if (r.kind === 'category') {
      if (!r.category || !Object.values(BusinessCategory).includes(r.category as BusinessCategory)) {
        throw new AppError('Categoría desconocida', 400);
      }
      redirect = { kind: 'category', category: r.category };
    } else {
      if (!r.businessId || !Types.ObjectId.isValid(r.businessId)) throw new AppError('Negocio inválido', 400);
      const business = await Business.exists({ _id: r.businessId, ...VISIBLE_BUSINESS });
      if (!business) throw new AppError('Ese negocio no existe o no está visible en la app', 404);
      redirect = { kind: 'business', businessId: new Types.ObjectId(r.businessId) };
    }
  }

  const rule = await SearchRule.findOneAndUpdate(
    { term },
    {
      $set: { termRaw: input.term.trim(), kind: input.kind, synonymOf, redirect, note: input.note ?? '', createdBy: adminId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  await cache.del(CACHE_KEY);
  return rule;
}

export async function removeRule(id: string): Promise<void> {
  const res = await SearchRule.deleteOne({ _id: id });
  if (res.deletedCount === 0) throw new AppError('Regla no encontrada', 404);
  await cache.del(CACHE_KEY);
}

export async function listRules() {
  return SearchRule.find().sort({ updatedAt: -1 }).limit(200).populate('redirect.businessId', 'name').lean();
}

/** Términos que ya se marcaron como atendidos (para sacarlos de "sin resultado"). */
export async function handledTerms(): Promise<string[]> {
  const rows = await SearchRule.find({ kind: 'handled' }).select('term').lean();
  return rows.map((r) => r.term);
}

export const searchRuleService = { ruleFor, upsertRule, removeRule, listRules, handledTerms };
