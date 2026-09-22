import { PipelineStage, Types } from 'mongoose';
import { Business, Order, Product, DiscoveryCollection } from '../models';
import type {
  CollectionFeed, Daypart, DisplayVariant, IDiscoveryCollection, Rule, RuleDSL, SortBy,
} from '../models';
import { daypartAt } from '../models';
import { OrderStatus } from '../types/enums';
import { LatLng } from '../utils/geo';
import { VISIBLE_BUSINESS, withinRadius, withDistance } from '../utils/catalogQuery';
import { productImageUrls } from '../utils/productImageUrls';
import { TAG_KEYWORDS, type ProductTag } from '../constants/productTags';
import { businessService } from './business.service';
import { cache, CachePrefix } from '../cache';

/**
 * El motor de descubrimiento.
 *
 * Sustituye al array `sectionDefs` que vivía dentro de
 * `homeSections.service.ts`: las colecciones ahora se leen de la base
 * (`DiscoveryCollection`) y su regla se traduce aquí a un `$match`.
 *
 * Tres invariantes que conviene no deshacer:
 *
 * 1. **Una sola consulta al catálogo.** Todas las colecciones elegibles
 *    caben en un `$facet` con una rama cada una. Pedir una consulta por
 *    colección sería una petición por sección, y este proyecto ya sabe cómo
 *    se ve eso desde el teléfono cuando el limitador de peticiones responde.
 * 2. **El admin nunca escribe Mongo.** `compileRule()` construye cada
 *    fragmento en código y los valores del formulario entran como operandos,
 *    jamás como operadores ni como nombres de campo.
 * 3. **Primero los negocios, después sus productos.** El filtro geográfico
 *    va antes del `$lookup`, porque después del join el índice 2dsphere ya
 *    no sirve de nada.
 */

// ── Constantes del motor ─────────────────────────────────────────────

const CANDIDATE_LIMIT = 30;
const NEARBY_CANDIDATE_LIMIT = 90;
const ORDER_CANDIDATE_LIMIT = 40;

export const DEFAULT_MAX_DISTANCE = 10_000;

/** Un producto no se repite más de dos veces en todo el feed. */
const MAX_APPEARANCES_PER_PRODUCT = 2;
/**
 * Un negocio no aparece más de tres veces en todo el feed, ni más de dos
 * dentro de una misma colección.
 *
 * Es el tope que faltaba. Hasta ahora el contador solo miraba el producto,
 * así que un comercio con carta grande podía copar una sección entera — los
 * propios tests lo esquivaban usando `category: 'pharmacy'` porque
 * `fast_food` "consume el cupo de repetición antes de tiempo".
 */
const MAX_APPEARANCES_PER_BUSINESS = 3;
const MAX_PER_BUSINESS_IN_SECTION = 2;

/**
 * Cuántas entradas tiene que traer un feed antes de darse por bueno.
 *
 * Garzón no es Bogotá: con los topes de exposición puestos, un catálogo
 * pequeño puede quedarse en tres secciones y media pantalla en blanco. Si no
 * se llega, se relajan los topes en orden antes que servir un feed vacío.
 */
const MIN_FEED_ENTRIES = 6;

const MIN_TRENDING_RECENT_VOLUME = 3;
const MIN_TRENDING_GROWTH = 1.3;

/** 70% relevancia, 30% variedad. Ver `diversify()`. */
const ALPHA = 0.7;

const SALES_CACHE_TTL_SECONDS = 600;

// ── Tipos ────────────────────────────────────────────────────────────

export type { LatLng };

