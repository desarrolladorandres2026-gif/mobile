import { PromotionBanner, BannerPlacement } from '../models';
import { cache, CachePrefix } from '../cache';

/**
 * Los banners gratuitos de Explorar (`PromotionBanner` con `placement`
 * `explore` o `all`).
 *
 * El resto del feed —qué secciones, en qué orden y con qué datos— lo decide
 * el layout publicado desde el panel y lo arma `exploreLayout.service.ts`.
 * Esto solo es la fuente de los bloques de banners de ese layout.
 */

const PROMO_CACHE_TTL_SECONDS = 60;

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
   * `PromotionBanner` gratuito. Lo añade `exploreLayout.service.withAd`
   * después de leer la caché —nunca antes— porque la elección de campaña
   * tiene que ser por petición, no por zona: es lo único que respeta
   * `maxImpressionsPerUser`.
   */
  isAd?: boolean;
}

async function loadExploreBanners(): Promise<PromoEntry[]> {
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

/** Los banners vigentes de Explorar, un minuto en caché (el margen de sus fechas de inicio y fin). */
export function getExploreBanners(): Promise<PromoEntry[]> {
  return cache.wrap(`${CachePrefix.EXPLORE}promo`, PROMO_CACHE_TTL_SECONDS, loadExploreBanners);
}
