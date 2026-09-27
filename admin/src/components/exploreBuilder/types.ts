/**
 * Espejo del formato de sección de Explorar.
 *
 * La fuente de verdad es `backend/src/validators/exploreLayout.validator.ts`:
 * lo que decide si algo se guarda o se publica es el backend. Aquí solo está
 * lo que el panel necesita para armar formularios sin inventarse valores.
 */

export type Daypart = 'madrugada' | 'manana' | 'tarde' | 'noche';

export type HeaderVariant =
 | 'auto' | 'editorial' | 'numbered' | 'illustrated' | 'featured' | 'minimal' | 'trend' | 'commercial';

export type ProductCard = 'compact' | 'large' | 'horizontal' | 'featured' | 'price_focus';

export type ProductLayout =
 | { kind: 'carousel'; rows: 1 | 2 | 3; card: ProductCard }
 | { kind: 'grid'; columns: 2 | 3 | 4; rows: number };

export interface SectionRules {
 dayparts: Daypart[];
 weekdays: number[];
 startDate: string | null;
 endDate: string | null;
}

export type Rule =
 | { source: 'tags'; any: string[] }
 | { source: 'discount'; minPercent: number }
 | { source: 'price'; min?: number; max?: number }
 | { source: 'prepTime'; maxMinutes: number }
 | { source: 'new'; withinDays: number; of: 'product' | 'business' }
 | { source: 'featured' }
 | { source: 'sales'; window: 'mostOrdered' | 'repeat' | 'trending' }
 | { source: 'businessRating'; min: number; minReviews?: number }
 | { source: 'businessCategory'; any: string[] }
 | { source: 'nearby' };

export type RuleSource = Rule['source'];

export interface RuleDSL {
 all: Rule[];
 sortBy: string;
}

export type ProductSource =
 | { kind: 'collection'; key: string }
 | { kind: 'rule'; rule: RuleDSL; minSize: number; targetSize: number }
 | { kind: 'manual'; productIds: string[] };

export type BusinessSource =
 | { kind: 'manual'; businessIds: string[] }
 | { kind: 'query'; categories: string[]; minRating: number; sortBy: 'rating' | 'newest' | 'nearby'; limit: number };

interface Common {
 id: string;
 hidden: boolean;
 title: string;
 subtitle: string;
 showTitle: boolean;
 headerVariant: HeaderVariant;
 rules: SectionRules;
}

export interface ProductsSection extends Common {
 type: 'products';
 dataSource: ProductSource;
 layout: ProductLayout;
}

export interface BusinessesSection extends Common {
 type: 'businesses';
 dataSource: BusinessSource;
 layout: { kind: 'row' | 'spotlight' };
}

export interface DiscoveryBandSection extends Common {
 type: 'discovery_band';
 take: number | 'rest';
 pattern: ProductLayout[];
}

export interface PromoSection extends Common {
 type: 'promo';
 includeAd: boolean;
}

export type Section = ProductsSection | BusinessesSection | DiscoveryBandSection | PromoSection;
export type SectionType = Section['type'];

export interface CollectionOption {
 _id: string;
 key: string;
 title: string;
 subtitle?: string;
 feed: 'home' | 'explore' | 'both';
 isActive: boolean;
 displayVariant: string;
 dayparts?: Daypart[];
 weekdays?: number[];
}

export interface BuilderOptions {
 collections: CollectionOption[];
 discovery: {
 sources: string[];
 sorts: string[];
 dayparts: Daypart[];
 tags: string[];
 businessCategories: string[];
 maxRules: number;
 };
 headerVariants: HeaderVariant[];
 productCards: ProductCard[];
 businessSorts: Array<'rating' | 'newest' | 'nearby'>;
 limits: { maxSections: number; maxGridItems: number; carouselCaps: Record<string, number> };
 defaultLayout: Section[];
}

export interface DraftResponse {
 sections: Section[];
 revision: number;
 currentVersion: number;
 dropped: number;
 updatedAt: string | null;
 updatedBy: { name?: string; email?: string } | null;
}

export interface VersionRow {
 _id: string;
 version: number;
 publishedAt: string;
 publishedBy: { name?: string; email?: string } | null;
 note: string;
 restoredFrom: number | null;
}

/** Lo que devuelve la vista previa: secciones ya resueltas para el iframe. */
export interface PreviewResponse {
 sections: unknown[];
 warnings: string[];
 blockers: string[];
}