/** Un producto con su negocio ya resuelto, tal como lo pinta una tarjeta. */
export interface SectionProduct {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  image?: string | null;
  imageAsset?: unknown;
  price: number;
  discountPrice?: number | null;
  discountPercent: number;
  effectivePrice: number;
  isFeatured: boolean;
  stock?: number | null;
  createdAt: Date;
  prepTimeMinutes?: number | null;
  tags?: string[];
  businessId: Types.ObjectId;
  businessName: string;
  businessLogo?: string | null;
  businessCategory: string;
  businessRating: number;
  businessTotalReviews: number;
  businessDeliveryTime: number;
  businessFreeDeliveryThreshold: number;
  businessLocation?: { coordinates?: number[] };
  businessSchedule: Record<string, { open: string; close: string; isOpen: boolean }>;
  businessCreatedAt: Date;
  distanceMeters?: number;
}

/**
 * El producto tal como sale por la API.
 *
 * `businessSchedule` y `businessCreatedAt` solo existen para decidir aquí
 * dentro qué entra y qué no; la app no los pinta y no tiene sentido mandarlos
 * en cada carga. `images` se calcula a mano porque viene de un virtual de
 * Mongoose (`Product.images`) que `aggregate()` **nunca** invoca — sin esto
 * la app se quedaría con la foto vieja, sin variantes, en todo el feed.
 */
export type PublicSectionProduct =
  Omit<SectionProduct, 'businessSchedule' | 'businessCreatedAt' | 'imageAsset'> & {
    images: ReturnType<typeof productImageUrls>;
  };

export interface DiscoveryCollectionEntry {
  kind: 'collection';
  order: number;
  key: string;
  title: string;
  subtitle?: string;
  illustration?: string;
  displayVariant: DisplayVariant;
  personal?: boolean;
  products: PublicSectionProduct[];
}

export interface DiscoveryOptions {
  feed: CollectionFeed;
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
  /** Para rotar de forma estable. Sin esto no hay rotación, solo orden fijo. */
  seed?: number;
  now?: Date;
}

// ── Proyección compartida ────────────────────────────────────────────

export const PROJECT_STAGE: PipelineStage.Project = {
  $project: {
    _id: 1,
    name: 1,
    description: 1,
    image: 1,
    imageAsset: 1,
    price: 1,
    discountPrice: 1,
    discountPercent: 1,
    effectivePrice: 1,
    isFeatured: 1,
    stock: 1,
    createdAt: 1,
    prepTimeMinutes: 1,
    tags: 1,
    businessId: '$business._id',
    businessName: '$business.name',
    businessLogo: '$business.logo',
    businessCategory: '$business.category',
    businessRating: '$business.rating',
    businessTotalReviews: '$business.totalReviews',
    businessDeliveryTime: '$business.deliveryTime',
    businessFreeDeliveryThreshold: '$business.freeDeliveryThreshold',
    businessLocation: '$business.location',
    businessSchedule: '$business.schedule',
    businessCreatedAt: '$business.createdAt',
  },
};

/** `VISIBLE_BUSINESS`, pero contra el negocio ya unido al producto. */
export function joinedBusinessMatch(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(VISIBLE_BUSINESS).map(([key, value]) => [`business.${key}`, value])
  );
}

