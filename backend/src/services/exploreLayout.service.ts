import { Types } from 'mongoose';
import {
  Business, DiscoveryCollection, ExploreLayoutState, ExploreLayoutVersion,
  EXPLORE_GLOBAL_SCOPE, daypartAt, DISCOVERY_OPTIONS,
} from '../models';
import type { Daypart, DisplayVariant, IDiscoveryCollection, RuleDSL } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { cache, CachePrefix, invalidatePrefixes } from '../cache';
import { VISIBLE_BUSINESS, withinRadius, withDistance } from '../utils/catalogQuery';
import {
  assemblePlan, isBuildableNow, loadCandidates, needsCoords, readCoords, weekdayAt,
  DEFAULT_MAX_DISTANCE,
  type CollectionPlan, type DiscoveryCollectionEntry, type PlanSlot, type PublicSectionProduct, type SlotSizing,
} from './discovery.service';
import { getExploreBanners, type PromoEntry } from './explore.service';
import { toCuratedBusiness, type CuratedBusiness } from './homeSections.service';
import type { PublicAd } from './advertisement.service';
import { DEFAULT_EXPLORE_LAYOUT } from '../constants/exploreLayoutDefault';
import {
  EXPLORE_SCHEMA_VERSION, HEADER_VARIANTS, MAX_GRID_ITEMS, MAX_SECTIONS, PRODUCT_CARDS,
  draftSectionsSchema, parseSectionsLenient, publishProblems,
  type BusinessesSection, type ExploreSection, type ProductLayout, type ProductsSection,
} from '../validators/exploreLayout.validator';

/**
 * Explorar como configuración publicada.
 *
 * El recorrido es **configuración → resolución → secciones**: el panel
 * publica una lista de secciones (`ExploreLayoutVersion`), el servidor la
 * resuelve contra el catálogo en una sola consulta (`resolveLayout`) y la
 * app pinta lo que recibe sin decidir nada.
 *
 * Tres garantías que no se negocian:
 *
 * 1. **Explorar nunca queda en blanco.** Lo publicado se lee sección por
 *    sección; lo ilegible se descarta, y si no queda contenido se sirve
 *    `DEFAULT_EXPLORE_LAYOUT`.
 * 2. **Una sola consulta al catálogo** y una sola petición desde la app,
 *    igual que antes del constructor (`docs/EXPLORAR.md` §11 R2).
 * 3. **Los APK ya instalados siguen funcionando**: sin `?layout=1` la
 *    respuesta es la de siempre (`toLegacyEntries`).
 */

const LAYOUT_CACHE_TTL_SECONDS = 300;

/** Cuántos productos lleva, como mucho, un carrusel según sus filas. */
const CAROUSEL_CAPS: Record<1 | 2 | 3, number> = { 1: 10, 2: 16, 3: 18 };

/** Menos de esto no se publica como sección de negocios. */
const MIN_BUSINESSES = 3;

// ── Lo que sale hacia la app ─────────────────────────────────────────

interface ResolvedBase {
  id: string;
  title: string;
  subtitle: string;
  showTitle: boolean;
  headerVariant: (typeof HEADER_VARIANTS)[number];
}

export interface ResolvedProductsSection extends ResolvedBase {
  type: 'products';
  layout: ProductLayout;
  /** La clave de la colección: la app la usa para su ilustración y su encabezado. */
  key: string;
  illustration?: string;
  /** La variante más cercana, para quien todavía pinta por `displayVariant`. */
  displayVariant: DisplayVariant;
  products: PublicSectionProduct[];
  /** La banda de la que salió, si la eligió el motor y no el admin. */
  fromBand?: string;
}

export interface ResolvedBusinessesSection extends ResolvedBase {
  type: 'businesses';
  layout: { kind: 'row' | 'spotlight' };
  businesses: CuratedBusiness[];
}

export interface ResolvedPromoSection {
  id: string;
  type: 'promo';
  includeAd: boolean;
  banners: PromoEntry[];
}

export type ResolvedSection = ResolvedProductsSection | ResolvedBusinessesSection | ResolvedPromoSection;

export interface ResolvedLayout {
  sections: ResolvedSection[];
  /** Para el panel: secciones vacías, pesos repetidos, banners duplicados. */
  warnings: string[];
}

