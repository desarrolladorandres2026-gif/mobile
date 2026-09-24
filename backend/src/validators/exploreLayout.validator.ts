import { z } from 'zod';
import { PRODUCT_TAGS } from '../constants/productTags';
import { BusinessCategory } from '../types/enums';
import { DAYPARTS, MAX_RULES_PER_COLLECTION, SORT_OPTIONS } from '../models/DiscoveryCollection';

/**
 * El formato de una sección de Explorar.
 *
 * Es la **única** fuente de verdad: la app y el panel llevan tipos espejo,
 * pero lo que decide si algo se guarda, se previsualiza o se publica es
 * esto. Todo lo que el admin elige entra como valor de un enum o de un
 * rango cerrado — nunca como nombre de campo, operador de Mongo ni URL —
 * para que un borrador mal armado no pueda romper la app ni la consulta.
 *
 * `EXPLORE_SCHEMA_VERSION` viaja guardado con cada borrador y versión: si el
 * formato cambia, lo viejo se sigue leyendo sección por sección y lo que ya
 * no valida se descarta solo, sin tumbar el resto.
 */

export const EXPLORE_SCHEMA_VERSION = 1;
export const MAX_SECTIONS = 24;

/** Una cuadrícula nunca pasa de doce productos (`docs/EXPLORAR.md` §5). */
export const MAX_GRID_ITEMS = 12;

const OBJECT_ID = /^[a-f\d]{24}$/i;
const objectId = z.string().regex(OBJECT_ID, 'Identificador inválido');
const sectionId = z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/, 'Identificador de sección inválido');
const text = (max: number) => z.string().trim().max(max);

/**
 * Los encabezados de `CollectionHeader.tsx`. `auto` deja que la app elija
 * por la clave de la colección, como hacía antes del constructor: las
 * colecciones de siempre ya tienen el suyo asignado en el cliente.
 */
export const HEADER_VARIANTS = [
  'auto', 'editorial', 'numbered', 'illustrated', 'featured', 'minimal', 'trend', 'commercial',
] as const;

/** Las tarjetas de una fila que ya existen en `ProductCollectionRow.tsx`. */
export const PRODUCT_CARDS = ['compact', 'large', 'horizontal', 'featured', 'price_focus'] as const;

const BUSINESS_CATEGORIES = Object.values(BusinessCategory) as [string, ...string[]];

// ── Regla de datos: el mismo lenguaje cerrado de `DiscoveryCollection` ──
//
// `personal` queda fuera: el motor no la implementa (`compileRule` devuelve
// null y la colección se salta), así que ofrecerla sería prometer una
// sección que nunca sale.

const ruleSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('tags'), any: z.array(z.enum(PRODUCT_TAGS as unknown as [string, ...string[]])).min(1).max(10) }),
  z.object({ source: z.literal('discount'), minPercent: z.number().int().min(1).max(95) }),
  z.object({
    source: z.literal('price'),
    min: z.number().int().min(0).max(10_000_000).optional(),
    max: z.number().int().min(0).max(10_000_000).optional(),
  }),
  z.object({ source: z.literal('prepTime'), maxMinutes: z.number().int().min(5).max(240) }),
  z.object({ source: z.literal('new'), withinDays: z.number().int().min(1).max(365), of: z.enum(['product', 'business']) }),
  z.object({ source: z.literal('featured') }),
  z.object({ source: z.literal('sales'), window: z.enum(['mostOrdered', 'repeat', 'trending']) }),
  z.object({
    source: z.literal('businessRating'),
    min: z.number().min(0).max(5),
    minReviews: z.number().int().min(0).max(100_000).optional(),
  }),
  z.object({ source: z.literal('businessCategory'), any: z.array(z.enum(BUSINESS_CATEGORIES)).min(1).max(10) }),
  z.object({ source: z.literal('nearby') }),
]);