export function readCoords(options: { lat?: number; lng?: number }): LatLng | null {
  const { lat, lng } = options;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// ── El compilador de reglas ──────────────────────────────────────────

export interface CompileContext {
  now: Date;
  /** Ids ya rankeados por ventas, por ventana. */
  salesIds: Record<string, Types.ObjectId[]>;
  /**
   * Si una regla por etiquetas puede caer a la regex de palabras clave.
   *
   * Es el puente mientras `scripts/backfillProductTags.ts` no haya corrido:
   * sin él, el día del despliegue todas las colecciones por etiqueta salen
   * vacías porque el campo nació en blanco.
   */
  fallbackKeywords: boolean;
}

/** Las palabras de un grupo de etiquetas, unidas para el respaldo por regex. */
function keywordsFor(tags: string[]): string {
  return tags
    .flatMap((tag) => TAG_KEYWORDS[tag as ProductTag] ?? [])
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Traduce **una** condición del lenguaje cerrado a un fragmento de `$match`.
 *
 * Cada rama construye su objeto a mano. Ningún valor que venga del panel
 * acaba siendo una clave ni un operador: `any`, `minPercent`, `max` y
 * compañía entran siempre como valor de un operador escrito aquí.
 *
 * Devuelve `null` cuando la condición no se puede expresar contra el
 * catálogo —`nearby` ordena, no filtra; `personal` necesita una sesión— y el
 * llamador decide qué hacer con ello.
 */
export function compileRule(rule: Rule, ctx: CompileContext): Record<string, unknown> | null {
  switch (rule.source) {
    case 'tags': {
      const byTag = { tags: { $in: rule.any } };
      if (!ctx.fallbackKeywords) return byTag;
      const words = keywordsFor(rule.any);
      // Sin palabras conocidas no hay respaldo posible: mejor la consulta
      // indexada sola que un `$or` con una regex que no encuentra nada.
      if (!words) return byTag;
      return { $or: [byTag, { searchName: { $regex: words } }] };
    }

    case 'discount':
      return { discountPercent: { $gte: rule.minPercent } };

    case 'price': {
      const range: Record<string, number> = {};
      if (typeof rule.min === 'number') range.$gte = rule.min;
      if (typeof rule.max === 'number') range.$lte = rule.max;
      return Object.keys(range).length ? { effectivePrice: range } : null;
    }

    case 'prepTime':
      return { effectivePrepTime: { $lte: rule.maxMinutes } };

    case 'new':
      return rule.of === 'business'
        ? { 'business.createdAt': { $gte: daysAgo(ctx.now, rule.withinDays) } }
        : { createdAt: { $gte: daysAgo(ctx.now, rule.withinDays) } };

    case 'featured':
      return { isFeatured: true };

    case 'sales': {
      const ids = ctx.salesIds[rule.window] ?? [];
      // Un `$in` vacío no encuentra nada, que es exactamente lo correcto:
      // sin ventas todavía, la colección no se publica.
      return { _id: { $in: ids } };
    }

    case 'businessRating': {
      const match: Record<string, unknown> = { 'business.rating': { $gte: rule.min } };
      if (typeof rule.minReviews === 'number') {
        match['business.totalReviews'] = { $gte: rule.minReviews };
      }
      return match;
    }

    case 'businessCategory':
      return { 'business.category': { $in: rule.any } };

    // Ordena por distancia, no filtra: el radio ya lo aplicó
    // `visibleBusinessIds` antes del join.
    case 'nearby':
      return null;

    // Necesita una sesión. Lo resuelve la capa personal, no el feed
    // compartido, porque su resultado no se puede cachear por zona.
    case 'personal':
      return null;

    default:
      return null;
  }
}

/** Todas las condiciones de una colección, en AND. */
export function compileDSL(dsl: RuleDSL, ctx: CompileContext): Record<string, unknown> | null {
  const fragments = dsl.all
    .map((rule) => compileRule(rule, ctx))
    .filter((f): f is Record<string, unknown> => f !== null);

  if (!fragments.length) return null;
  if (fragments.length === 1) return fragments[0];
  // `$and` explícito y no una fusión de claves: dos condiciones sobre el
  // mismo campo (`price` con mínimo y máximo por separado, por ejemplo) se
  // pisarían al fusionar objetos.
  return { $and: fragments };
}

// El `_id` final en cada orden no es cosmético: sin un desempate estable,
// dos productos con el mismo descuento (o la misma fecha, el mismo precio…)
// no tienen orden garantizado entre una ejecución de Mongo y la siguiente.
// Con `/home-sections` y `/explore` consultando el mismo catálogo en
// paralelo, esa falta de determinismo hacía que ambas pantallas eligieran
// **conjuntos distintos** de productos "empatados" para la misma colección
// — no por la rotación por semilla, que es intencional, sino por una
// ejecución de `$sort` que Mongo no promete repetir.
const SORT_STAGES: Record<SortBy, Record<string, 1 | -1>> = {
  relevance: { isFeatured: -1, discountPercent: -1, createdAt: -1, _id: 1 },
  discount: { discountPercent: -1, _id: 1 },
  price_asc: { effectivePrice: 1, _id: 1 },
  price_desc: { effectivePrice: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  rating: { 'business.rating': -1, 'business.totalReviews': -1, _id: 1 },
  prep: { effectivePrepTime: 1, _id: 1 },
  // La distancia se calcula en JS después del `$facet` (haversine sobre las
  // coordenadas ya proyectadas), así que aquí solo se pide un orden estable.
  distance: { createdAt: -1, _id: 1 },
  // El orden de ventas lo impone `orderByIds` con la lista ya rankeada.
  sales: { createdAt: -1, _id: 1 },
};

export function sortStageFor(sortBy: SortBy): Record<string, 1 | -1> {
  return SORT_STAGES[sortBy] ?? SORT_STAGES.relevance;
}

// ── Elegibilidad ─────────────────────────────────────────────────────

/** Si una colección debe entrar en el feed ahora mismo. */
export function isEligibleNow(
  collection: Pick<IDiscoveryCollection, 'isActive' | 'dayparts' | 'weekdays' | 'startDate' | 'endDate'>,
  now: Date,
  daypart: Daypart
): boolean {
  if (!collection.isActive) return false;
  if (collection.startDate && collection.startDate > now) return false;
  if (collection.endDate && collection.endDate < now) return false;
  if (collection.dayparts?.length && !collection.dayparts.includes(daypart)) return false;
  if (collection.weekdays?.length && !collection.weekdays.includes(now.getDay())) return false;
  return true;
}

/** Si la regla necesita una sesión para resolverse. */
export function isPersonal(dsl: RuleDSL): boolean {
  return dsl.all.some((rule) => rule.source === 'personal');
}

/** Si la regla ordena por cercanía y por tanto exige coordenadas. */
export function needsCoords(dsl: RuleDSL): boolean {
  return dsl.all.some((rule) => rule.source === 'nearby') || dsl.sortBy === 'distance';
}

// ── Ranking por ventas ───────────────────────────────────────────────

interface OrderRanked {
  _id: Types.ObjectId;
}

/**
 * Lo que depende de ventas: solo mira `orders`, nunca `products`. Una sola
 * consulta con `$facet` resuelve las tres ventanas a la vez.
 */
async function rankBySales(): Promise<Record<string, OrderRanked[]>> {
  const now = Date.now();
  const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const since90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const since14 = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const pipeline: PipelineStage[] = [
    { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: since90 } } },
    {
      $facet: {
        mostOrdered: [
          { $match: { deliveredAt: { $gte: since30 } } },
          { $unwind: '$items' },
          { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' } } },
          { $sort: { sold: -1 } },
          { $limit: ORDER_CANDIDATE_LIMIT },
        ],
        // Cuántas personas distintas repitieron, no cuántos pedidos hubo:
        // el total premiaría al que más vende, que ya tiene su sección.
        repeat: [
          { $unwind: '$items' },
          {
            $group: {
              _id: { productId: '$items.productId', clientId: '$clientId' },
              orders: { $sum: 1 },
            },
          },
          { $match: { orders: { $gte: 2 } } },
          { $group: { _id: '$_id.productId', repeatClients: { $sum: 1 } } },
          { $sort: { repeatClients: -1 } },
          { $limit: ORDER_CANDIDATE_LIMIT },
        ],
        // Crecimiento real: el +1 del denominador evita el "infinito" de un
        // producto sin ventas previas; el mínimo de volumen evita que un
        // pedido aislado se lea como tendencia.
        trending: [
          { $match: { deliveredAt: { $gte: since14 } } },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.productId',
              recent: { $sum: { $cond: [{ $gte: ['$deliveredAt', since7] }, '$items.quantity', 0] } },
              previous: { $sum: { $cond: [{ $lt: ['$deliveredAt', since7] }, '$items.quantity', 0] } },
            },
          },
          { $match: { recent: { $gte: MIN_TRENDING_RECENT_VOLUME } } },
          { $addFields: { growth: { $divide: ['$recent', { $add: ['$previous', 1] }] } } },
          { $match: { growth: { $gt: MIN_TRENDING_GROWTH } } },
          { $sort: { growth: -1, recent: -1 } },
          { $limit: ORDER_CANDIDATE_LIMIT },
        ],
      },
    },
  ];

  const [result] = await Order.aggregate(pipeline);
  return {
    mostOrdered: result?.mostOrdered ?? [],
    repeat: result?.repeat ?? [],
    trending: result?.trending ?? [],
  };
}