/** La forma de `/explore` que conocen los APK anteriores al constructor. */
export type LegacyExploreEntry =
  | (Omit<DiscoveryCollectionEntry, 'personal'>)
  | { kind: 'promo'; order: number; banners: PromoEntry[] };

export interface ResolveContext {
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
  now?: Date;
  seed?: number;
}

// ── Lo publicado ─────────────────────────────────────────────────────

function hasContent(sections: ExploreSection[]): boolean {
  return sections.some((s) => !s.hidden && s.type !== 'promo');
}

function defaultLayout(): ExploreSection[] {
  return parseSectionsLenient(DEFAULT_EXPLORE_LAYOUT).sections;
}

/**
 * La versión vigente, o el respaldo en código.
 *
 * Lo cacheado es JSON (las fechas vuelven como texto), así que se vuelve a
 * pasar por Zod en cada lectura: es barato y es lo que convierte un
 * documento dañado en "se descartó una sección", no en una pantalla rota.
 */
export async function getPublishedLayout(
  scope = EXPLORE_GLOBAL_SCOPE
): Promise<{ version: number; sections: ExploreSection[] }> {
  const cached = await cache.wrap(`${CachePrefix.EXPLORE_LAYOUT}${scope}`, LAYOUT_CACHE_TTL_SECONDS, async () => {
    const state = await ExploreLayoutState.findOne({ scope }).select('currentVersion').lean();
    if (!state?.currentVersion) return { version: 0, sections: [] as unknown[] };
    const doc = await ExploreLayoutVersion.findOne({ scope, version: state.currentVersion }).select('sections').lean();
    return { version: doc ? state.currentVersion : 0, sections: (doc?.sections ?? []) as unknown[] };
  });

  if (!cached.version) return { version: 0, sections: defaultLayout() };

  const { sections, dropped } = parseSectionsLenient(cached.sections);
  if (dropped) {
    console.error(`[EXPLORE_LAYOUT] La versión ${cached.version} tiene ${dropped} sección(es) ilegible(s): se descartan`);
  }
  if (!hasContent(sections)) {
    console.error(`[EXPLORE_LAYOUT] La versión ${cached.version} no dejó contenido legible: se sirve el layout por defecto`);
    return { version: 0, sections: defaultLayout() };
  }
  return { version: cached.version, sections };
}

// ── Resolución ───────────────────────────────────────────────────────

function rulesAllow(section: ExploreSection, now: Date, daypart: Daypart, weekday: number): boolean {
  const { dayparts, weekdays, startDate, endDate } = section.rules;
  if (startDate && startDate > now) return false;
  if (endDate && endDate < now) return false;
  if (dayparts.length && !dayparts.includes(daypart)) return false;
  if (weekdays.length && !weekdays.includes(weekday)) return false;
  return true;
}

/** La variante de tarjeta más cercana a un layout, para la respuesta legacy. */
function displayVariantFor(layout: ProductLayout): DisplayVariant {
  if (layout.kind === 'grid') return 'grid';
  return layout.rows === 1 ? layout.card : 'compact';
}

/**
 * Cuántos productos pide un layout.
 *
 * Una cuadrícula siempre intenta llenarse y solo enseña filas completas; un
 * carrusel respeta el tamaño de la colección hasta el tope de sus filas.
 */
function sizingFor(layout: ProductLayout, plan: CollectionPlan): SlotSizing {
  if (layout.kind === 'grid') {
    return {
      targetSize: Math.min(layout.columns * layout.rows, MAX_GRID_ITEMS),
      minSize: Math.max(plan.minSize, layout.columns),
      multipleOf: layout.columns,
    };
  }
  const cap = CAROUSEL_CAPS[layout.rows];
  return { targetSize: Math.min(plan.targetSize, cap), minSize: Math.min(plan.minSize, cap) };
}

function label(section: { title: string; id: string }): string {
  return section.title ? `"${section.title}"` : `la sección ${section.id}`;
}

/**
 * El plan del motor para una sección de productos, o `null` con el motivo.
 *
 * `facetKey` es propio de la sección: dos secciones pueden usar la misma
 * colección con layouts distintos y cada una necesita su rama del `$facet`.
 */
