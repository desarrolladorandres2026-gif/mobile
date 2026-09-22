import { BusinessCategory } from '../types/enums';
import type {
  CollectionFeed, Daypart, DisplayVariant, RotationMode, RuleDSL,
} from '../models';

/**
 * Las colecciones con las que arranca el descubrimiento.
 *
 * Vive aquí y no dentro del script de siembra porque las pruebas necesitan
 * exactamente las mismas: si cada uno tuviera su copia, el día que alguien
 * cambiara una regla los tests seguirían pasando contra una definición que
 * ya no existe en producción, que es la peor forma de tener una red de
 * seguridad.
 */

export interface Seed {
  key: string;
  title: string;
  subtitle?: string;
  illustration?: string;
  feed: CollectionFeed;
  displayVariant: DisplayVariant;
  rule: RuleDSL;
  order: number;
  dayparts?: Daypart[];
  rotation?: RotationMode;
  /** Por defecto 10 (`seedToDocument`). `grid` (3×4) pide 12: las que caben, ni una más. */
  targetSize?: number;
  minSize?: number;
}

/**
 * Las veinte, en el mismo orden en el que se declaraban.
 *
 * El `order` conserva el espacio numérico de antes (10, 20, 30…) para que
 * los bloques curados y los banners anclados que ya tienen su número sigan
 * cayendo donde su administrador quiso.
 *
 * Las veinte van a **los dos** feeds. Hubo un intento de dejar el Inicio con
 * solo tres ("Los más pedidos", "Pide y repite", "Descuentos locos") y mudar
 * el resto a Explorar: el Inicio se quedó sin un solo producto, porque esas
 * tres dependen de ventas —y sin pedidos entregados no hay ranking— o de un
 * 15% de descuento que el catálogo no siempre junta. Peor aún, rompía la
 * intercalación: los bloques curados están numerados 15, 35, 65, 95… justo
 * para caer **entre** estas colecciones, y sin ellas se apilaban todos
 * seguidos al final. Si alguien vuelve a repartirlos, que sea midiendo antes
 * cuántas colecciones rinden de verdad en el catálogo.
 */