export const ruleDSLSchema = z
  .object({
    all: z.array(ruleSchema).min(1).max(MAX_RULES_PER_COLLECTION),
    sortBy: z.enum(SORT_OPTIONS as [string, ...string[]]).default('relevance'),
  })
  .superRefine((dsl, ctx) => {
    dsl.all.forEach((rule, i) => {
      if (rule.source !== 'price') return;
      if (rule.min === undefined && rule.max === undefined) {
        ctx.addIssue({ code: 'custom', path: ['all', i], message: 'El rango de precio necesita un mínimo o un máximo' });
      } else if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
        ctx.addIssue({ code: 'custom', path: ['all', i], message: 'El precio mínimo no puede superar al máximo' });
      }
    });
  });

// ── Piezas comunes ──────────────────────────────────────────────────

const rulesSchema = z
  .object({
    dayparts: z.array(z.enum(DAYPARTS as [string, ...string[]])).max(4).default([]),
    /** 0 = domingo, en hora de Bogotá. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    startDate: z.coerce.date().nullable().default(null),
    endDate: z.coerce.date().nullable().default(null),
  })
  .default({});

const common = {
  id: sectionId,
  hidden: z.boolean().default(false),
  title: text(60).default(''),
  subtitle: text(120).default(''),
  showTitle: z.boolean().default(true),
  headerVariant: z.enum(HEADER_VARIANTS).default('auto'),
  rules: rulesSchema,
};

const carouselLayout = z.object({
  kind: z.literal('carousel'),
  rows: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  /** Solo cuenta con una fila; con dos o tres se usa la tarjeta compacta de cuadrícula. */
  card: z.enum(PRODUCT_CARDS).default('compact'),
});

const gridLayout = z.object({
  kind: z.literal('grid'),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  rows: z.number().int().min(1).max(4).default(2),
});

export const productLayoutSchema = z.discriminatedUnion('kind', [carouselLayout, gridLayout]);

const productSourceSchema = z.discriminatedUnion('kind', [
  /** Una colección de la base, aunque su `feed` sea el del inicio. */
  z.object({ kind: z.literal('collection'), key: z.string().trim().regex(/^[a-zA-Z0-9-]{1,40}$/, 'Clave de colección inválida') }),
  /** Una regla propia de la sección, versionada con el layout. */
  z.object({
    kind: z.literal('rule'),
    rule: ruleDSLSchema,
    minSize: z.number().int().min(1).max(20).default(4),
    targetSize: z.number().int().min(1).max(30).default(10),
  }),
  z.object({ kind: z.literal('manual'), productIds: z.array(objectId).min(1).max(20) }),
]);

const businessSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), businessIds: z.array(objectId).min(1).max(20) }),
  z.object({
    kind: z.literal('query'),
    categories: z.array(z.enum(BUSINESS_CATEGORIES)).max(10).default([]),
    minRating: z.number().min(0).max(5).default(0),
    sortBy: z.enum(['rating', 'newest', 'nearby']).default('rating'),
    limit: z.number().int().min(3).max(20).default(10),
  }),
]);

// ── Tipos de sección ────────────────────────────────────────────────

const productsSection = z.object({
  ...common,
  type: z.literal('products'),
  dataSource: productSourceSchema,
  layout: productLayoutSchema,
});

const businessesSection = z.object({
  ...common,
  type: z.literal('businesses'),
  dataSource: businessSourceSchema,
  layout: z.object({ kind: z.enum(['row', 'spotlight']).default('row') }).default({}),
});

/**
 * La banda de descubrimiento automático: colecciones que elige el motor,
 * con su rotación diaria y por franja. Varias bandas comparten la misma
 * bolsa; `pattern` se aplica en ciclo a lo que va entrando.
 */
const bandSection = z.object({
  ...common,
  type: z.literal('discovery_band'),
  take: z.union([z.number().int().min(1).max(40), z.literal('rest')]).default('rest'),
  pattern: z.array(productLayoutSchema).min(1).max(6),
});

/** Los banners de `PromotionBanner` y, si `includeAd`, la campaña pagada del momento. */
const promoSection = z.object({
  ...common,
  type: z.literal('promo'),
  includeAd: z.boolean().default(false),
});

type ProductLayout = z.infer<typeof productLayoutSchema>;

function checkLayout(layout: ProductLayout, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (layout.kind === 'grid' && layout.columns * layout.rows > MAX_GRID_ITEMS) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `Una cuadrícula no puede pasar de ${MAX_GRID_ITEMS} productos (columnas × filas)`,
    });
  }
}