function planForSection(
  section: ProductsSection,
  byKey: Map<string, IDiscoveryCollection>,
  hasCoords: boolean
): { plan: CollectionPlan } | { reason: string } {
  const facetKey = `sec_${section.id}`;
  const source = section.dataSource;
  const displayVariant = displayVariantFor(section.layout);

  if (source.kind === 'collection') {
    const collection = byKey.get(source.key);
    if (!collection) return { reason: `${label(section)}: la colección "${source.key}" no existe, está apagada o no aplica a esta hora` };
    return {
      plan: {
        key: collection.key,
        facetKey,
        order: collection.order,
        title: section.title || collection.title,
        subtitle: section.subtitle || collection.subtitle,
        illustration: collection.illustration,
        displayVariant,
        rule: collection.rule,
        rotation: collection.rotation,
        targetSize: collection.targetSize,
        minSize: collection.minSize,
        fallbackKeywords: collection.fallbackKeywords,
      },
    };
  }

  if (source.kind === 'rule') {
    const rule = source.rule as RuleDSL;
    if (!hasCoords && needsCoords(rule)) {
      return { reason: `${label(section)}: ordena por cercanía y no hay ubicación para calcularla` };
    }
    return {
      plan: {
        key: `layout-${section.id}`,
        facetKey,
        order: 0,
        title: section.title,
        subtitle: section.subtitle,
        displayVariant,
        rule,
        rotation: 'none',
        targetSize: source.targetSize,
        minSize: Math.min(source.minSize, source.targetSize),
      },
    };
  }

  return {
    plan: {
      key: `layout-${section.id}`,
      facetKey,
      order: 0,
      title: section.title,
      subtitle: section.subtitle,
      displayVariant,
      rule: { all: [], sortBy: 'relevance' },
      rotation: 'none',
      targetSize: source.productIds.length,
      minSize: 1,
      manualIds: source.productIds.map((id) => new Types.ObjectId(id)),
    },
  };
}

async function resolveBusinesses(
  section: BusinessesSection,
  ctx: { coords: ReturnType<typeof readCoords>; maxDistance: number; city?: string }
): Promise<CuratedBusiness[]> {
  const base = {
    ...VISIBLE_BUSINESS,
    ...withinRadius(ctx.coords, ctx.maxDistance),
    ...(ctx.city ? { city: ctx.city } : {}),
  };
  const max = section.layout.kind === 'spotlight' ? 3 : 20;
  const source = section.dataSource;

  if (source.kind === 'manual') {
    const ids = source.businessIds.map((id) => new Types.ObjectId(id));
    const docs = await Business.find({ ...base, _id: { $in: ids } }).lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ids
      .map((id) => byId.get(String(id)))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .slice(0, max)
      .map((d) => toCuratedBusiness(d as any));
  }

  const filter: Record<string, unknown> = { ...base };
  if (source.categories.length) filter.category = { $in: source.categories };
  if (source.minRating > 0) filter.rating = { $gte: source.minRating };
  const limit = Math.min(source.limit, max);

  if (source.sortBy === 'nearby' && ctx.coords) {
    const docs = await Business.find(filter).limit(60).lean();
    return withDistance(docs, ctx.coords, 'location')
      .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
      .slice(0, limit)
      .map((d) => toCuratedBusiness(d as any));
  }

  const sort: Record<string, 1 | -1> = source.sortBy === 'newest'
    ? { createdAt: -1, _id: 1 }
    : { rating: -1, totalReviews: -1, _id: 1 };
  const docs = await Business.find(filter).sort(sort).limit(limit).lean();
  return docs.map((d) => toCuratedBusiness(d as any));
}

type Weight = 'protagonista' | 'secundario' | 'ninguno';

/** Los tres pesos de `docs/EXPLORAR.md` §5, sobre lo que de verdad se va a pintar. */
function weightOf(section: ResolvedSection): Weight {
  if (section.type === 'promo') return 'ninguno';
  if (section.type === 'businesses') return section.layout.kind === 'spotlight' ? 'protagonista' : 'secundario';
  if (section.layout.kind === 'grid') return 'ninguno';
  if (section.layout.rows > 1) return 'secundario';
  return ['large', 'featured'].includes(section.layout.card) ? 'protagonista' : 'secundario';
}

function titleOf(section: ResolvedSection): string {
  return section.type === 'promo' ? 'banners' : `"${section.title || section.id}"`;
}

