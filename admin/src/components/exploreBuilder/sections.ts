import type {
 BuilderOptions, ProductCard, ProductLayout, Rule, RuleSource, Section, SectionRules, SectionType,
} from './types';

/**
 * Nombres, valores por defecto y resúmenes de las secciones: lo que el
 * constructor enseña para que se diseñe Explorar sin leer JSON.
 */

export const TYPE_LABEL: Record<SectionType, string> = {
 products: 'Productos',
 businesses: 'Negocios',
 discovery_band: 'Descubrimiento automático',
 promo: 'Banners y anuncio',
};

export const TYPE_HINT: Record<SectionType, string> = {
 products: 'Una colección, una regla propia o productos elegidos a mano.',
 businesses: 'Negocios elegidos a mano o por categoría y calificación.',
 discovery_band: 'El motor elige y rota colecciones por día y franja horaria.',
 promo: 'Los banners gratuitos de Explorar y, si lo marcas, el anuncio pagado.',
};

export const CARD_LABEL: Record<ProductCard, string> = {
 compact: 'Compacta',
 large: 'Grande',
 horizontal: 'Horizontal',
 featured: 'Foto protagonista',
 price_focus: 'Precio primero',
};

export const HEADER_LABEL: Record<string, string> = {
 auto: 'Automático',
 editorial: 'Editorial',
 numbered: 'Numerado',
 illustrated: 'Ilustrado',
 featured: 'Destacado',
 minimal: 'Mínimo',
 trend: 'Tendencia',
 commercial: 'Comercial',
};

export const DAYPART_LABEL: Record<string, string> = {
 madrugada: 'Madrugada',
 manana: 'Mañana',
 tarde: 'Tarde',
 noche: 'Noche',
};

/** 0 = domingo, igual que el backend (hora de Bogotá). */
export const WEEKDAY_LABEL = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export const SOURCE_LABEL: Record<RuleSource, string> = {
 tags: 'Etiquetas del producto',
 discount: 'Descuento mínimo',
 price: 'Rango de precio',
 prepTime: 'Tiempo de preparación',
 new: 'Recién llegados',
 featured: 'Destacados',
 sales: 'Ventas',
 businessRating: 'Calificación del negocio',
 businessCategory: 'Categoría del negocio',
 nearby: 'Cercanía',
};

export const SORT_LABEL: Record<string, string> = {
 relevance: 'Relevancia',
 discount: 'Mayor descuento',
 price_asc: 'Precio: menor primero',
 price_desc: 'Precio: mayor primero',
 newest: 'Más recientes',
 rating: 'Mejor calificados',
 distance: 'Más cerca',
 prep: 'Más rápidos',
 sales: 'Más vendidos',
};

export const SALES_LABEL: Record<string, string> = {
 mostOrdered: 'Más pedidos (30 días)',
 repeat: 'Pide y repite',
 trending: 'En tendencia',
};

export const CATEGORY_LABEL: Record<string, string> = {
 restaurant: 'Restaurantes',
 fast_food: 'Comidas rápidas',
 pharmacy: 'Droguería',
 cafe: 'Cafeterías',
 supermarket: 'Supermercados',
};

export const NO_RULES: SectionRules = { dayparts: [], weekdays: [], startDate: null, endDate: null };

