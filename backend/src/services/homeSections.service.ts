import { PipelineStage, Types } from 'mongoose';
import { Order, Product, Business, CuratedHomeBlock, PromotionBanner, BannerPlacement } from '../models';
import { OrderStatus } from '../types';
import { LatLng } from '../utils/geo';
import { VISIBLE_BUSINESS, withinRadius, withDistance } from '../utils/catalogQuery';
import { productImageUrls } from '../utils/productImageUrls';
import { businessService } from './business.service';

/**
 * Las colecciones dinámicas del inicio — "Los más pedidos", "Descuentos
 * locos", "Cerca de ti"…, mezclando productos de varios comercios.
 *
 * La restricción real no es de reglas sino de presupuesto: el rate limit
 * global es 100 peticiones cada 15 minutos por IP (`app.ts`), así que veinte
 * secciones no pueden ser veinte consultas. Son dos: una a `orders` (para lo
 * que depende de ventas: más pedidos, recompra, tendencia) y una a
 * `products` con un único `$facet` que resuelve las demás diecisiete de un
 * tirón, reutilizando el mismo `$lookup` a `businesses` para todas.
 *
 * Las secciones que dependen de ventas primero recortan por `Order` (sin
 * mirar el catálogo) y luego piden esos mismos ids como facets adicionales
 * de la consulta de `Product` — así heredan gratis el filtro de visibilidad,
 * stock y disponibilidad que ya aplica a las demás: un producto que se
 * vendió mucho pero ya no está en la carta no aparece en "Los más pedidos".
 */

const CANDIDATE_LIMIT = 30;
const ORDER_CANDIDATE_LIMIT = 40;
const TARGET_SIZE = 10;
const MIN_SECTION_SIZE = 4;
const MAX_APPEARANCES_PER_PRODUCT = 2;

const DEFAULT_MAX_DISTANCE = 10_000;
const MIN_DISCOUNT_PERCENT = 15;
const MIN_RATING_FOR_GOOD_VALUE = 4;
const MIN_RATING_CITY_FAVORITE = 4.5;
const MIN_REVIEWS_CITY_FAVORITE = 5;
const CHEAP_THRESHOLD = 10_000;
const GOOD_VALUE_THRESHOLD = 15_000;
const PREMIUM_THRESHOLD = 35_000;
const FAST_PREP_MINUTES = 20;
const NEW_PRODUCT_DAYS = 21;
const NEW_BUSINESS_DAYS = 30;
const MIN_TRENDING_RECENT_VOLUME = 3;
const MIN_TRENDING_GROWTH = 1.3;

// Palabras ya pasadas por `normalize()`: sin tildes, en minúscula — el mismo
// tratamiento que recibe `searchName` al guardarse, así que comparan igual.
const ANTOJO_KEYWORDS = ['hamburguesa', 'perro', 'hot dog', 'hotdog', 'pizza', 'empanada', 'salchipapa'];
const COMPARTIR_KEYWORDS = ['combo', 'familiar', 'grande', 'x2', 'x3', 'x4', 'picada', 'para compartir'];
const DULCE_KEYWORDS = ['helado', 'postre', 'brownie', 'torta', 'waffle', 'malteada', 'pastel'];
const DESAYUNO_KEYWORDS = ['desayuno', 'cafe', 'pan', 'huevo', 'arepa', 'tostada'];
const BEBIDA_KEYWORDS = ['gaseosa', 'jugo', 'cafe', 'malteada', 'limonada', 'bebida', 'soda', 'agua'];
const FRIO_KEYWORDS = ['helado', 'granizado', 'jugo', 'limonada', 'frappe', 'malteada'];

function keywordMatch(words: string[]): Record<string, unknown> {
  return { searchName: { $regex: words.join('|') } };
}