export const sectionSchema = z
  .discriminatedUnion('type', [productsSection, businessesSection, bandSection, promoSection])
  .superRefine((section, ctx) => {
    const { startDate, endDate } = section.rules;
    if (startDate && endDate && endDate <= startDate) {
      ctx.addIssue({ code: 'custom', path: ['rules', 'endDate'], message: 'La fecha de fin debe ser posterior a la de inicio' });
    }
    if (section.type === 'products') checkLayout(section.layout, ctx, ['layout']);
    if (section.type === 'discovery_band') {
      section.pattern.forEach((layout, i) => checkLayout(layout, ctx, ['pattern', i]));
    }
  });

export type ExploreSection = z.infer<typeof sectionSchema>;
export type ProductsSection = Extract<ExploreSection, { type: 'products' }>;
export type BusinessesSection = Extract<ExploreSection, { type: 'businesses' }>;
export type DiscoveryBandSection = Extract<ExploreSection, { type: 'discovery_band' }>;
export type PromoSection = Extract<ExploreSection, { type: 'promo' }>;
export type { ProductLayout };

/** Un borrador: cada sección válida, ids únicos, dentro del tope. */
export const draftSectionsSchema = z
  .array(sectionSchema)
  .max(MAX_SECTIONS, `Explorar admite hasta ${MAX_SECTIONS} secciones`)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((section, i) => {
      if (seen.has(section.id)) {
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Hay dos secciones con el mismo identificador' });
      }
      seen.add(section.id);
    });
  });

/**
 * Lo que además tiene que cumplir un layout para publicarse.
 *
 * No va en el borrador porque un borrador a medio armar puede no cumplirlo
 * todavía. La campaña pagada es dinero de anunciantes: si nadie le deja un
 * sitio visible, deja de mostrarse sin que nadie se entere.
 */
export function publishProblems(sections: ExploreSection[]): string[] {
  const problems: string[] = [];
  const visible = sections.filter((s) => !s.hidden);

  const adSlots = visible.filter((s) => s.type === 'promo' && s.includeAd);
  if (adSlots.length === 0) {
    problems.push('Falta un bloque de banners con el anuncio pagado visible');
  } else if (adSlots.length > 1) {
    problems.push('Solo un bloque de banners puede llevar el anuncio pagado');
  }
  const hiddenAd = sections.some((s) => s.type === 'promo' && s.includeAd && s.hidden);
  if (hiddenAd) problems.push('El bloque del anuncio pagado no puede estar oculto');

  if (!visible.some((s) => s.type !== 'promo')) {
    problems.push('Explorar necesita al menos una sección de contenido visible');
  }
  return problems;
}

/**
 * Lee secciones guardadas sin confiar en ellas.
 *
 * Una sección que ya no valida (formato viejo, dato corrupto) se descarta
 * sola; el resto sigue. Es lo que impide que un documento dañado deje
 * Explorar en blanco.
 */
export function parseSectionsLenient(raw: unknown): { sections: ExploreSection[]; dropped: number } {
  if (!Array.isArray(raw)) return { sections: [], dropped: 0 };
  const sections: ExploreSection[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw.slice(0, MAX_SECTIONS)) {
    const parsed = sectionSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) {
      dropped++;
      continue;
    }
    seen.add(parsed.data.id);
    sections.push(parsed.data);
  }
  return { sections, dropped: dropped + Math.max(0, raw.length - MAX_SECTIONS) };
}

// ── Esquemas de las rutas ───────────────────────────────────────────

const revision = z.number().int().min(0);
const coordsBody = {
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
};

export const saveExploreDraftSchema = z.object({
  body: z.object({ sections: draftSectionsSchema, revision }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const previewExploreLayoutSchema = z.object({
  body: z.object({ sections: draftSectionsSchema, ...coordsBody }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const publishExploreLayoutSchema = z.object({
  body: z.object({ revision, note: text(200).default('') }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const restoreExploreVersionSchema = z.object({
  body: z.object({ revision, mode: z.enum(['draft', 'publish']).default('draft') }),
  query: z.object({}).optional(),
  params: z.object({ version: z.coerce.number().int().min(1) }),
});