/** Cumple el formato que valida el backend (`^[a-zA-Z0-9_-]{3,40}$`). */
export function newSectionId(): string {
 return `sec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultRule(source: RuleSource): Rule {
 switch (source) {
 case 'tags': return { source, any: [] };
 case 'discount': return { source, minPercent: 20 };
 case 'price': return { source, max: 15000 };
 case 'prepTime': return { source, maxMinutes: 20 };
 case 'new': return { source, withinDays: 30, of: 'product' };
 case 'sales': return { source, window: 'mostOrdered' };
 case 'businessRating': return { source, min: 4.5 };
 case 'businessCategory': return { source, any: [] };
 default: return { source } as Rule;
 }
}

export function newSection(type: SectionType, options: BuilderOptions | null): Section {
 const base = {
 id: newSectionId(),
 hidden: false,
 title: '',
 subtitle: '',
 showTitle: true,
 headerVariant: 'auto' as const,
 rules: { ...NO_RULES },
 };
 switch (type) {
 case 'products': {
 const collection = options?.collections.find((c) => c.isActive && c.feed !== 'home') ?? options?.collections[0];
 return {
 ...base,
 type,
 dataSource: collection ? { kind: 'collection', key: collection.key } : { kind: 'manual', productIds: [] },
 layout: { kind: 'carousel', rows: 1, card: 'compact' },
 };
 }
 case 'businesses':
 return {
 ...base,
 type,
 title: 'Negocios',
 dataSource: { kind: 'query', categories: [], minRating: 0, sortBy: 'rating', limit: 10 },
 layout: { kind: 'row' },
 };
 case 'discovery_band':
 return {
 ...base,
 type,
 title: 'Descubrimiento automático',
 showTitle: false,
 take: 'rest',
 pattern: [{ kind: 'carousel', rows: 2, card: 'compact' }],
 };
 case 'promo':
 return { ...base, type, title: 'Banners', showTitle: false, includeAd: false };
 }
}

/** Una copia con id nuevo, justo debajo de la original. */
export function duplicateSection(section: Section): Section {
 const copy = JSON.parse(JSON.stringify(section)) as Section;
 copy.id = newSectionId();
 // El anuncio solo puede ir en un bloque: la copia nace sin él.
 if (copy.type === 'promo') copy.includeAd = false;
 if (copy.title) copy.title = `${copy.title} (copia)`.slice(0, 60);
 return copy;
}

export function layoutLabel(layout: ProductLayout): string {
 if (layout.kind === 'grid') return `Cuadrícula ${layout.columns} × ${layout.rows}`;
 if (layout.rows === 1) return `Carrusel · ${CARD_LABEL[layout.card]}`;
 return `Carrusel de ${layout.rows} filas`;
}

/** La línea de resumen de cada sección en la lista. */
export function sectionSummary(section: Section, options: BuilderOptions | null): string {
 switch (section.type) {
 case 'products': {
 const source = section.dataSource;
 const from = source.kind === 'collection'
 ? options?.collections.find((c) => c.key === source.key)?.title ?? source.key
 : source.kind === 'rule'
 ? `Regla propia (${source.rule.all.length} condición${source.rule.all.length === 1 ? '' : 'es'})`
 : `${source.productIds.length} elegido${source.productIds.length === 1 ? '' : 's'} a mano`;
 return `${from} · ${layoutLabel(section.layout)}`;
 }
 case 'businesses': {
 const how = section.dataSource.kind === 'manual'
 ? `${section.dataSource.businessIds.length} a mano`
 : 'Por consulta';
 return `${how} · ${section.layout.kind === 'spotlight' ? 'Spotlight de 3' : 'Fila'}`;
 }
 case 'discovery_band':
 return `${section.take === 'rest' ? 'Todas las restantes' : `Hasta ${section.take} colecciones`} · ${section.pattern.map(layoutLabel).join(' → ')}`;
 case 'promo':
 return section.includeAd ? 'Banners + anuncio pagado' : 'Solo banners gratuitos';
 }
}

export function sectionTitle(section: Section, options: BuilderOptions | null): string {
 if (section.title) return section.title;
 if (section.type === 'products' && section.dataSource.kind === 'collection') {
 const key = section.dataSource.key;
 return options?.collections.find((c) => c.key === key)?.title ?? TYPE_LABEL[section.type];
 }
 return TYPE_LABEL[section.type];
}

/** Máximo de filas que admite una cuadrícula de N columnas (tope de doce productos). */
export function maxGridRows(columns: number, maxItems = 12): number {
 return Math.min(4, Math.floor(maxItems / columns));
}