function readCoords(options: { lat?: number; lng?: number }): LatLng | null {
  const { lat, lng } = options;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** `VISIBLE_BUSINESS`, pero contra el negocio ya unido al producto. */
function joinedBusinessMatch(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(VISIBLE_BUSINESS).map(([key, value]) => [`business.${key}`, value])
  );
}

export interface HomeSectionsOptions {
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
}

/**
 * Espacio numérico que ordena la secuencia entera del inicio: las veinte
 * colecciones automáticas de `sectionDefs` (10, 20, 30… 200, en el mismo
 * orden en que ya están declaradas ahí abajo — ese orden no cambia), los
 * bloques curados por un admin (`CuratedHomeBlock.order`, elegido a mano
 * para intercalarse entre ellas) y los banners promocionales que un admin
 * decidió anclar a una posición concreta (`PromotionBanner.homeOrder`).
 */
const AUTO_SECTION_ORDER_STEP = 10;

/** Un producto tal como lo necesita una tarjeta de spotlight/collection —
 * el mismo shape que ya arma `PROJECT_STAGE` + `productImageUrls`, sin la
 * maquinaria de candidatos/ranking que sí necesitan las 20 automáticas. */
interface CuratedProduct {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number | null;
  discountPercent: number;
  effectivePrice: number;
  images: ReturnType<typeof productImageUrls>;
  businessId: Types.ObjectId;
  businessName: string;
  businessLogo?: string | null;
  businessCategory: string;
  businessRating: number;
  businessDeliveryTime: number;
}

/** Un negocio tal como lo necesita una tarjeta de banner/collection de negocios. */
interface CuratedBusiness {
  _id: Types.ObjectId;
  name: string;
  category: string;
  rating: number;
  totalReviews: number;
  deliveryTime: number;
  logo?: string | null;
  coverImage?: string | null;
  freeDeliveryThreshold: number;
}

/** Una entrada cualquiera de la secuencia fusionada del inicio. */
export type HomeFeedEntry =
  | {
      kind: 'collection';
      order: number;
      key: string;
      emoji: string;
      title: string;
      subtitle?: string;
      displayVariant: DisplayVariant;
      products: unknown[];
    }
  | { kind: 'productBanner'; order: number; title: string; subtitle?: string; products: CuratedProduct[] }
  | { kind: 'businessBanner'; order: number; title: string; subtitle?: string; businesses: CuratedBusiness[] }
  | { kind: 'businessCollection'; order: number; title: string; subtitle?: string; businesses: CuratedBusiness[] }
  | { kind: 'promo'; order: number; banners: PromoEntry[] };

interface PromoEntry {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  buttonText: string;
  actionType: string;
  actionValue: string;
  durationSeconds: number;
}

function toCuratedProduct(p: {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number | null;
  imageAsset?: unknown;
  businessId: Types.ObjectId;
  business: { name: string; logo?: string | null; category: string; rating: number; deliveryTime: number };
}): CuratedProduct {
  const discountPercent =
    p.discountPrice && p.discountPrice > 0 && p.discountPrice < p.price && p.price > 0
      ? Math.floor(((p.price - p.discountPrice) / p.price) * 100)
      : 0;
  const effectivePrice = discountPercent > 0 ? (p.discountPrice as number) : p.price;
  return {
    _id: p._id,
    name: p.name,
    description: p.description,
    price: p.price,
    discountPrice: p.discountPrice,
    discountPercent,
    effectivePrice,
    images: productImageUrls(p.imageAsset as any),
    businessId: p.businessId,
    businessName: p.business.name,
    businessLogo: p.business.logo,
    businessCategory: p.business.category,
    businessRating: p.business.rating,
    businessDeliveryTime: p.business.deliveryTime,
  };
}