/**
 * Resuelve un layout contra el catálogo.
 *
 * Todo lo que es de productos —secciones fijas y bandas— sale de una sola
 * consulta (`loadCandidates`) y se reparte en el orden en que se pinta
 * (`assemblePlan`): la sección de arriba gana el producto repetido. Negocios
 * y banners van en paralelo. Una sección que falla se descarta con su aviso;
 * nunca tumba el resto.
 */
export async function resolveLayout(sections: ExploreSection[], ctx: ResolveContext = {}): Promise<ResolvedLayout> {
  const now = ctx.now ?? new Date();
  const daypart = daypartAt(now);
  const weekday = weekdayAt(now);
  const coords = readCoords(ctx);
  const maxDistance = ctx.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const warnings: string[] = [];

  const visible = sections.filter((s) => !s.hidden && rulesAllow(s, now, daypart, weekday));

  const pinnedKeys = new Set<string>();
  for (const s of visible) {
    if (s.type === 'products' && s.dataSource.kind === 'collection') pinnedKeys.add(s.dataSource.key);
  }
  const bands = visible.filter((s) => s.type === 'discovery_band');

  // Las de la banda salen de las de Explorar; una colección fijada puede ser
  // cualquiera, incluso una del inicio.
  const stored = bands.length || pinnedKeys.size
    ? await DiscoveryCollection.find({
        isActive: true,
        $or: [{ feed: { $in: ['explore', 'both'] } }, { key: { $in: Array.from(pinnedKeys) } }],
      }).sort({ order: 1 }).lean<IDiscoveryCollection[]>()
    : [];
  const buildable = stored.filter((c) => isBuildableNow(c, now, daypart, coords));
  const byKey = new Map(buildable.map((c) => [c.key, c]));
  const pool = bands.length ? buildable.filter((c) => c.feed !== 'home' && !pinnedKeys.has(c.key)) : [];

  const slots: PlanSlot[] = [];
  const slotOf = new Map<string, number>();
  const plans: CollectionPlan[] = [...pool];

  for (const s of visible) {
    if (s.type === 'products') {
      const result = planForSection(s, byKey, !!coords);
      if ('reason' in result) {
        warnings.push(result.reason);
        continue;
      }
      slotOf.set(s.id, slots.length);
      slots.push({ kind: 'fixed', plan: result.plan, sizing: sizingFor(s.layout, result.plan) });
      plans.push(result.plan);
    } else if (s.type === 'discovery_band') {
      slotOf.set(s.id, slots.length);
      slots.push({
        kind: 'band',
        take: s.take,
        sizing: (plan, position) => sizingFor(s.pattern[position % s.pattern.length], plan),
      });
    }
  }

  const businessSections = visible.filter((s): s is BusinessesSection => s.type === 'businesses');
  const needsBanners = visible.some((s) => s.type === 'promo');

  const [loaded, businessLists, banners] = await Promise.all([
    slots.length
      ? loadCandidates(plans, { lat: ctx.lat, lng: ctx.lng, maxDistance, city: ctx.city, now, seed: ctx.seed })
      : Promise.resolve(null),
    Promise.all(businessSections.map((s) =>
      resolveBusinesses(s, { coords, maxDistance, city: ctx.city }).catch((error) => {
        console.error('[EXPLORE_LAYOUT] Sección de negocios descartada', s.id, (error as Error).message);
        return [] as CuratedBusiness[];
      })
    )),
    needsBanners ? getExploreBanners() : Promise.resolve([] as PromoEntry[]),
  ]);

  const assembled = loaded ? assemblePlan(slots, pool, loaded) : slots.map(() => []);
  const businessesById = new Map(businessSections.map((s, i) => [s.id, businessLists[i]]));

  const out: ResolvedSection[] = [];
  let promoCount = 0;

  for (const s of visible) {
    const base: ResolvedBase = {
      id: s.id,
      title: s.title,
      subtitle: s.subtitle,
      showTitle: s.showTitle,
      headerVariant: s.headerVariant,
    };

    if (s.type === 'products') {
      const slot = slotOf.get(s.id);
      if (slot === undefined) continue;
      const entry = assembled[slot][0];
      if (!entry) {
        warnings.push(`${label(s)} se queda vacía: no hay suficientes productos disponibles ahora`);
        continue;
      }
      out.push({
        ...base,
        type: 'products',
        title: entry.title,
        subtitle: entry.subtitle ?? '',
        layout: s.layout,
        key: entry.key,
        illustration: entry.illustration,
        displayVariant: entry.displayVariant,
        products: entry.products,
      });
      continue;
    }

    if (s.type === 'discovery_band') {
      const entries = assembled[slotOf.get(s.id)!] ?? [];
      if (!entries.length) warnings.push(`${label(s)} no recibió ninguna colección (otra banda anterior se las llevó todas, o no hay catálogo)`);
      entries.forEach((entry, position) => {
        const layout = s.pattern[position % s.pattern.length];
        out.push({
          id: `${s.id}:${entry.key}`,
          type: 'products',
          title: entry.title,
          subtitle: entry.subtitle ?? '',
          showTitle: true,
          headerVariant: 'auto',
          layout,
          key: entry.key,
          illustration: entry.illustration,
          displayVariant: displayVariantFor(layout),
          products: entry.products,
          fromBand: s.id,
        });
      });
      continue;
    }

    if (s.type === 'businesses') {
      const list = businessesById.get(s.id) ?? [];
      const needed = s.layout.kind === 'spotlight' ? 3 : MIN_BUSINESSES;
      if (list.length < needed) {
        warnings.push(`${label(s)} se queda vacía: necesita al menos ${needed} negocios visibles en la zona`);
        continue;
      }
      out.push({ ...base, type: 'businesses', layout: s.layout, businesses: list });
      continue;
    }

    promoCount++;
    out.push({ id: s.id, type: 'promo', includeAd: s.includeAd, banners });
  }

  if (promoCount > 1) warnings.push('Hay más de un bloque de banners: todos muestran los mismos banners');

  // `docs/EXPLORAR.md` §4: dos protagonistas seguidos se leen como uno solo
  // y el segundo se pierde. Es un aviso, no un bloqueo: el orden es del admin.
  for (let i = 1; i < out.length; i++) {
    if (weightOf(out[i - 1]) === 'protagonista' && weightOf(out[i]) === 'protagonista') {
      warnings.push(`${titleOf(out[i - 1])} y ${titleOf(out[i])} son dos secciones grandes seguidas: la segunda pierde fuerza`);
    }
  }

  return { sections: out, warnings };
}