/**
 * `rankBySales` desde caché.
 *
 * Lo cacheado es JSON, así que los ids vuelven como texto y hay que
 * devolverles su tipo: `aggregate()` no convierte, y un `$in` de cadenas
 * contra `_id` no encontraría nada.
 */
async function cachedSalesRanking(): Promise<Record<string, Types.ObjectId[]>> {
  const ranked = await cache.wrap(`${CachePrefix.SALES}home`, SALES_CACHE_TTL_SECONDS, rankBySales);
  return Object.fromEntries(
    Object.entries(ranked).map(([window, rows]) => [
      window,
      (rows as OrderRanked[]).map((r) => new Types.ObjectId(String(r._id))),
    ])
  );
}

// ── Selección: topes de exposición y diversificación ─────────────────

/** El estado compartido entre todas las colecciones de un mismo feed. */
export interface ExposureBudget {
  perProduct: Map<string, number>;
  perBusiness: Map<string, number>;
  maxPerProduct: number;
  maxPerBusiness: number;
  maxPerBusinessInSection: number;
}

export function newBudget(relaxed = false): ExposureBudget {
  return {
    perProduct: new Map(),
    perBusiness: new Map(),
    maxPerProduct: MAX_APPEARANCES_PER_PRODUCT,
    // El relajado es la segunda pasada para catálogos pequeños: antes de
    // servir un feed de tres secciones, se deja que un negocio aparezca más.
    maxPerBusiness: relaxed ? Number.POSITIVE_INFINITY : MAX_APPEARANCES_PER_BUSINESS,
    maxPerBusinessInSection: relaxed ? Number.POSITIVE_INFINITY : MAX_PER_BUSINESS_IN_SECTION,
  };
}

