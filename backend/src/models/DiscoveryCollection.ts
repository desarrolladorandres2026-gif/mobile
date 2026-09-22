import mongoose, { Schema, Document } from 'mongoose';
import { cacheInvalidationPlugin, CachePrefix } from '../cache';
import { PRODUCT_TAGS } from '../constants/productTags';
import { BusinessCategory } from '../types/enums';

/**
 * Una colección del feed de descubrimiento, definida en la base y no en el
 * código.
 *
 * Antes las veinte colecciones eran un array `sectionDefs` dentro de
 * `homeSections.service.ts`: cambiar un título era un despliegue, y probar
 * "Almuerzo por menos de $12.000" un martes era imposible. El propio
 * comentario del servicio ya lo anticipaba —decía que `displayVariant` vivía
 * en el backend "para que a futuro administración pueda reasignarlo sin
 * tocar código"—; esto es ese futuro.
 *
 * La pieza delicada es `rule`. Un administrador **nunca** puede escribir un
 * pipeline de Mongo desde un formulario: eso es inyección con pasos extra.
 * Por eso la regla es un lenguaje cerrado de una docena de variantes, y
 * `compileRule()` —en `services/discovery.service.ts`— es quien traduce cada
 * variante a un `$match` construido en código. Los valores del admin entran
 * como operandos, jamás como operadores.
 */

// ── El lenguaje de reglas ────────────────────────────────────────────

export type RuleSource =
  | 'tags'
  | 'discount'
  | 'price'
  | 'prepTime'
  | 'new'
  | 'featured'
  | 'sales'
  | 'businessRating'
  | 'businessCategory'
  | 'nearby'
  | 'personal';

export const RULE_SOURCES: RuleSource[] = [
  'tags', 'discount', 'price', 'prepTime', 'new', 'featured',
  'sales', 'businessRating', 'businessCategory', 'nearby', 'personal',
];

/** De dónde sale el ranking cuando la regla depende de ventas. */
export type SalesWindow = 'mostOrdered' | 'repeat' | 'trending';

/** Las cuatro secciones que solo existen si hay una sesión detrás. */
export type PersonalKind = 'reorder' | 'becauseYouOrdered' | 'neverTried' | 'fromFavorites';

export type Rule =
  /** Productos con **cualquiera** de estas etiquetas. Es la regla más usada. */
  | { source: 'tags'; any: string[] }
  | { source: 'discount'; minPercent: number }
  | { source: 'price'; min?: number; max?: number }
  | { source: 'prepTime'; maxMinutes: number }
  /** Recién llegados: el producto, o el negocio que lo vende. */
  | { source: 'new'; withinDays: number; of: 'product' | 'business' }
  | { source: 'featured' }
  | { source: 'sales'; window: SalesWindow }
  | { source: 'businessRating'; min: number; minReviews?: number }
  | { source: 'businessCategory'; any: string[] }
  /** Ordena por distancia real. Sin coordenadas, la colección se salta. */
  | { source: 'nearby' }
  | { source: 'personal'; kind: PersonalKind };

export type SortBy =
  | 'relevance' | 'discount' | 'price_asc' | 'price_desc'
  | 'newest' | 'rating' | 'distance' | 'prep' | 'sales';

export const SORT_OPTIONS: SortBy[] = [
  'relevance', 'discount', 'price_asc', 'price_desc',
  'newest', 'rating', 'distance', 'prep', 'sales',
];

export interface RuleDSL {
  /**
   * Condiciones en AND. El tope de cuatro no es técnico: una colección con
   * cinco condiciones encadenadas devuelve dos productos en un catálogo de
   * pueblo, y una sección de dos productos no se publica.
   */
  all: Rule[];
  sortBy: SortBy;
}

export const MAX_RULES_PER_COLLECTION = 4;

// ── Presentación ─────────────────────────────────────────────────────

/**
 * Qué componente pinta la colección en la app.
 *
 * Los siete primeros son las variantes de tarjeta de producto que ya existen
 * en `mobile/components/domain/ProductCollectionRow.tsx`. `grid` es la única
 * que no es un carrusel horizontal: pinta 3 columnas × 4 filas (doce como
 * máximo, y solo en Explorar; en Inicio cae a `price_focus`), pensada para las
 * colecciones de "buscar entre muchas opciones baratas" en vez de "un hero a
 * la vez". Los dos últimos son de negocio, no de producto, y por eso la
 * colección que los use tiene que devolver negocios.
 */
