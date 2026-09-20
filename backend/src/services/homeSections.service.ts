import { Product, Business, CuratedHomeBlock, PromotionBanner, BannerPlacement } from '../models';
import { Types } from 'mongoose';
import { productImageUrls } from '../utils/productImageUrls';
import { cache, CachePrefix } from '../cache';
import type { DisplayVariant } from '../models';
import {
  buildDiscoveryFeed,
  DEFAULT_MAX_DISTANCE,
  type PublicSectionProduct,
} from './discovery.service';

/**
 * El feed del inicio.
 *
 * Ya no calcula colecciones: las veinte que vivían aquí en un array
 * `sectionDefs` se mudaron a la base (`DiscoveryCollection`) y las arma
 * `discovery.service.ts`. Lo que queda aquí es lo propio del inicio —los
 * bloques que curó un administrador a mano y los banners que ancló a una
 * posición— y la fusión de las tres cosas en una sola secuencia.
 *
 * El `order` es el pegamento: colecciones (10, 20, 30…), bloques curados
 * (`CuratedHomeBlock.order`) y banners anclados (`PromotionBanner.homeOrder`)
 * comparten un único espacio numérico, y por eso un admin puede intercalar
 * un bloque entre dos colecciones sin tocar código.
 *
 * La **forma** de la respuesta no cambió con la mudanza: las apps ya
 * instaladas siguen leyendo lo mismo. Lo único distinto es cuántas entradas
 * llegan, porque ahora solo vienen las colecciones marcadas para el inicio
 * —el grueso del descubrimiento se mudó a Explorar, que es donde entra quien
 * no sabe todavía qué quiere.
 */

export interface HomeSectionsOptions {
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
}

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
  /** Color propio del negocio para el respaldo de portada, si lo eligió. */
  brandColor?: string | null;
  freeDeliveryThreshold: number;
}

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
  brandColor?: string | null;
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
    brandColor: b.brandColor,
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


const BLOCKS_CACHE_TTL_SECONDS = 60;

/** Una entrada cualquiera de la secuencia fusionada del inicio. */
export type HomeFeedEntry =
  | {
      kind: 'collection';
      order: number;
      key: string;
      /**
       * @deprecated Siempre vacío desde que las colecciones viven en la base.
       *
       * La app nunca lo pintó —usa sus propias mini-ilustraciones, ver la
       * nota de `ProductCollectionRow.tsx`— pero el campo sigue viajando
       * para no romper el contrato con las versiones ya instaladas. Se
       * retira cuando el tipo del cliente deje de declararlo.
       */
      emoji: string;
      title: string;
      subtitle?: string;
      illustration?: string;
      displayVariant: DisplayVariant;
      products: PublicSectionProduct[];
    }
  | { kind: 'productBanner'; order: number; title: string; subtitle?: string; products: CuratedProduct[] }
  | { kind: 'businessBanner'; order: number; title: string; subtitle?: string; businesses: CuratedBusiness[] }
  | { kind: 'businessCollection'; order: number; title: string; subtitle?: string; businesses: CuratedBusiness[] }
  | { kind: 'promo'; order: number; banners: PromoEntry[] };

export async function getHomeSections(options: HomeSectionsOptions = {}) {
  const [collections, curatedBlocks, promoBlocks] = await Promise.all([
    buildDiscoveryFeed({
      feed: 'home',
      lat: options.lat,
      lng: options.lng,
      maxDistance: options.maxDistance ?? DEFAULT_MAX_DISTANCE,
      city: options.city,
    }),
    cache.wrap(`${CachePrefix.HOME}curated`, BLOCKS_CACHE_TTL_SECONDS, getCuratedBlocks),
    cache.wrap(`${CachePrefix.HOME}promo`, BLOCKS_CACHE_TTL_SECONDS, getPositionedPromoBlocks),
  ]);

  const autoSections: HomeFeedEntry[] = collections.map((entry) => ({
    kind: 'collection' as const,
    order: entry.order,
    key: entry.key,
    emoji: '',
    title: entry.title,
    subtitle: entry.subtitle,
    illustration: entry.illustration,
    displayVariant: entry.displayVariant,
    products: entry.products,
  }));

  // Todo fusionado y ordenado por `order` ascendente.
  return [...autoSections, ...curatedBlocks, ...promoBlocks].sort((a, b) => a.order - b.order);
}

export const homeSectionsService = { getHomeSections };