/**
 * Mete la campaña pagada del momento en el bloque que la lleva.
 *
 * Se llama **después** de la caché, en cada petición: la campaña es por
 * petición (topes por persona, rotación entre campañas), el resto del feed
 * es por zona. Si lo publicado perdió su hueco —no debería: publicar lo
 * exige—, el anuncio vuelve a media altura, como antes del constructor. Los
 * bloques de banners que quedan vacíos se quitan aquí y no en la resolución,
 * porque hasta este punto no se sabe si el anuncio los llenaba.
 */
export function withAd(sections: ResolvedSection[], ad: PublicAd | null): ResolvedSection[] {
  let result = sections;
  if (ad) {
    const adBanner: PromoEntry = {
      id: ad.id,
      imageUrl: ad.flyerUrl,
      title: ad.campaignName,
      description: '',
      buttonText: '',
      actionType: ad.actionType,
      actionValue: ad.businessId ?? '',
      durationSeconds: ad.durationSeconds,
      isAd: true,
    };
    const slot = sections.findIndex((s) => s.type === 'promo' && s.includeAd);
    if (slot >= 0) {
      result = sections.map((s, i) =>
        i === slot && s.type === 'promo' ? { ...s, banners: [adBanner, ...s.banners] } : s
      );
    } else {
      const middle = Math.floor(sections.length / 2);
      result = [
        ...sections.slice(0, middle),
        { id: 'ad-fallback', type: 'promo', includeAd: true, banners: [adBanner] },
        ...sections.slice(middle),
      ];
    }
  }
  return result.filter((s) => s.type !== 'promo' || s.banners.length > 0);
}

/**
 * La respuesta de siempre, para los APK anteriores al constructor.
 *
 * Solo lleva lo que esas versiones saben pintar: colecciones de productos y
 * bloques de banners. Las secciones de negocios no existían en Explorar y se
 * omiten. La `key` tiene que ser única —la usan como clave de React—, así
 * que una colección usada dos veces se renombra en la segunda aparición.
 */
