import type {
  BusinessBannerEntry,
  BusinessCollectionEntry,
  ExploreBusinessesSection,
  ExploreEntry,
  ExploreFeed,
  ExploreProductsSection,
  ExploreSection,
  HomeSection,
} from '../services/endpoints';

/**
 * Lo que la app hace con las secciones que publica el constructor de
 * Explorar, sin nada de React para poder probarlo.
 *
 * La regla es una sola: **lo que no se entiende, se salta**. El servidor
 * puede aprender un layout nuevo antes de que esta versión de la app se
 * actualice en el teléfono de alguien; esa sección desaparece para esa
 * persona, pero el resto de Explorar se pinta igual.
 */

const CAROUSEL_ROWS = new Set([1, 2, 3]);
const GRID_COLUMNS = new Set([2, 3, 4]);
const BUSINESS_LAYOUTS = new Set(['row', 'spotlight']);

type Loose = Record<string, unknown>;

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Si esta versión de la app sabe pintar la sección. */
export function isRenderableSection(value: unknown): value is ExploreSection {
  if (!value || typeof value !== 'object') return false;
  const section = value as Loose;
  if (typeof section.id !== 'string') return false;

  switch (section.type) {
    case 'products': {
      const layout = section.layout as Loose | undefined;
      if (!layout || typeof section.key !== 'string' || !nonEmptyArray(section.products)) return false;
      if (layout.kind === 'carousel') return CAROUSEL_ROWS.has(layout.rows as number);
      if (layout.kind === 'grid') {
        const rows = layout.rows as number;
        return GRID_COLUMNS.has(layout.columns as number) && Number.isInteger(rows) && rows >= 1 && rows <= 4;
      }
      return false;
    }
    case 'businesses': {
      const layout = section.layout as Loose | undefined;
      return !!layout && BUSINESS_LAYOUTS.has(layout.kind as string) && nonEmptyArray(section.businesses);
    }
    case 'promo':
      return nonEmptyArray(section.banners);
    default:
      return false;
  }
}

export function renderableSections(sections: unknown): ExploreSection[] {
  return Array.isArray(sections) ? sections.filter(isRenderableSection) : [];
}

export type ExploreContent =
  | { mode: 'sections'; sections: ExploreSection[] }
  | { mode: 'entries'; entries: ExploreEntry[] }
  | { mode: 'empty' };

/**
 * Qué se pinta: las secciones del constructor si llegaron, o la forma de
 * siempre si el servidor todavía no conoce el constructor.
 */
export function exploreContent(feed: ExploreFeed | null | undefined): ExploreContent {
  if (!feed) return { mode: 'empty' };
  if (Array.isArray(feed.sections)) {
    const sections = renderableSections(feed.sections);
    return sections.length ? { mode: 'sections', sections } : { mode: 'empty' };
  }
  if (feed.entries?.length) return { mode: 'entries', entries: feed.entries };
  return { mode: 'empty' };
}

/** Una sección de productos en la forma que ya sabe pintar `ProductCollectionRow`. */
export function toHomeSection(section: ExploreProductsSection): HomeSection {
  return {
    kind: 'collection',
    order: 0,
    key: section.key,
    emoji: '',
    title: section.title,
    subtitle: section.subtitle || undefined,
    illustration: section.illustration,
    displayVariant: section.displayVariant,
    products: section.products,
  };
}

export function toBusinessRowEntry(section: ExploreBusinessesSection): BusinessCollectionEntry {
  return {
    kind: 'businessCollection',
    order: 0,
    title: section.title,
    subtitle: section.subtitle || undefined,
    businesses: section.businesses,
  };
}

/** El spotlight de negocios enseña exactamente tres, como el bloque curado del inicio. */
export function toBusinessBannerEntry(section: ExploreBusinessesSection): BusinessBannerEntry {
  return {
    kind: 'businessBanner',
    order: 0,
    title: section.title,
    subtitle: section.subtitle || undefined,
    businesses: section.businesses.slice(0, 3),
  };
}

// ── Vista previa del panel ────────────────────────────────────────────

/**
 * El protocolo entre el panel y la vista previa (un iframe).
 *
 * El panel resuelve el borrador contra la API con su propia sesión y le
 * manda al iframe las secciones ya resueltas: el iframe no llama a la API
 * ni guarda ningún token.
 */
export const PREVIEW_MESSAGE = {
  /** Del iframe al panel: ya puedo recibir secciones. */
  ready: 'zipp-explore-preview:ready',
  /** Del panel al iframe: pinta estas secciones. */
  sections: 'zipp-explore-preview:sections',
} as const;

/** Tope defensivo: el backend ya limita el layout a 24 secciones (las bandas se expanden). */
const MAX_PREVIEW_SECTIONS = 80;

/** Valida un mensaje del panel. `null` si no es nuestro o no tiene la forma esperada. */
export function parsePreviewMessage(data: unknown): ExploreSection[] | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Loose;
  if (message.type !== PREVIEW_MESSAGE.sections) return null;
  if (!Array.isArray(message.sections) || message.sections.length > MAX_PREVIEW_SECTIONS) return null;
  return renderableSections(message.sections);
}

/** Solo el panel configurado puede hablarle a la vista previa. */
export function isAllowedPreviewOrigin(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => candidate === origin);
}