export const SEEDS: Seed[] = [
  {
    key: 'losMasPedidos',
    title: 'Los más pedidos',
    subtitle: 'Lo que más se pide ahora mismo',
    illustration: 'tendencia',
    displayVariant: 'large',
    rule: { all: [{ source: 'sales', window: 'mostOrdered' }], sortBy: 'sales' },
    order: 10,
    feed: 'both',
  },
  {
    key: 'pideYRepite',
    title: 'Pide y repite',
    subtitle: 'A la gente le gustó tanto que volvió por más',
    displayVariant: 'compact',
    rule: { all: [{ source: 'sales', window: 'repeat' }], sortBy: 'sales' },
    order: 20,
    feed: 'both',
  },
  {
    key: 'descuentosLocos',
    title: 'Descuentos locos',
    subtitle: 'Rebajas que se acaban cuando se acaban',
    displayVariant: 'grid',
    rule: { all: [{ source: 'discount', minPercent: 15 }], sortBy: 'discount' },
    order: 30,
    // grid 3×4: exactamente las doce que caben; el default de 10 la deja coja.
    targetSize: 12,
    feed: 'both',
  },
  {
    key: 'antojoDelDia',
    title: 'El antojo del día',
    displayVariant: 'compact',
    rule: {
      all: [{ source: 'tags', any: ['hamburguesa', 'perro', 'pizza', 'empanada', 'salchipapa'] }],
      sortBy: 'relevance',
    },
    order: 40,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'paraCompartir',
    title: 'Para compartir',
    subtitle: 'Porque comer solo tiene su gracia, pero no tanta',
    displayVariant: 'horizontal',
    rule: { all: [{ source: 'tags', any: ['para_compartir', 'combo'] }], sortBy: 'discount' },
    order: 50,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'algoDulce',
    title: 'Algo dulce',
    illustration: 'postre',
    displayVariant: 'featured',
    rule: {
      all: [{ source: 'tags', any: ['postre', 'helado', 'torta', 'brownie', 'waffle'] }],
      sortBy: 'relevance',
    },
    order: 60,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'paraEmpezarElDia',
    title: 'Para empezar el día',
    subtitle: 'Desayuno sin levantarte de la cama',
    displayVariant: 'compact',
    rule: {
      all: [{ source: 'tags', any: ['desayuno', 'cafe', 'pan', 'huevo', 'arepa', 'tamal'] }],
      sortBy: 'relevance',
    },
    order: 70,
    // La razón de ser de las franjas: hasta ahora esta colección salía a las
    // tres de la mañana con el mismo título.
    dayparts: ['manana'],
    feed: 'both',
  },
  {
    key: 'paraLaNoche',
    title: 'Para la noche',
    displayVariant: 'compact',
    rule: {
      all: [{ source: 'tags', any: ['hamburguesa', 'perro', 'pizza', 'salchipapa', 'combo'] }],
      sortBy: 'relevance',
    },
    order: 80,
    dayparts: ['noche'],
    feed: 'both',
  },
  {
    key: 'algoParaTomar',
    title: 'Algo para tomar',
    displayVariant: 'compact',
    rule: {
      all: [{
        source: 'tags',
        any: ['gaseosa', 'jugo', 'cafe', 'malteada', 'limonada', 'agua', 'cerveza'],
      }],
      sortBy: 'relevance',
    },
    order: 90,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'buenoYBarato',
    title: 'Bueno y barato',
    subtitle: 'Bien calificado sin que duela',
    displayVariant: 'grid',
    rule: {
      all: [{ source: 'price', max: 15000 }, { source: 'businessRating', min: 4 }],
      sortBy: 'price_asc',
    },
    order: 100,
    rotation: 'daily',
    feed: 'both',
    // grid 3×4: exactamente las doce que caben; el default de 10 la deja coja.
    targetSize: 12,
  },
  {
    key: 'listoParaPedir',
    title: 'Listo para pedir',
    subtitle: 'Sale de la cocina en menos de 20 minutos',
    displayVariant: 'compact',
    rule: { all: [{ source: 'prepTime', maxMinutes: 20 }], sortBy: 'prep' },
    order: 110,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'recienLlegados',
    title: 'Recién llegados',
    subtitle: 'Nuevo en la carta',
    illustration: 'notificaciones',
    displayVariant: 'compact',
    rule: { all: [{ source: 'new', withinDays: 21, of: 'product' }], sortBy: 'newest' },
    order: 120,
    feed: 'both',
  },
  {
    key: 'favoritosZipp',
    title: 'Zipp recomienda',
    illustration: 'favorito',
    displayVariant: 'featured',
    rule: { all: [{ source: 'featured' }], sortBy: 'newest' },
    order: 130,
    feed: 'both',
  },
  {
    key: 'estaEnTendencia',
    title: 'Está en tendencia',
    subtitle: 'Cada vez lo pide más gente',
    illustration: 'tendencia',
    displayVariant: 'compact',
    rule: { all: [{ source: 'sales', window: 'trending' }], sortBy: 'sales' },
    order: 140,
    feed: 'both',
  },
  {
    key: 'favoritosCiudad',
    title: 'Los favoritos de la ciudad',
    displayVariant: 'horizontal',
    rule: {
      all: [{ source: 'businessRating', min: 4.5, minReviews: 5 }],
      sortBy: 'rating',
    },
    order: 150,
    feed: 'both',
  },
  {
    key: 'cercaDeTi',
    title: 'Cerca de ti',
    subtitle: 'A la vuelta de la esquina',
    displayVariant: 'compact',
    rule: { all: [{ source: 'nearby' }], sortBy: 'distance' },
    order: 160,
    feed: 'both',
  },
  {
    key: 'combosQueValenLaPena',
    title: 'Combos que valen la pena',
    displayVariant: 'horizontal',
    rule: {
      all: [{ source: 'tags', any: ['combo', 'para_compartir'] }, { source: 'discount', minPercent: 1 }],
      sortBy: 'discount',
    },
    order: 170,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'porMenosDe10000',
    title: 'Por menos de $10.000',
    displayVariant: 'grid',
    rule: { all: [{ source: 'price', max: 10000 }], sortBy: 'price_asc' },
    order: 180,
    rotation: 'daily',
    feed: 'both',
    // grid 3×4: exactamente las doce que caben; el default de 10 la deja coja.
    targetSize: 12,
  },
  {
    key: 'dateUnGusto',
    title: 'Date un gusto',
    displayVariant: 'banner',
    rule: { all: [{ source: 'price', min: 35000 }], sortBy: 'price_desc' },
    order: 190,
    rotation: 'daily',
    feed: 'both',
  },
  {
    key: 'refrescaElDia',
    title: 'Refresca el día',
    // Faltaba en el mapa de subtítulos de la app y caía al encabezado por
    // defecto. Ahora el subtítulo viaja con la colección.
    subtitle: 'Para cuando el calor no afloja',
    displayVariant: 'compact',
    rule: {
      all: [{ source: 'tags', any: ['helado', 'granizado', 'jugo', 'limonada', 'malteada'] }],
      sortBy: 'relevance',
    },
    order: 200,
    dayparts: ['tarde'],
    feed: 'both',
  },
];

