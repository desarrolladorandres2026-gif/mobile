import {
  PREVIEW_MESSAGE,
  exploreContent,
  isAllowedPreviewOrigin,
  isRenderableSection,
  parsePreviewMessage,
  toBusinessBannerEntry,
  toHomeSection,
} from '../lib/exploreSections';
import type { ExploreFeed, ExploreProductsSection } from '../services/endpoints';

/**
 * Explorar publicado desde el panel: lo que la app sabe pintar, lo que se
 * salta, y el mensaje que acepta la vista previa. La regla que se prueba es
 * una sola — lo que no se entiende se salta, nunca rompe la pantalla.
 */

const product = { _id: 'p1', name: 'Pizza', businessId: 'b1' } as any;
const business = { _id: 'b1', name: 'Negocio' } as any;
const banner = { id: 'ban1', imageUrl: 'https://x/y.jpg' } as any;

function productsSection(layout: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'products', title: 'Mitad de precio', subtitle: '', showTitle: true,
    headerVariant: 'auto', key: 'descuentosLocos', displayVariant: 'grid', layout,
    products: [product], ...overrides,
  };
}

describe('isRenderableSection', () => {
  it('acepta los layouts que esta versión sabe pintar', () => {
    expect(isRenderableSection(productsSection({ kind: 'carousel', rows: 1, card: 'compact' }))).toBe(true);
    expect(isRenderableSection(productsSection({ kind: 'carousel', rows: 3, card: 'compact' }))).toBe(true);
    expect(isRenderableSection(productsSection({ kind: 'grid', columns: 4, rows: 3 }))).toBe(true);
    expect(isRenderableSection({ id: 'b', type: 'businesses', layout: { kind: 'spotlight' }, businesses: [business] })).toBe(true);
    expect(isRenderableSection({ id: 'p', type: 'promo', includeAd: true, banners: [banner] })).toBe(true);
  });

  it('salta tipos y layouts que llegaron antes que la actualización de la app', () => {
    expect(isRenderableSection({ id: 'x', type: 'hero_mosaic', products: [product] })).toBe(false);
    expect(isRenderableSection(productsSection({ kind: 'mosaic' }))).toBe(false);
    expect(isRenderableSection(productsSection({ kind: 'carousel', rows: 4 }))).toBe(false);
    expect(isRenderableSection(productsSection({ kind: 'grid', columns: 5, rows: 2 }))).toBe(false);
    expect(isRenderableSection({ id: 'b', type: 'businesses', layout: { kind: 'circles' }, businesses: [business] })).toBe(false);
  });

  it('salta secciones vacías o mal formadas', () => {
    expect(isRenderableSection(productsSection({ kind: 'carousel', rows: 1 }, { products: [] }))).toBe(false);
    expect(isRenderableSection({ id: 'p', type: 'promo', banners: [] })).toBe(false);
    expect(isRenderableSection({ type: 'promo', banners: [banner] })).toBe(false);
    expect(isRenderableSection(null)).toBe(false);
    expect(isRenderableSection('products')).toBe(false);
  });
});

describe('exploreContent', () => {
  const base = { daypart: 'tarde', personalized: false } as const;

  it('usa las secciones del constructor cuando llegan, y descarta las que no entiende', () => {
    const feed = {
      ...base,
      sections: [
        productsSection({ kind: 'carousel', rows: 2, card: 'compact' }),
        { id: 'z', type: 'algo_nuevo' },
      ],
    } as unknown as ExploreFeed;
    const content = exploreContent(feed);
    expect(content.mode).toBe('sections');
    if (content.mode === 'sections') expect(content.sections.map((s) => s.id)).toEqual(['s1']);
  });

  it('con un servidor anterior al constructor, pinta la forma de siempre', () => {
    const feed = {
      ...base,
      entries: [{ kind: 'collection', order: 10, key: 'k', emoji: '', title: 't', displayVariant: 'compact', products: [product] }],
    } as ExploreFeed;
    expect(exploreContent(feed).mode).toBe('entries');
  });

  it('sin nada que pintar, queda vacío en vez de dejar un hueco', () => {
    expect(exploreContent(undefined).mode).toBe('empty');
    expect(exploreContent({ ...base, sections: [{ id: 'z', type: 'algo_nuevo' }] } as unknown as ExploreFeed).mode).toBe('empty');
  });
});

describe('adaptadores a los componentes que ya existen', () => {
  it('una sección de productos conserva la clave de su colección (ilustración y encabezado)', () => {
    const home = toHomeSection(productsSection({ kind: 'grid', columns: 3, rows: 2 }) as unknown as ExploreProductsSection);
    expect(home).toMatchObject({ kind: 'collection', key: 'descuentosLocos', title: 'Mitad de precio', subtitle: undefined });
  });

  it('el spotlight de negocios enseña exactamente tres', () => {
    const entry = toBusinessBannerEntry({
      id: 'b', type: 'businesses', title: 'Top', subtitle: '', showTitle: true, headerVariant: 'auto',
      layout: { kind: 'spotlight' }, businesses: [business, business, business, business],
    });
    expect(entry.businesses).toHaveLength(3);
  });
});

describe('mensaje de la vista previa', () => {
  it('solo acepta el mensaje del panel con la forma esperada', () => {
    const ok = parsePreviewMessage({
      type: PREVIEW_MESSAGE.sections,
      sections: [productsSection({ kind: 'carousel', rows: 1, card: 'large' }), { id: 'x', type: 'raro' }],
    });
    expect(ok?.map((s) => s.id)).toEqual(['s1']);

    expect(parsePreviewMessage({ type: 'otro', sections: [] })).toBeNull();
    expect(parsePreviewMessage({ type: PREVIEW_MESSAGE.sections, sections: 'nope' })).toBeNull();
    expect(parsePreviewMessage({ type: PREVIEW_MESSAGE.sections, sections: new Array(200).fill({}) })).toBeNull();
    expect(parsePreviewMessage('hola')).toBeNull();
  });

  it('solo el origen del panel configurado puede hablarle', () => {
    const allowed = ['https://admin.zipp.co', 'http://localhost:3001'];
    expect(isAllowedPreviewOrigin('https://admin.zipp.co', allowed)).toBe(true);
    expect(isAllowedPreviewOrigin('https://admin.zipp.co.evil.com', allowed)).toBe(false);
    expect(isAllowedPreviewOrigin('http://localhost:3002', allowed)).toBe(false);
  });
});
