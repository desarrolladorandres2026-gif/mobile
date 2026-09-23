import { PromotionBanner, BannerPlacement, daypartAt } from '../models';
import type { Daypart } from '../models';
import { cache, CachePrefix } from '../cache';
import {
  buildDiscoveryFeed,
  dailySeed,
  DEFAULT_MAX_DISTANCE,
  type DiscoveryCollectionEntry,
} from './discovery.service';

/**
 * El feed de Explorar.
 *
 * Es la pantalla a la que entra quien **no** sabe qué quiere, así que se
 * lleva el grueso de las colecciones; el inicio se queda con tres y con lo
 * que ya tenía propio (lo de siempre, banners, categorías).
 *
 * La respuesta es **una sola petición**. No hay un endpoint por sección, y
 * no debe haberlo: este proyecto ya sabe cómo se ve un limitador de
 * peticiones desde el teléfono —un 429 se lee exactamente igual que "no
 * tienes datos"—, y un feed de doce bandas con doce consultas es la forma
 * más rápida de llegar ahí.
 */

const PROMO_CACHE_TTL_SECONDS = 60;

export interface ExploreOptions {
  lat?: number;
  lng?: number;
  maxDistance?: number;
  city?: string;
  /** Quién mira, si hay sesión. Rota el contenido y habilita lo personal. */
  userId?: string;
  /** Respaldo de rotación cuando no hay sesión. */
  deviceId?: string;
  now?: Date;
}

export interface PromoEntry {
  id: string;
  imageUrl: string;
  title: string;
  description: string;
  buttonText: string;
  actionType: string;
  actionValue: string;
  durationSeconds: number;
  /**
   * Si este banner es una campaña pagada (`Advertisement`), no un
   * `PromotionBanner` gratuito. Lo añade `explore.controller.ts` después de
   * leer la caché — nunca este servicio — porque la elección de campaña
   * tiene que ser por petición, no por zona: es lo único que respeta
   * `maxImpressionsPerUser`.
   */
  isAd?: boolean;
}

export type ExploreEntry =
  | DiscoveryCollectionEntry
  | { kind: 'promo'; order: number; banners: PromoEntry[] };

export interface ExploreFeed {
  entries: ExploreEntry[];
  daypart: Daypart;
  /**
   * Si el feed lleva algo derivado de quien mira.
   *
   * Viaja a la app para que pueda decidir si tiene sentido pintar un
   * encabezado de "Para ti". Hoy es siempre `false`: las secciones
   * personales llegan con el perfil de gustos.
   */
  personalized: boolean;
}

/**
 * Los banners de Explorar.
 *
 * A diferencia del inicio, aquí no se anclan a una posición concreta: van
 * todos a media pantalla, rodeados de contenido distinto, que es donde un
 * banner se ve sin robarle el sitio a lo que de verdad sirve.
 */
async function getExploreBanners(): Promise<PromoEntry[]> {
  const now = new Date();
  const banners = await PromotionBanner.find({
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
    placement: { $in: [BannerPlacement.EXPLORE, BannerPlacement.ALL] },
    imageUrl: { $ne: '' },
  }).sort({ displayOrder: 1, priority: -1, createdAt: -1 });

  return banners.map((b) => ({
    id: b._id.toString(),
    imageUrl: b.imageUrl,
    title: b.title,
    description: b.description,
    buttonText: b.buttonText,
    actionType: b.actionType,
    actionValue: b.actionValue,
    durationSeconds: b.durationSeconds,
  }));
}

/**
 * Dónde se intercala el bloque de banners.
 *
 * A media altura del feed, no arriba: arriba compite con el buscador y con
 * las categorías, que son más útiles. Se calcula sobre el `order` real de
 * las colecciones para que caiga entre dos, no pegado a un extremo.
 */
export function bannerOrder(collections: DiscoveryCollectionEntry[]): number {
  if (collections.length < 2) return 999;
  const middle = collections[Math.floor(collections.length / 2)];
  return middle.order - 1;
}

export async function getExploreFeed(options: ExploreOptions = {}): Promise<ExploreFeed> {
  const now = options.now ?? new Date();
  const daypart = daypartAt(now);

  // Identidad estable para rotar: sesión, si no dispositivo, si no la zona.
  // Determinista a propósito — el mismo usuario, el mismo día y la misma
  // franja ven lo mismo. Un feed que cambia en cada recarga no se lee como
  // variedad, se lee como app rota, y además no se podría cachear.
  const identity =
    options.userId ?? options.deviceId ?? `${options.lat ?? '-'}:${options.lng ?? '-'}`;
  const seed = dailySeed(identity, daypart, now);

  const [collections, banners] = await Promise.all([
    buildDiscoveryFeed({
      feed: 'explore',
      lat: options.lat,
      lng: options.lng,
      maxDistance: options.maxDistance ?? DEFAULT_MAX_DISTANCE,
      city: options.city,
      seed,
      now,
    }),
    cache.wrap(`${CachePrefix.EXPLORE}promo`, PROMO_CACHE_TTL_SECONDS, getExploreBanners),
  ]);

  const entries: ExploreEntry[] = [...collections];
  if (banners.length) {
    entries.push({ kind: 'promo', order: bannerOrder(collections), banners });
  }

  return {
    entries: entries.sort((a, b) => a.order - b.order),
    daypart,
    personalized: false,
  };
}

export const exploreService = { getExploreFeed };