/** Copia de trabajo para probar una colección sin comprometer el presupuesto real todavía. */
function cloneBudget(budget: ExposureBudget): ExposureBudget {
  return {
    ...budget,
    perProduct: new Map(budget.perProduct),
    perBusiness: new Map(budget.perBusiness),
  };
}

/**
 * Parecido entre dos candidatos, sin vectores ni aprendizaje.
 *
 * Es la versión aplicable del algoritmo de diversificación que describe Uber
 * Eats: ellos comparan un vector de gustos contra un vector de cocina; aquí
 * basta Jaccard sobre las etiquetas, más un castigo fuerte por ser el mismo
 * negocio, que es la repetición que de verdad se nota al deslizar.
 */
function similarity(a: SectionProduct, b: SectionProduct): number {
  const sameBusiness = String(a.businessId) === String(b.businessId) ? 0.6 : 0;
  const at = a.tags ?? [];
  const bt = b.tags ?? [];
  if (!at.length || !bt.length) return Math.min(1, sameBusiness);
  const inter = at.filter((t) => bt.includes(t)).length;
  const union = new Set([...at, ...bt]).size || 1;
  return Math.min(1, sameBusiness + 0.4 * (inter / union));
}

/**
 * Elige hasta `targetSize` candidatos respetando los topes de exposición y
 * favoreciendo la variedad.
 *
 * El orden de llamada importa y no es un descuido: la colección que se arma
 * primero tiene prioridad sobre un mismo producto, igual que antes. Por eso
 * el feed se recorre en el orden en que se va a pintar.
 */