export type DisplayVariant =
  | 'compact' | 'large' | 'horizontal' | 'featured' | 'price_focus' | 'banner' | 'grid'
  | 'business_row' | 'spotlight';

export const DISPLAY_VARIANTS: DisplayVariant[] = [
  'compact', 'large', 'horizontal', 'featured', 'price_focus', 'banner', 'grid',
  'business_row', 'spotlight',
];

/** A qué pantalla va esta colección. */
export type CollectionFeed = 'home' | 'explore' | 'both';

export const COLLECTION_FEEDS: CollectionFeed[] = ['home', 'explore', 'both'];

/**
 * Franjas del día, en hora de Bogotá.
 *
 * Un array vacío significa "a cualquier hora". Existe porque hoy "Para
 * empezar el día" ☕ se muestra a las tres de la mañana igual que a las ocho,
 * y eso es lo contrario de lo que promete su título.
 */
export type Daypart = 'madrugada' | 'manana' | 'tarde' | 'noche';

export const DAYPARTS: Daypart[] = ['madrugada', 'manana', 'tarde', 'noche'];

/** Los cortes, en hora local. La madrugada es el hueco que queda. */
export const DAYPART_RANGES: Record<Exclude<Daypart, 'madrugada'>, [number, number]> = {
  manana: [5, 11],
  tarde: [11, 18],
  noche: [18, 23],
};

export function daypartAt(date: Date, timeZone = 'America/Bogota'): Daypart {
  // La zona se fija a propósito: el servidor puede estar en UTC y este
  // proyecto ya se quemó una vez calculando horarios con la hora local del
  // proceso.
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(date)
  );
  if (hour >= 5 && hour < 11) return 'manana';
  if (hour >= 11 && hour < 18) return 'tarde';
  if (hour >= 18 && hour < 23) return 'noche';
  return 'madrugada';
}

/** Cómo cambia la colección de un día para otro. */
export type RotationMode = 'none' | 'daily' | 'daypart';

export const ROTATION_MODES: RotationMode[] = ['none', 'daily', 'daypart'];

// ── El modelo ────────────────────────────────────────────────────────