function toCuratedBusiness(b: {
  _id: Types.ObjectId;
  name: string;
  category: string;
  rating: number;
  totalReviews: number;
  deliveryTime: number;
  logo?: string | null;
  coverImage?: string | null;
  freeDeliveryThreshold: number;
}): CuratedBusiness {
  return {
    _id: b._id,
    name: b.name,
    category: b.category,
    rating: b.rating,
    totalReviews: b.totalReviews,
    deliveryTime: b.deliveryTime,
    logo: b.logo,
    coverImage: b.coverImage,
    freeDeliveryThreshold: b.freeDeliveryThreshold,
  };
}

/**
 * Los bloques curados por un admin (`productBanner`, `businessBanner`,
 * `businessCollection`), ya resueltos con los mismos datos que pinta una
 * tarjeta. Son a lo sumo unas pocas docenas de items en total, así que
 * consultas directas por id no comprometen el presupuesto de peticiones:
 * siguen siendo parte de esta misma llamada a `/home-sections`.
 */
async function getCuratedBlocks(): Promise<HomeFeedEntry[]> {
  const now = new Date();
  const blocks = await CuratedHomeBlock.find({
    isActive: true,
    $and: [
      { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] },
    ],
  }).sort({ order: 1 });

  if (blocks.length === 0) return [];

  const productIds = blocks.filter((b) => b.kind === 'productBanner').flatMap((b) => b.items);
  const businessIds = blocks
    .filter((b) => b.kind !== 'productBanner')
    .flatMap((b) => b.items);

  const [products, businesses] = await Promise.all([
    productIds.length
      ? Product.aggregate([
          { $match: { _id: { $in: productIds } } },
          { $lookup: { from: 'businesses', localField: 'businessId', foreignField: '_id', as: 'business' } },
          { $unwind: '$business' },
        ])
      : Promise.resolve([]),
    businessIds.length ? Business.find({ _id: { $in: businessIds } }) : Promise.resolve([]),
  ]);

  const productById = new Map(products.map((p: any) => [String(p._id), p]));
  const businessById = new Map(businesses.map((b: any) => [String(b._id), b]));

  const entries: HomeFeedEntry[] = [];
  for (const block of blocks) {
    if (block.kind === 'productBanner') {
      const items = block.items
        .map((id) => productById.get(String(id)))
        .filter((p): p is any => !!p)
        .map(toCuratedProduct);
      if (items.length === 0) continue;
      entries.push({
        kind: 'productBanner', order: block.order, title: block.title, subtitle: block.subtitle, products: items,
      });
    } else {
      const items = block.items
        .map((id) => businessById.get(String(id)))
        .filter((b): b is any => !!b)
        .map(toCuratedBusiness);
      if (items.length === 0) continue;
      entries.push({
        kind: block.kind as 'businessBanner' | 'businessCollection',
        order: block.order,
        title: block.title,
        subtitle: block.subtitle,
        businesses: items,
      });
    }
  }
  return entries;
}

/**
 * Los banners promocionales que un admin ancló a una posición concreta del
 * inicio (`homeOrder` distinto de `null`). Los que comparten el mismo
 * `homeOrder` van juntos en un único bloque `promo`, que el cliente pinta
 * con el mismo `PromoCarousel` de siempre.
 */
async function getPositionedPromoBlocks(): Promise<HomeFeedEntry[]> {
  const now = new Date();
  const banners = await PromotionBanner.find({
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
    placement: { $in: [BannerPlacement.HOME, BannerPlacement.ALL] },
    imageUrl: { $ne: '' },
    homeOrder: { $ne: null },
  }).sort({ homeOrder: 1, displayOrder: 1, priority: -1, createdAt: -1 });

  const byOrder = new Map<number, PromoEntry[]>();
  for (const b of banners) {
    const order = b.homeOrder as number;
    const list = byOrder.get(order) ?? [];
    list.push({
      id: b._id.toString(),
      imageUrl: b.imageUrl,
      title: b.title,
      description: b.description,
      buttonText: b.buttonText,
      actionType: b.actionType,
      actionValue: b.actionValue,
      durationSeconds: b.durationSeconds,
    });
    byOrder.set(order, list);
  }

  return Array.from(byOrder.entries()).map(([order, list]) => ({ kind: 'promo' as const, order, banners: list }));
}