export function pickForSection(
  candidates: SectionProduct[],
  budget: ExposureBudget,
  targetSize: number
): SectionProduct[] {
  const chosen: SectionProduct[] = [];
  const inSection = new Map<string, number>();
  const pool = candidates.filter((candidate) => {
    const productId = String(candidate._id);
    const businessId = String(candidate.businessId);
    if ((budget.perProduct.get(productId) ?? 0) >= budget.maxPerProduct) return false;
    if ((budget.perBusiness.get(businessId) ?? 0) >= budget.maxPerBusiness) return false;
    return true;
  });

  while (chosen.length < targetSize && pool.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const businessId = String(candidate.businessId);
      if ((inSection.get(businessId) ?? 0) >= budget.maxPerBusinessInSection) continue;

      // La relevancia es la posición que ya traía: los candidatos llegan
      // ordenados por la regla de la colección, así que el primero vale 1 y
      // el último tiende a 0. No hace falta un modelo para eso.
      const relevance = 1 - i / pool.length;
      const penalty = chosen.length
        ? Math.max(...chosen.map((c) => similarity(candidate, c)))
        : 0;
      const score = ALPHA * relevance - (1 - ALPHA) * penalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) break;

    const [picked] = pool.splice(bestIndex, 1);
    const productId = String(picked._id);
    const businessId = String(picked.businessId);
    chosen.push(picked);
    inSection.set(businessId, (inSection.get(businessId) ?? 0) + 1);
    budget.perProduct.set(productId, (budget.perProduct.get(productId) ?? 0) + 1);
    budget.perBusiness.set(businessId, (budget.perBusiness.get(businessId) ?? 0) + 1);
  }

  return chosen;
}

// ── Rotación ─────────────────────────────────────────────────────────

/** Hash de 32 bits, estable entre procesos (FNV-1a). */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * La semilla del día.
 *
 * Determinista a propósito: el mismo usuario, el mismo día y la misma franja
 * ven lo mismo. Un feed que cambia en cada recarga no se lee como variedad,
 * se lee como app rota — y además no se podría cachear.
 */
export function dailySeed(identity: string, daypart: Daypart, now = new Date()): number {
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
  return hash32(`${identity}:${day}:${daypart}`);
}

/**
 * Desplaza la ventana de candidatos según la semilla.
 *
 * Sobran candidatos respecto a lo que se muestra (30 contra 10), así que
 * empezar en otro punto enseña productos distintos sin consultar otra cosa.
 */
function rotateWindow<T>(items: T[], targetSize: number, seed: number): T[] {
  const room = items.length - targetSize;
  if (room <= 0) return items;
  const offset = seed % (room + 1);
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// ── Utilidades del catálogo ──────────────────────────────────────────

/** Quita lo interno y resuelve las variantes de imagen. Ver `PublicSectionProduct`. */
export function toPublicProduct(product: SectionProduct): PublicSectionProduct {
  const { businessSchedule, businessCreatedAt, imageAsset, ...rest } = product;
  return { ...rest, images: productImageUrls(imageAsset as any) };
}

/** Filtra lo que un negocio cerrado no debería mostrar ahora mismo. */
export function filterOpenNow(docs: SectionProduct[]): SectionProduct[] {
  return docs.filter((d) => businessService.isCurrentlyOpen({ schedule: d.businessSchedule } as any));
}

/** Los candidatos, en el orden de mérito que trajo el ranking de ventas. */
function orderByIds(docs: SectionProduct[], ids: Types.ObjectId[]): SectionProduct[] {
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => byId.get(String(id))).filter((d): d is SectionProduct => !!d);
}

/**
 * Los negocios que el cliente puede ver desde donde está.
 *
 * Primero los negocios y después sus productos, no al revés: si el filtro
 * geográfico llegara después del `$lookup`, el índice 2dsphere no se usaría.
 */
export async function visibleBusinessIds(
  coords: LatLng | null,
  maxDistance: number,
  city: string | undefined
): Promise<Types.ObjectId[]> {
  return Business.find({
    ...VISIBLE_BUSINESS,
    ...withinRadius(coords, maxDistance),
    ...(city ? { city } : {}),
  }).distinct('_id');
}