export interface IDiscoveryCollection extends Document {
  key: string;
  title: string;
  subtitle?: string;
  /** Nombre de la mini-ilustración que acompaña al encabezado. */
  illustration?: string;
  feed: CollectionFeed;
  displayVariant: DisplayVariant;
  rule: RuleDSL;
  /** Mismo espacio numérico que `CuratedHomeBlock.order` y `PromotionBanner.homeOrder`. */
  order: number;
  dayparts: Daypart[];
  /** 0 = domingo, como `Date.getDay()`. Vacío = cualquier día. */
  weekdays: number[];
  minSize: number;
  targetSize: number;
  rotation: RotationMode;
  /**
   * Si una regla `tags` puede caer a la regex de palabras clave cuando el
   * campo `tags` todavía está vacío.
   *
   * Es un puente, no una función: existe solo mientras el relleno
   * (`scripts/backfillProductTags.ts`) no haya corrido en producción. Se
   * apaga cuando la cobertura supere el 80%.
   */
  fallbackKeywords: boolean;
  isActive: boolean;
  startDate?: Date;
  endDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cuántas colecciones activas admite un feed.
 *
 * El resultado de un `$facet` es **un solo documento** y está sujeto al
 * límite de 16 MB de BSON. Con 40 ramas × 30 candidatos × ~1 KB estamos en
 * ~1,2 MB: sobra. Pero el tope existe sobre todo por producto: un feed de
 * ochenta secciones no lo mira nadie, y el error hay que darlo al crearla,
 * no descubrirlo cuando la consulta reviente.
 */
export const MAX_ACTIVE_COLLECTIONS_PER_FEED = 40;

const discoveryCollectionSchema = new Schema<IDiscoveryCollection>(
  {
    key: {
      type: String,
      required: [true, 'La clave es requerida'],
      unique: true,
      trim: true,
      maxlength: [40, 'La clave no puede exceder 40 caracteres'],
      // Sin `lowercase: true` a propósito. Las veinte claves que se migran
      // vienen en camelCase (`losMasPedidos`) y la app las usa como índice
      // de sus mapas de ilustración y de encabezado
      // (`ProductCollectionRow.tsx`). Aplastarlas a minúsculas rompería esos
      // mapas sin un solo error: la sección seguiría pintándose, pero sin
      // ilustración y con el encabezado por defecto.
      match: [/^[a-zA-Z0-9-]+$/, 'La clave solo admite letras, números y guiones'],
    },
    title: {
      type: String,
      required: [true, 'El título es requerido'],
      trim: true,
      maxlength: [60, 'El título no puede exceder 60 caracteres'],
    },
    subtitle: {
      type: String,
      trim: true,
      maxlength: [120, 'El subtítulo no puede exceder 120 caracteres'],
    },
    illustration: { type: String, trim: true, maxlength: 40 },
    feed: {
      type: String,
      enum: COLLECTION_FEEDS,
      required: true,
      default: 'explore',
    },
    displayVariant: {
      type: String,
      enum: DISPLAY_VARIANTS,
      required: true,
      default: 'compact',
    },
    rule: {
      type: Schema.Types.Mixed,
      required: [true, 'La regla es requerida'],
      // La forma exacta la valida Zod en el controlador, antes de llegar
      // aquí: un `Mixed` en Mongoose no puede expresar una unión
      // discriminada, y dejar que un objeto mal formado entre a la base
      // significa que la colección revienta al pintarse, no al guardarse.
      validate: {
        validator: (value: unknown) => {
          if (!value || typeof value !== 'object') return false;
          const dsl = value as RuleDSL;
          return (
            Array.isArray(dsl.all) &&
            dsl.all.length > 0 &&
            dsl.all.length <= MAX_RULES_PER_COLLECTION &&
            SORT_OPTIONS.includes(dsl.sortBy)
          );
        },
        message: `La regla debe tener entre 1 y ${MAX_RULES_PER_COLLECTION} condiciones y un orden válido`,
      },
    },
    order: { type: Number, required: true, min: 0, max: 999 },
    dayparts: {
      type: [String],
      default: [],
      enum: { values: DAYPARTS, message: 'Franja horaria desconocida: {VALUE}' },
    },
    weekdays: {
      type: [Number],
      default: [],
      validate: {
        validator: (value: number[]) => value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'Los días de la semana van de 0 (domingo) a 6 (sábado)',
      },
    },
    minSize: { type: Number, default: 4, min: 1, max: 20 },
    targetSize: { type: Number, default: 10, min: 1, max: 30 },
    rotation: { type: String, enum: ROTATION_MODES, default: 'none' },
    fallbackKeywords: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    startDate: { type: Date },
    endDate: { type: Date },
  },
  { timestamps: true }
);

/** Mismo gancho de coherencia de fechas que `CuratedHomeBlock` y `PromotionBanner`. */
discoveryCollectionSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    this.invalidate('endDate', 'La fecha de finalización debe ser posterior a la de inicio');
  }
  if (this.targetSize < this.minSize) {
    this.invalidate('targetSize', 'El objetivo no puede ser menor que el mínimo');
  }
  next();
});

// La consulta que hace el motor en cada carga: las activas de un feed, en
// orden. Las fechas y las franjas se filtran en JS porque son opcionales y
// meterlas al índice no lo haría más selectivo.
discoveryCollectionSchema.index({ isActive: 1, feed: 1, order: 1 });

// Cambiar una definición invalida los dos feeds: una colección con
// `feed: 'both'` vive en ambos, y distinguirlo aquí sería optimizar la
// operación más rara a cambio de un error silencioso.
discoveryCollectionSchema.plugin(cacheInvalidationPlugin, {
  prefixesFor: () => [CachePrefix.HOME, CachePrefix.EXPLORE],
});

export const DiscoveryCollection = mongoose.model<IDiscoveryCollection>(
  'DiscoveryCollection',
  discoveryCollectionSchema
);

/** Lo que el panel necesita para pintar los selectores sin inventarse nada. */
export const DISCOVERY_OPTIONS = {
  sources: RULE_SOURCES,
  sorts: SORT_OPTIONS,
  variants: DISPLAY_VARIANTS,
  feeds: COLLECTION_FEEDS,
  dayparts: DAYPARTS,
  rotations: ROTATION_MODES,
  tags: PRODUCT_TAGS,
  businessCategories: Object.values(BusinessCategory),
  maxRules: MAX_RULES_PER_COLLECTION,
  maxActivePerFeed: MAX_ACTIVE_COLLECTIONS_PER_FEED,
} as const;