/**
 * Colecciones que no existían y que el feed nuevo necesita.
 *
 * Van con `order` por encima de 200 para caer después de las heredadas; el
 * orden fino lo decide luego el panel, que es justo lo que este trabajo
 * viene a habilitar.
 */
export const NEW_SEEDS: Seed[] = [
  {
    key: 'nuevosEnZipp',
    title: 'Nuevos en Zipp',
    subtitle: 'Acaban de abrir sus puertas',
    // Variante de producto y no `business_row`: la regla `new/of:business`
    // devuelve los **platos** de los negocios recién llegados, que es lo que
    // de verdad invita a probarlos. Una tarjeta de negocio vacía de comida
    // no le dice nada a nadie.
    displayVariant: 'large',
    rule: { all: [{ source: 'new', withinDays: 30, of: 'business' }], sortBy: 'newest' },
    order: 210,
    feed: 'explore',
  },
  {
    key: 'descubreAlgoNuevo',
    title: 'Descubre algo nuevo',
    subtitle: 'De un negocio al que no le has pedido todavía',
    displayVariant: 'featured',
    rule: {
      all: [{ source: 'personal', kind: 'neverTried' }, { source: 'businessRating', min: 4 }],
      sortBy: 'rating',
    },
    order: 220,
    rotation: 'daily',
    feed: 'explore',
  },
  {
    key: 'nuncaHasProbado',
    title: 'Nunca has probado esto',
    subtitle: 'Fuera de lo que sueles pedir',
    displayVariant: 'compact',
    rule: { all: [{ source: 'personal', kind: 'neverTried' }], sortBy: 'relevance' },
    order: 230,
    rotation: 'daily',
    feed: 'explore',
  },
  {
    key: 'vuelveAPedir',
    title: 'Vuelve a pedir',
    subtitle: 'De los negocios a los que ya les pediste',
    displayVariant: 'horizontal',
    rule: { all: [{ source: 'personal', kind: 'reorder' }], sortBy: 'relevance' },
    order: 240,
    feed: 'explore',
  },
  {
    key: 'deTusFavoritos',
    title: 'De tus favoritos',
    subtitle: 'Novedades donde le diste al corazón',
    displayVariant: 'compact',
    rule: { all: [{ source: 'personal', kind: 'fromFavorites' }], sortBy: 'newest' },
    order: 250,
    feed: 'explore',
  },
  {
    key: 'deLaDrogueria',
    title: 'De la droguería',
    subtitle: 'Lo que se necesita sin salir de casa',
    displayVariant: 'compact',
    rule: {
      all: [{ source: 'businessCategory', any: [BusinessCategory.PHARMACY] }],
      sortBy: 'relevance',
    },
    order: 260,
    feed: 'explore',
  },
];

/** Todas, en el orden en que se declaran. */
export const ALL_SEEDS: Seed[] = [...SEEDS, ...NEW_SEEDS];

/**
 * El documento completo de una semilla, con los valores por defecto que
 * comparten todas. Lo usan la siembra y las pruebas.
 */
export function seedToDocument(seed: Seed) {
  return {
    ...seed,
    dayparts: seed.dayparts ?? [],
    weekdays: [] as number[],
    rotation: seed.rotation ?? ('none' as const),
    minSize: seed.minSize ?? 4,
    targetSize: seed.targetSize ?? 10,
    // Mientras el relleno de etiquetas no haya corrido en producción, las
    // reglas por `tags` tienen que poder caer a las palabras clave o media
    // pantalla sale vacía el día del despliegue.
    fallbackKeywords: true,
    isActive: true,
  };
}