export function toLegacyEntries(sections: ResolvedSection[]): LegacyExploreEntry[] {
  const used = new Set<string>();
  const out: LegacyExploreEntry[] = [];
  sections.forEach((s, i) => {
    const order = (i + 1) * 10;
    if (s.type === 'promo') {
      if (s.banners.length) out.push({ kind: 'promo', order, banners: s.banners });
      return;
    }
    if (s.type !== 'products') return;
    const key = used.has(s.key) ? `layout-${s.id}` : s.key;
    used.add(key);
    out.push({
      kind: 'collection',
      order,
      key,
      title: s.title,
      subtitle: s.subtitle || undefined,
      illustration: s.illustration,
      displayVariant: s.displayVariant,
      products: s.products,
    });
  });
  return out;
}

// ── Borrador, publicación e historial ───────────────────────────────

const CONFLICT = 'EXPLORE_LAYOUT_CONFLICT';

function conflict(message: string): AppError {
  return new AppError(message, 409, CONFLICT);
}

export async function getDraft(scope = EXPLORE_GLOBAL_SCOPE) {
  const state = await ExploreLayoutState.findOne({ scope }).populate('updatedBy', 'name email').lean();
  if (!state) {
    // Nadie ha guardado nunca: el borrador arranca desde lo que se ve hoy.
    const published = await getPublishedLayout(scope);
    return {
      sections: published.sections,
      revision: 0,
      currentVersion: 0,
      dropped: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const { sections, dropped } = parseSectionsLenient(state.draft);
  return {
    sections,
    revision: state.revision,
    currentVersion: state.currentVersion,
    dropped,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy ?? null,
  };
}

/**
 * Guarda el borrador si nadie lo cambió desde que se leyó.
 *
 * La revisión va dentro del filtro, no se compara después: dos admins que
 * guardan a la vez no pueden pisarse — el segundo recibe un 409 y recarga.
 */
export async function saveDraft(
  sections: ExploreSection[],
  expectedRevision: number,
  userId: string,
  scope = EXPLORE_GLOBAL_SCOPE
): Promise<{ revision: number }> {
  const updatedBy = new Types.ObjectId(userId);

  if (expectedRevision === 0) {
    try {
      const created = await ExploreLayoutState.create({
        scope,
        draft: sections,
        schemaVersion: EXPLORE_SCHEMA_VERSION,
        revision: 1,
        currentVersion: 0,
        updatedBy,
      });
      return { revision: created.revision };
    } catch (error: any) {
      if (error?.code === 11000) throw conflict('Otra persona guardó el borrador antes: recarga para ver sus cambios');
      throw error;
    }
  }

  const updated = await ExploreLayoutState.findOneAndUpdate(
    { scope, revision: expectedRevision },
    { $set: { draft: sections, schemaVersion: EXPLORE_SCHEMA_VERSION, updatedBy }, $inc: { revision: 1 } },
    { new: true }
  );
  if (!updated) throw conflict('Otra persona guardó el borrador antes: recarga para ver sus cambios');
  return { revision: updated.revision };
}

/**
 * Publica el borrador tal como estaba en `expectedRevision`.
 *
 * Exigir la revisión es lo que impide publicar sin querer la edición de
 * otro admin que llegó después de tu vista previa. Sin transacciones (los
 * tests corren sin replica set), el orden es: insertar la versión —el
 * índice único `{scope, version}` deja pasar a un solo publicador— y luego
 * mover el puntero con la revisión y la versión anterior dentro del filtro.
 * Si el puntero no se mueve, la versión recién insertada se borra: nunca
 * queda una versión huérfana que bloquee la siguiente publicación.
 */
export async function publish(
  expectedRevision: number,
  userId: string,
  note: string,
  scope = EXPLORE_GLOBAL_SCOPE,
  restoredFrom: number | null = null
): Promise<{ version: number }> {
  const state = await ExploreLayoutState.findOne({ scope }).lean();
  if (!state) throw new AppError('Guarda el borrador antes de publicarlo', 400, 'EXPLORE_LAYOUT_NO_DRAFT');
  if (state.revision !== expectedRevision) {
    throw conflict('El borrador cambió desde tu vista previa: revísalo antes de publicar');
  }

  const parsed = draftSectionsSchema.safeParse(state.draft);
  if (!parsed.success) {
    throw new AppError('El borrador tiene secciones que ya no son válidas: ábrelo y corrígelas', 400, 'EXPLORE_LAYOUT_INVALID');
  }
  const problems = publishProblems(parsed.data);
  if (problems.length) throw new AppError(problems.join('. '), 400, 'EXPLORE_LAYOUT_BLOCKED');

  const version = state.currentVersion + 1;
  let createdId: Types.ObjectId;
  try {
    const created = await ExploreLayoutVersion.create({
      scope,
      version,
      sections: parsed.data,
      schemaVersion: EXPLORE_SCHEMA_VERSION,
      publishedBy: new Types.ObjectId(userId),
      publishedAt: new Date(),
      note,
      restoredFrom,
    });
    createdId = created._id as Types.ObjectId;
  } catch (error: any) {
    if (error?.code === 11000) throw conflict('Otra persona acaba de publicar: recarga antes de volver a intentarlo');
    throw error;
  }

  const moved = await ExploreLayoutState.findOneAndUpdate(
    { scope, revision: expectedRevision, currentVersion: state.currentVersion },
    { $set: { currentVersion: version } },
    { new: true }
  );
  if (!moved) {
    await ExploreLayoutVersion.deleteOne({ _id: createdId });
    throw conflict('El borrador cambió mientras se publicaba: revísalo y vuelve a publicar');
  }

  await invalidatePrefixes([CachePrefix.EXPLORE_LAYOUT]);
  return { version };
}

export async function listVersions(scope = EXPLORE_GLOBAL_SCOPE) {
  const [state, versions] = await Promise.all([
    ExploreLayoutState.findOne({ scope }).select('currentVersion').lean(),
    ExploreLayoutVersion.find({ scope })
      .sort({ version: -1 })
      .limit(50)
      .select('version publishedAt publishedBy note restoredFrom')
      .populate('publishedBy', 'name email')
      .lean(),
  ]);
  return { currentVersion: state?.currentVersion ?? 0, versions };
}

/**
 * Trae una versión al borrador, o la republica directamente.
 *
 * Republicar crea la versión N+1 con el contenido de la vieja: el historial
 * nunca se reescribe, y deshacer un error es un solo clic.
 */
export async function restoreVersion(
  version: number,
  expectedRevision: number,
  mode: 'draft' | 'publish',
  userId: string,
  scope = EXPLORE_GLOBAL_SCOPE
): Promise<{ revision: number; publishedVersion: number | null; dropped: number }> {
  const doc = await ExploreLayoutVersion.findOne({ scope, version }).lean();
  if (!doc) throw new AppError('Esa versión no existe', 404);

  const { sections, dropped } = parseSectionsLenient(doc.sections);
  if (!sections.length) throw new AppError('Esa versión ya no se puede leer con el formato actual', 400, 'EXPLORE_LAYOUT_INVALID');

  const { revision } = await saveDraft(sections, expectedRevision, userId, scope);
  if (mode === 'draft') return { revision, publishedVersion: null, dropped };

  const { version: publishedVersion } = await publish(
    revision, userId, `Restaurada la versión ${version}`, scope, version
  );
  return { revision, publishedVersion, dropped };
}

/** Lo que el panel necesita para pintar sus selectores sin inventarse nada. */
export async function getBuilderOptions() {
  const collections = await DiscoveryCollection.find({})
    .select('key title subtitle feed isActive displayVariant dayparts weekdays')
    .sort({ order: 1 })
    .lean();
  return {
    collections,
    discovery: DISCOVERY_OPTIONS,
    headerVariants: HEADER_VARIANTS,
    productCards: PRODUCT_CARDS,
    businessSorts: ['rating', 'newest', 'nearby'],
    limits: { maxSections: MAX_SECTIONS, maxGridItems: MAX_GRID_ITEMS, carouselCaps: CAROUSEL_CAPS },
    schemaVersion: EXPLORE_SCHEMA_VERSION,
    defaultLayout: defaultLayout(),
  };
}

export const exploreLayoutService = {
  getPublishedLayout,
  resolveLayout,
  withAd,
  toLegacyEntries,
  getDraft,
  saveDraft,
  publish,
  listVersions,
  restoreVersion,
  getBuilderOptions,
};
