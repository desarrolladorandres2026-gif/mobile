import type { ExploreSection, ProductLayout } from '../validators/exploreLayout.validator';

/**
 * El Explorar de siempre, escrito como layout.
 *
 * Es a la vez el respaldo en código —lo que se sirve si nunca se publicó
 * nada o si lo publicado quedó ilegible— y la semilla de la migración 010.
 * Reproduce lo que había antes del constructor: las colecciones del motor
 * alternando dos filas desplazables con la cuadrícula 3×4, y el bloque de
 * banners con el anuncio pagado a media altura.
 *
 * Si cambias esto, cambias lo que ve todo el mundo mientras no haya una
 * versión publicada: tócalo con el mismo cuidado que una publicación.
 */

export const DEFAULT_BAND_PATTERN: ProductLayout[] = [
  { kind: 'carousel', rows: 2, card: 'compact' },
  { kind: 'carousel', rows: 2, card: 'compact' },
  { kind: 'grid', columns: 3, rows: 4 },
];

const noRules = { dayparts: [], weekdays: [], startDate: null, endDate: null };

export const DEFAULT_EXPLORE_LAYOUT: ExploreSection[] = [
  {
    id: 'default-band-top',
    type: 'discovery_band',
    hidden: false,
    title: 'Descubrimiento automático',
    subtitle: '',
    showTitle: false,
    headerVariant: 'auto',
    rules: noRules,
    take: 6,
    pattern: DEFAULT_BAND_PATTERN,
  },
  {
    id: 'default-promo',
    type: 'promo',
    hidden: false,
    title: 'Banners y anuncio',
    subtitle: '',
    showTitle: false,
    headerVariant: 'auto',
    rules: noRules,
    includeAd: true,
  },
  {
    id: 'default-band-rest',
    type: 'discovery_band',
    hidden: false,
    title: 'Descubrimiento automático',
    subtitle: '',
    showTitle: false,
    headerVariant: 'auto',
    rules: noRules,
    take: 'rest',
    pattern: DEFAULT_BAND_PATTERN,
  },
];