// ── El motor ─────────────────────────────────────────────────────────

/**
 * Construye las colecciones de un feed.
 *
 * No incluye bloques curados ni banners: eso lo compone quien llama, porque
 * cada feed los intercala a su manera.
 */
export async function buildDiscoveryFeed(
  options: DiscoveryOptions
): Promise<DiscoveryCollectionEntry[]> {
  const now = options.now ?? new Date();
  const daypart = daypartAt(now);
  const coords = readCoords(options);
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const seed = options.seed ?? 0;

  const feeds: CollectionFeed[] = options.feed === 'both'
    ? ['home', 'explore', 'both']
    : [options.feed, 'both'];

  const defined = await DiscoveryCollection.find({ isActive: true, feed: { $in: feeds } })
    .sort({ order: 1 })
    .lean<IDiscoveryCollection[]>();

  // Las personales no viven aquí: su resultado depende de la sesión y no se
  // puede cachear por zona, así que las resuelve la capa personal.
  const eligible = defined.filter(
    (c) =>
      isEligibleNow(c, now, daypart) &&
      !isPersonal(c.rule) &&
      (coords || !needsCoords(c.rule))
  );

  if (!eligible.length) return [];

  const businessIds = await visibleBusinessIds(coords, maxDistance, options.city);
  if (!businessIds.length) return [];

  const salesIds = eligible.some((c) => c.rule.all.some((r) => r.source === 'sales'))
    ? await cachedSalesRanking()
    : {};

  const businessMatch = joinedBusinessMatch();

  // Una rama por colección. Todas comparten el mismo preámbulo —el `$match`
  // acotado por negocio, el join y los campos derivados— y solo se
  // diferencian en su `$match` propio.
  const facets: Record<string, PipelineStage.FacetPipelineStage[]> = {};

  for (const collection of eligible) {
    const ctx: CompileContext = {
      now,
      salesIds,
      fallbackKeywords: collection.fallbackKeywords !== false,
    };
    const match = compileDSL(collection.rule, ctx);
    const limit = needsCoords(collection.rule) ? NEARBY_CANDIDATE_LIMIT : CANDIDATE_LIMIT;

    facets[collection.key] = [
      ...(match ? [{ $match: { ...businessMatch, ...match } } as PipelineStage.FacetPipelineStage]
                : [{ $match: businessMatch } as PipelineStage.FacetPipelineStage]),
      { $sort: sortStageFor(collection.rule.sortBy) },
      { $limit: limit },
      PROJECT_STAGE,
    ] as PipelineStage.FacetPipelineStage[];
  }

  const pipeline: PipelineStage[] = [
    {
      $match: {
        businessId: { $in: businessIds },
        isAvailable: true,
        $or: [{ stock: null }, { stock: { $gt: 0 } }],
      },
    },
    { $lookup: { from: 'businesses', localField: 'businessId', foreignField: '_id', as: 'business' } },
    { $unwind: '$business' },
    {
      $addFields: {
        discountPercent: {
          $cond: [
            { $and: [{ $gt: ['$discountPrice', 0] }, { $lt: ['$discountPrice', '$price'] }, { $gt: ['$price', 0] }] },
            { $floor: { $multiply: [{ $divide: [{ $subtract: ['$price', '$discountPrice'] }, '$price'] }, 100] } },
            0,
          ],
        },
        effectivePrice: {
          $cond: [
            { $and: [{ $gt: ['$discountPrice', 0] }, { $lt: ['$discountPrice', '$price'] }] },
            '$discountPrice',
            '$price',
          ],
        },
        effectivePrepTime: { $ifNull: ['$prepTimeMinutes', '$business.deliveryTime'] },
      },
    },
    { $facet: facets },
  ];

  const [raw] = await Product.aggregate(pipeline);

  return assemble(eligible, raw ?? {}, { coords, salesIds, seed });
}

