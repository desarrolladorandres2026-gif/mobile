import { CuratedHomeBlock, DiscoveryCollection, PromotionBanner, BannerPlacement } from '../models';
import { daypartAt } from '../models/DiscoveryCollection';
import { weekdayAt } from './discovery.service';
import { HOME_TIE_RANK } from './homeSections.service';

/**
 * El orden del Inicio como lo ve un administrador: una sola lista con las
 * tres fuentes que se reparten los huecos (colecciones automáticas, bloques
 * curados y banners anclados) y quién gana cuando comparten número.
 *
 * Solo lectura y sin productos: no arma las secciones, solo dice qué ocupa
 * cada hueco y si hoy, a esta hora, está vivo.
 */

export type HomeSlotSource = 'collection' | 'curated' | 'promo';

export interface HomeSlot {
  order: number;
  source: HomeSlotSource;
  title: string;
  /** Si entra en el Inicio ahora mismo (activo, en fecha, en franja y día). */
  live: boolean;
  /** Por qué no está vivo, en palabras del panel. */
  reason: string | null;
  /** Otra entrada con el mismo `order` que va antes. */
  outranked: boolean;
}

export async function homeOrderMap(now = new Date()): Promise<HomeSlot[]> {
  const daypart = daypartAt(now);
  const weekday = weekdayAt(now);

  const [collections, blocks, banners] = await Promise.all([
    DiscoveryCollection.find({ feed: { $in: ['home', 'both'] } }).select('title order isActive dayparts weekdays startDate endDate').lean(),
    CuratedHomeBlock.find().select('title order isActive startDate endDate dayparts weekdays').lean(),
    PromotionBanner.find({
      homeOrder: { $ne: null },
      placement: { $in: [BannerPlacement.HOME, BannerPlacement.ALL] },
    }).select('title homeOrder isActive startDate endDate imageUrl').lean(),
  ]);

  const why = (x: {
    isActive?: boolean; startDate?: Date | null; endDate?: Date | null; dayparts?: string[]; weekdays?: number[];
  }): string | null => {
    if (x.isActive === false) return 'Desactivado';
    if (x.startDate && x.startDate > now) return 'Aún no empieza';
    if (x.endDate && x.endDate < now) return 'Ya terminó';
    if (x.dayparts?.length && !x.dayparts.includes(daypart)) return 'Fuera de su franja horaria';
    if (x.weekdays?.length && !x.weekdays.includes(weekday)) return 'Hoy no es uno de sus días';
    return null;
  };

  const slots: HomeSlot[] = [
    ...collections.map((c) => {
      const reason = why(c);
      return { order: c.order, source: 'collection' as const, title: c.title, live: !reason, reason, outranked: false };
    }),
    ...blocks.map((b) => {
      const reason = why(b);
      return { order: b.order, source: 'curated' as const, title: b.title, live: !reason, reason, outranked: false };
    }),
    ...banners.map((b) => {
      const reason = why(b) ?? (b.imageUrl ? null : 'Sin imagen');
      return { order: b.homeOrder as number, source: 'promo' as const, title: b.title, live: !reason, reason, outranked: false };
    }),
  ];

  const rank = (s: HomeSlot) => HOME_TIE_RANK[s.source === 'curated' ? 'productBanner' : s.source];
  slots.sort((a, b) => a.order - b.order || rank(a) - rank(b));

  // "Desplazada": comparte número con otra entrada VIVA que va antes.
  for (let i = 0; i < slots.length; i++) {
    slots[i].outranked = slots.slice(0, i).some((p) => p.order === slots[i].order && p.live);
  }
  return slots;
}