interface SectionProduct {
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

const PROJECT_STAGE: PipelineStage.Project = {
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

/** Los ids tal como los devolvió `Order.aggregate`, en su orden de mérito. */
interface OrderRanked {
  _id: Types.ObjectId;
}

/**
 * Lo que depende de ventas: solo mira `orders`, nunca `products`. Una única
 * consulta con `$facet` resuelve las tres secciones a la vez.
 */
async function rankBySales(): Promise<{
  mostOrdered: OrderRanked[];
  repeatPurchase: OrderRanked[];
  trending: OrderRanked[];
}> {
  const now = Date.now();
  const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const since90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
  const since14 = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const pipeline: PipelineStage[] = [
    { $match: { status: OrderStatus.DELIVERED, deliveredAt: { $gte: since90 } } },
    {
      $facet: {
        // "Los más pedidos": unidades vendidas en los últimos 30 días.
        mostOrdered: [
          { $match: { deliveredAt: { $gte: since30 } } },
          { $unwind: '$items' },
          { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' } } },
          { $sort: { sold: -1 } },
          { $limit: ORDER_CANDIDATE_LIMIT },
        ],
        // "Pide y repite": a cuántos clientes distintos les gustó tanto que
        // lo volvieron a pedir. No es el total de pedidos —eso premiaría al
        // que más vende, que ya tiene su propia sección— sino cuántas
        // personas distintas repitieron.
        repeatPurchase: [
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
        // "Está en tendencia": crece la última semana frente a la anterior.
        // El +1 en el denominador evita que un producto sin ventas previas
        // parezca "infinito"; el mínimo de volumen reciente evita que un
        // solo pedido aislado se lea como tendencia.
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
    repeatPurchase: result?.repeatPurchase ?? [],
    trending: result?.trending ?? [],
  };
}

/** Los candidatos, en el mismo orden que trajo `orders`, ya con precio/negocio resueltos. */
function orderByIds(docs: SectionProduct[], ids: Types.ObjectId[]): SectionProduct[] {
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => byId.get(String(id))).filter((d): d is SectionProduct => !!d);
}

/** Filtra lo que un negocio cerrado no debería mostrar ahora mismo. */
function filterOpenNow(docs: SectionProduct[]): SectionProduct[] {
  return docs.filter((d) => businessService.isCurrentlyOpen({ schedule: d.businessSchedule } as any));
}

/**
 * Formato visual de la colección — decide qué componente de tarjeta usa el
 * cliente. Vive en el backend (no hardcodeado en la app) para que a futuro
 * administración pueda reasignarlo sin tocar código, tal como pide el
 * catálogo: `collection.displayVariant`.
 */
type DisplayVariant = 'compact' | 'large' | 'horizontal' | 'featured' | 'price_focus' | 'banner';

interface SectionDefinition {
  key: string;
  emoji: string;
  title: string;
  subtitle?: string;
  displayVariant: DisplayVariant;
  candidates: SectionProduct[];
}

/**
 * De los candidatos —ya más de los que se van a mostrar— elige hasta
 * `targetSize` sin dejar que un producto se repita más de `maxAppearances`
 * veces en todo el inicio.
 *
 * `usageCount` es compartido entre secciones y se muta aquí: la sección que
 * se arma primero tiene prioridad sobre el mismo producto, así que el orden
 * en el que se llama importa y sigue el orden pedido por el usuario (más
 * pedidos y descuentos primero, "date un gusto" y "refresca el día" al
 * final).
 */
function pickForSection(
  candidates: SectionProduct[],
  usageCount: Map<string, number>,
  targetSize: number,
  maxAppearances: number
): SectionProduct[] {
  const chosen: SectionProduct[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= targetSize) break;
    const id = String(candidate._id);
    const used = usageCount.get(id) ?? 0;
    if (used >= maxAppearances) continue;
    chosen.push(candidate);
    usageCount.set(id, used + 1);
  }
  return chosen;
}

export async function getHomeSections(options: HomeSectionsOptions = {}) {
  const coords = readCoords(options);
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const { city } = options;

  const businessMatch = joinedBusinessMatch();
  if (coords) businessMatch['business.location'] = withinRadius(coords, maxDistance).location;
  if (city) businessMatch['business.city'] = city;

  const sales = await rankBySales();

  const facets: Record<string, PipelineStage.FacetPipelineStage[]> = {
    // 💸 Descuentos locos
    discounts: [
      { $match: { discountPercent: { $gte: MIN_DISCOUNT_PERCENT } } },
      { $sort: { discountPercent: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🍔 El antojo del día
    antojoDelDia: [
      { $match: keywordMatch(ANTOJO_KEYWORDS) },
      { $sort: { isFeatured: -1, discountPercent: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🍟 Para compartir
    paraCompartir: [
      { $match: keywordMatch(COMPARTIR_KEYWORDS) },
      { $sort: { discountPercent: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🍦 Algo dulce
    algoDulce: [
      { $match: keywordMatch(DULCE_KEYWORDS) },
      { $sort: { isFeatured: -1, createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // ☕ Para empezar el día
    paraEmpezarElDia: [
      { $match: { $or: [keywordMatch(DESAYUNO_KEYWORDS), { 'business.category': 'cafe' }] } },
      { $sort: { isFeatured: -1, createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🌙 Para la noche
    paraLaNoche: [
      {
        $match: {
          $or: [{ 'business.category': 'fast_food' }, keywordMatch([...ANTOJO_KEYWORDS, ...COMPARTIR_KEYWORDS])],
        },
      },
      { $sort: { discountPercent: -1, isFeatured: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🥤 Algo para tomar
    algoParaTomar: [
      { $match: keywordMatch(BEBIDA_KEYWORDS) },
      { $sort: { isFeatured: -1, createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 💰 Bueno y barato
    buenoYBarato: [
      { $match: { effectivePrice: { $lte: GOOD_VALUE_THRESHOLD }, 'business.rating': { $gte: MIN_RATING_FOR_GOOD_VALUE } } },
      { $sort: { 'business.rating': -1, effectivePrice: 1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // ⚡ Listo para pedir
    listoParaPedir: [
      { $match: { effectivePrepTime: { $lte: FAST_PREP_MINUTES } } },
      { $sort: { effectivePrepTime: 1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🆕 Recién llegados
    recienLlegados: [
      {
        $match: {
          $or: [
            { createdAt: { $gte: new Date(Date.now() - NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000) } },
            { 'business.createdAt': { $gte: new Date(Date.now() - NEW_BUSINESS_DAYS * 24 * 60 * 60 * 1000) } },
          ],
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // ❤️ Favoritos de ZIPP
    favoritosZipp: [
      { $match: { isFeatured: true } },
      { $sort: { createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🏆 Los favoritos de la ciudad
    favoritosCiudad: [
      {
        $match: {
          'business.rating': { $gte: MIN_RATING_CITY_FAVORITE },
          'business.totalReviews': { $gte: MIN_REVIEWS_CITY_FAVORITE },
        },
      },
      { $sort: { 'business.rating': -1, 'business.totalReviews': -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🎁 Combos que valen la pena
    combosQueValenLaPena: [
      { $match: { ...keywordMatch(COMPARTIR_KEYWORDS), discountPercent: { $gt: 0 } } },
      { $sort: { discountPercent: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🤑 Por menos de $10.000
    porMenosDe10000: [
      { $match: { effectivePrice: { $lt: CHEAP_THRESHOLD } } },
      { $sort: { effectivePrice: 1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 👑 Date un gusto
    dateUnGusto: [
      { $match: { effectivePrice: { $gte: PREMIUM_THRESHOLD } } },
      { $sort: { effectivePrice: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // 🧊 Refresca el día
    refrescaElDia: [
      { $match: keywordMatch(FRIO_KEYWORDS) },
      { $sort: { isFeatured: -1, createdAt: -1 } },
      { $limit: CANDIDATE_LIMIT },
      PROJECT_STAGE,
    ],
    // Resueltos por separado desde `orders`; aquí solo se cuelgan el precio
    // y el negocio, y heredan el filtro de visibilidad de arriba.
    byIdMostOrdered: [{ $match: { _id: { $in: sales.mostOrdered.map((r) => r._id) } } }, PROJECT_STAGE],
    byIdRepeatPurchase: [{ $match: { _id: { $in: sales.repeatPurchase.map((r) => r._id) } } }, PROJECT_STAGE],
    byIdTrending: [{ $match: { _id: { $in: sales.trending.map((r) => r._id) } } }, PROJECT_STAGE],
  };

  // 🛵 Cerca de ti: solo tiene sentido con coordenadas. La distancia real se
  // calcula en JS —igual que en búsqueda y ofertas—, así que este facet solo
  // trae un lote amplio ya acotado al radio por `businessMatch` de arriba.
  if (coords) {
    facets.cercaDeTi = [{ $sort: { createdAt: -1 } }, { $limit: CANDIDATE_LIMIT * 3 }, PROJECT_STAGE];
  }

  const pipeline: PipelineStage[] = [
    { $match: { isAvailable: true, $or: [{ stock: null }, { stock: { $gt: 0 } }] } },
    { $lookup: { from: 'businesses', localField: 'businessId', foreignField: '_id', as: 'business' } },
    { $unwind: '$business' },
    { $match: businessMatch },
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

  const clean = (key: string): SectionProduct[] => filterOpenNow((raw?.[key] ?? []) as SectionProduct[]);

  const sectionDefs: SectionDefinition[] = [
    {
      key: 'losMasPedidos', emoji: '🔥', title: 'Los más pedidos', displayVariant: 'large',
      subtitle: 'Lo que más se pide ahora mismo',
      candidates: orderByIds(clean('byIdMostOrdered'), sales.mostOrdered.map((r) => r._id)),
    },
    {
      key: 'pideYRepite', emoji: '⭐', title: 'Pide y repite', displayVariant: 'compact',
      subtitle: 'A la gente le gustó tanto que volvió por más',
      candidates: orderByIds(clean('byIdRepeatPurchase'), sales.repeatPurchase.map((r) => r._id)),
    },
    { key: 'descuentosLocos', emoji: '💸', title: 'Descuentos locos', displayVariant: 'price_focus', candidates: clean('discounts') },
    { key: 'antojoDelDia', emoji: '🍔', title: 'El antojo del día', displayVariant: 'compact', candidates: clean('antojoDelDia') },
    { key: 'paraCompartir', emoji: '🍟', title: 'Para compartir', displayVariant: 'horizontal', candidates: clean('paraCompartir') },
    { key: 'algoDulce', emoji: '🍦', title: 'Algo dulce', displayVariant: 'featured', candidates: clean('algoDulce') },
    { key: 'paraEmpezarElDia', emoji: '☕', title: 'Para empezar el día', displayVariant: 'compact', candidates: clean('paraEmpezarElDia') },
    { key: 'paraLaNoche', emoji: '🌙', title: 'Para la noche', displayVariant: 'compact', candidates: clean('paraLaNoche') },
    { key: 'algoParaTomar', emoji: '🥤', title: 'Algo para tomar', displayVariant: 'compact', candidates: clean('algoParaTomar') },
    { key: 'buenoYBarato', emoji: '💰', title: 'Bueno y barato', displayVariant: 'price_focus', candidates: clean('buenoYBarato') },
    { key: 'listoParaPedir', emoji: '⚡', title: 'Listo para pedir', displayVariant: 'compact', candidates: clean('listoParaPedir') },
    { key: 'recienLlegados', emoji: '🆕', title: 'Recién llegados', displayVariant: 'compact', candidates: clean('recienLlegados') },
    { key: 'favoritosZipp', emoji: '❤️', title: 'ZIPP recomienda', displayVariant: 'featured', candidates: clean('favoritosZipp') },
    {
      key: 'estaEnTendencia', emoji: '📈', title: 'Está en tendencia', displayVariant: 'compact',
      subtitle: 'Cada vez lo pide más gente',
      candidates: orderByIds(clean('byIdTrending'), sales.trending.map((r) => r._id)),
    },
    { key: 'favoritosCiudad', emoji: '🏆', title: 'Los favoritos de la ciudad', displayVariant: 'horizontal', candidates: clean('favoritosCiudad') },
    {
      key: 'cercaDeTi', emoji: '🛵', title: 'Cerca de ti', displayVariant: 'compact',
      candidates: coords
        ? withDistance(clean('cercaDeTi'), coords, 'businessLocation')
            .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
        : [],
    },
    { key: 'combosQueValenLaPena', emoji: '🎁', title: 'Combos que valen la pena', displayVariant: 'horizontal', candidates: clean('combosQueValenLaPena') },
    { key: 'porMenosDe10000', emoji: '🤑', title: 'Por menos de $10.000', displayVariant: 'price_focus', candidates: clean('porMenosDe10000') },
    { key: 'dateUnGusto', emoji: '👑', title: 'Date un gusto', displayVariant: 'banner', candidates: clean('dateUnGusto') },
    { key: 'refrescaElDia', emoji: '🧊', title: 'Refresca el día', displayVariant: 'compact', candidates: clean('refrescaElDia') },
  ];

  const usageCount = new Map<string, number>();

  // Las veinte automáticas, con su `order` implícito (10, 20, 30…) en el
  // mismo orden en que están declaradas arriba en `sectionDefs` — ese orden
  // interno no cambia, solo se le añade `kind`/`order` al resultado final
  // para que pueda fusionarse con los bloques curados y los banners.
  const autoSections: HomeFeedEntry[] = sectionDefs
    .map((section, i) => ({
      kind: 'collection' as const,
      order: (i + 1) * AUTO_SECTION_ORDER_STEP,
      key: section.key,
      emoji: section.emoji,
      title: section.title,
      subtitle: section.subtitle,
      displayVariant: section.displayVariant,
      // `businessSchedule`/`businessCreatedAt` solo existen para decidir
      // aquí adentro qué entra y qué no; la app no los pinta y no tiene
      // sentido mandarlos en cada carga del inicio. `images` se calcula a
      // mano porque viene de un virtual de Mongoose (`Product.images`) que
      // `aggregate()` nunca invoca — sin esto la app se quedaría con la
      // foto vieja sin variantes en todo el inicio.
      products: pickForSection(section.candidates, usageCount, TARGET_SIZE, MAX_APPEARANCES_PER_PRODUCT).map(
        ({ businessSchedule, businessCreatedAt, imageAsset, ...rest }) => ({
          ...rest,
          images: productImageUrls(imageAsset as any),
        })
      ),
    }))
    .filter((section) => section.products.length >= MIN_SECTION_SIZE);

  const [curatedBlocks, promoBlocks] = await Promise.all([getCuratedBlocks(), getPositionedPromoBlocks()]);

  // Todo fusionado y ordenado por `order` ascendente: así un admin puede
  // intercalar un bloque curado o un banner entre dos colecciones
  // automáticas con solo elegir el número, sin tocar código.
  return [...autoSections, ...curatedBlocks, ...promoBlocks].sort((a, b) => a.order - b.order);
}

export const homeSectionsService = { getHomeSections };