/** Los candidatos de una colección, en el orden en que debe recorrerlos `pickForSection`. */
function candidatesFor(
  collection: IDiscoveryCollection,
  raw: Record<string, SectionProduct[]>,
  ctx: { coords: LatLng | null; salesIds: Record<string, Types.ObjectId[]>; seed: number }
): SectionProduct[] {
  let candidates = filterOpenNow(raw[collection.key] ?? []);

  // El orden de ventas lo impone la lista rankeada, no el `$sort` de la
  // rama: el `$in` devuelve en orden de índice, no de mérito.
  const salesRule = collection.rule.all.find((r) => r.source === 'sales');
  if (salesRule && salesRule.source === 'sales') {
    candidates = orderByIds(candidates, ctx.salesIds[salesRule.window] ?? []);
  }

  if (needsCoords(collection.rule) && ctx.coords) {
    candidates = withDistance(candidates, ctx.coords, 'businessLocation').sort(
      (a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity)
    );
  }

  if (collection.rotation !== 'none') {
    candidates = rotateWindow(candidates, collection.targetSize, ctx.seed);
  }

  return candidates;
}

function toEntry(
  collection: IDiscoveryCollection,
  products: SectionProduct[]
): DiscoveryCollectionEntry {
  return {
    kind: 'collection',
    order: collection.order,
    key: collection.key,
    title: collection.title,
    subtitle: collection.subtitle,
    illustration: collection.illustration,
    displayVariant: collection.displayVariant,
    products: products.map(toPublicProduct),
  };
}

/**
 * Convierte el resultado crudo del `$facet` en las entradas del feed.
 *
 * La relajación es **por colección**, no global: solo pierde su tope de
 * exposición la colección que de verdad se quedó corta con los topes
 * puestos. Antes esto era una segunda pasada de todo el feed disparada por
 * el total de entradas, y una sola colección sin candidatos suficientes
 * (una etiqueta que el catálogo de la zona no tiene, por ejemplo) le quitaba
 * el tope por negocio a **todas las demás**, incluidas las que sí tenían
 * variedad de sobra. Relajar solo lo que falla mantiene la garantía para
 * cualquier colección que sí puede cumplirla.
 */
function assemble(
  collections: IDiscoveryCollection[],
  raw: Record<string, SectionProduct[]>,
  ctx: { coords: LatLng | null; salesIds: Record<string, Types.ObjectId[]>; seed: number }
): DiscoveryCollectionEntry[] {
  // El presupuesto "comprometido" solo crece con lo que de verdad queda en
  // el feed. Un intento que no llega a `minSize` se descarta entero —
  // incluidos los productos que alcanzó a elegir antes de quedarse corto—
  // para no gastarle la cuota a un producto que el usuario nunca ve.
  const committed = newBudget(false);
  const entries: DiscoveryCollectionEntry[] = [];
  const deferred: IDiscoveryCollection[] = [];

  for (const collection of collections) {
    const candidates = candidatesFor(collection, raw, ctx);
    const trial = cloneBudget(committed);
    const products = pickForSection(candidates, trial, collection.targetSize);
    if (products.length < collection.minSize) {
      deferred.push(collection);
      continue;
    }
    committed.perProduct = trial.perProduct;
    committed.perBusiness = trial.perBusiness;
    entries.push(toEntry(collection, products));
  }

  if (entries.length < MIN_FEED_ENTRIES && deferred.length) {
    for (const collection of deferred) {
      const candidates = candidatesFor(collection, raw, ctx);
      const trial = cloneBudget(committed);
      trial.maxPerBusiness = Number.POSITIVE_INFINITY;
      trial.maxPerBusinessInSection = Number.POSITIVE_INFINITY;
      const products = pickForSection(candidates, trial, collection.targetSize);
      if (products.length < collection.minSize) continue;
      committed.perProduct = trial.perProduct;
      committed.perBusiness = trial.perBusiness;
      entries.push(toEntry(collection, products));
    }
  }

  return entries;
}
