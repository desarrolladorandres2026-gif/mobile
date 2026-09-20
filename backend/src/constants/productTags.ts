import { BusinessCategory } from '../types/enums';

/**
 * El vocabulario de etiquetas del catálogo.
 *
 * Existe porque la semántica de las colecciones del inicio se resolvía con
 * `$regex` **sin ancla** sobre `searchName` contra seis listas de palabras
 * escritas dentro de `homeSections.service.ts`. Eso tenía tres problemas:
 * una regex sin ancla no puede apoyarse en ningún índice, cada colección
 * nueva obligaba a escribir código, y "pan" encontraba "panela".
 *
 * Es un vocabulario **cerrado** a propósito. Un campo de texto libre se
 * llena de sinónimos ("gaseosa", "refresco", "soda") y deja de servir para
 * agrupar, que es justo lo único para lo que existe. Si falta un término,
 * se añade aquí y se vuelve a correr el relleno — no se inventa en la carta
 * de un negocio.
 */

export const PRODUCT_TAGS = [
  // ── Plato principal ──
  'hamburguesa',
  'perro',
  'pizza',
  'pollo',
  'asado',
  'carne',
  'arroz',
  'sopa',
  'bandeja',
  'corrientazo',
  'empanada',
  'salchipapa',
  'sandwich',
  'taco',
  'pasta',
  'mariscos',
  'ensalada',

  // ── Panadería y desayuno ──
  'desayuno',
  'arepa',
  'pan',
  'huevo',
  'tamal',

  // ── Dulce ──
  'postre',
  'helado',
  'torta',
  'brownie',
  'waffle',

  // ── Bebida ──
  'cafe',
  'jugo',
  'gaseosa',
  'limonada',
  'malteada',
  'granizado',
  'cerveza',
  'agua',

  // ── Atributo, no tipo de plato ──
  'picante',
  'vegetariano',
  'saludable',
  'para_compartir',
  'personal',
  'combo',

  // ── Fuera de la carta de comida ──
  'medicamento',
  'aseo',
  'mercado',
  'mascota',
] as const;

export type ProductTag = (typeof PRODUCT_TAGS)[number];

const TAG_SET: ReadonlySet<string> = new Set(PRODUCT_TAGS);

export function isProductTag(value: unknown): value is ProductTag {
  return typeof value === 'string' && TAG_SET.has(value);
}

/**
 * Cuántas etiquetas puede llevar un producto.
 *
 * Cinco no es un límite de almacenamiento: un producto etiquetado con doce
 * cosas no aporta información, la diluye. Si una arepa de huevo es a la vez
 * `arepa`, `huevo`, `desayuno` y `pan`, ya está sobre-descrita.
 */
export const MAX_TAGS_PER_PRODUCT = 5;

/** Cómo se escribe cada etiqueta cuando la lee una persona. */
export const PRODUCT_TAG_LABELS: Record<ProductTag, string> = {
  hamburguesa: 'Hamburguesas',
  perro: 'Perros calientes',
  pizza: 'Pizza',
  pollo: 'Pollo',
  asado: 'Asados',
  carne: 'Carnes',
  arroz: 'Arroces',
  sopa: 'Sopas',
  bandeja: 'Bandejas',
  corrientazo: 'Corrientazos',
  empanada: 'Empanadas',
  salchipapa: 'Salchipapas',
  sandwich: 'Sándwiches',
  taco: 'Tacos',
  pasta: 'Pastas',
  mariscos: 'Mariscos',
  ensalada: 'Ensaladas',
  desayuno: 'Desayunos',
  arepa: 'Arepas',
  pan: 'Panadería',
  huevo: 'Huevos',
  tamal: 'Tamales',
  postre: 'Postres',
  helado: 'Helados',
  torta: 'Tortas',
  brownie: 'Brownies',
  waffle: 'Waffles',
  cafe: 'Café',
  jugo: 'Jugos',
  gaseosa: 'Gaseosas',
  limonada: 'Limonadas',
  malteada: 'Malteadas',
  granizado: 'Granizados',
  cerveza: 'Cervezas',
  agua: 'Agua',
  picante: 'Picante',
  vegetariano: 'Vegetariano',
  saludable: 'Saludable',
  para_compartir: 'Para compartir',
  personal: 'Porción personal',
  combo: 'Combos',
  medicamento: 'Medicamentos',
  aseo: 'Aseo',
  mercado: 'Mercado',
  mascota: 'Mascotas',
};

/**
 * Las familias son solo para agrupar los chips en los paneles: un formulario
 * con cuarenta y cinco casillas en fila no lo llena nadie. No se guardan en
 * la base y no participan en ninguna regla.
 */
export const PRODUCT_TAG_FAMILIES: { label: string; tags: ProductTag[] }[] = [
  {
    label: 'Plato',
    tags: [
      'hamburguesa', 'perro', 'pizza', 'pollo', 'asado', 'carne', 'arroz', 'sopa',
      'bandeja', 'corrientazo', 'empanada', 'salchipapa', 'sandwich', 'taco',
      'pasta', 'mariscos', 'ensalada',
    ],
  },
  { label: 'Desayuno y panadería', tags: ['desayuno', 'arepa', 'pan', 'huevo', 'tamal'] },
  { label: 'Dulce', tags: ['postre', 'helado', 'torta', 'brownie', 'waffle'] },
  {
    label: 'Bebida',
    tags: ['cafe', 'jugo', 'gaseosa', 'limonada', 'malteada', 'granizado', 'cerveza', 'agua'],
  },
  {
    label: 'Cómo es',
    tags: ['picante', 'vegetariano', 'saludable', 'para_compartir', 'personal', 'combo'],
  },
  { label: 'Fuera de la carta', tags: ['medicamento', 'aseo', 'mercado', 'mascota'] },
];

/**
 * Palabras que delatan cada etiqueta, ya normalizadas (sin tildes, en
 * minúscula) igual que `searchName`.
 *
 * Es la ampliación de los seis diccionarios que vivían en
 * `homeSections.service.ts` (`ANTOJO_KEYWORDS`, `COMPARTIR_KEYWORDS`,
 * `DULCE_KEYWORDS`, `DESAYUNO_KEYWORDS`, `BEBIDA_KEYWORDS`,
 * `FRIO_KEYWORDS`). Aquí solo se usa **una vez**, en el relleno inicial:
 * después de eso manda el campo `tags`, que un comercio puede corregir.
 *
 * Una palabra puede aparecer en dos etiquetas a la vez ("malteada" es a la
 * vez bebida y dulce); el orden de `PRODUCT_TAGS` desempata cuando sobran.
 */
export const TAG_KEYWORDS: Record<ProductTag, string[]> = {
  hamburguesa: ['hamburguesa', 'burger', 'burguer'],
  perro: ['perro', 'perro caliente', 'hot dog', 'hotdog', 'choripan'],
  pizza: ['pizza', 'calzone'],
  pollo: ['pollo', 'broaster', 'alitas', 'alas', 'pechuga', 'apanado'],
  asado: ['asado', 'parrilla', 'churrasco', 'chuzo', 'pincho', 'costilla'],
  carne: ['carne', 'res', 'cerdo', 'lomo', 'punta de anca', 'chicharron'],
  arroz: ['arroz', 'paella', 'chaufa'],
  sopa: ['sopa', 'sancocho', 'caldo', 'mote', 'ajiaco', 'crema'],
  bandeja: ['bandeja', 'bandeja paisa'],
  corrientazo: ['corrientazo', 'almuerzo', 'menu del dia', 'ejecutivo'],
  empanada: ['empanada', 'pastel de yuca', 'pastel'],
  salchipapa: ['salchipapa', 'papas', 'papa a la francesa', 'french'],
  sandwich: ['sandwich', 'sanduche', 'submarino', 'baguette'],
  taco: ['taco', 'burrito', 'quesadilla', 'nachos'],
  pasta: ['pasta', 'espagueti', 'spaghetti', 'lasagna', 'lasana', 'ravioli'],
  mariscos: ['mariscos', 'camaron', 'pescado', 'tilapia', 'mojarra', 'ceviche'],
  ensalada: ['ensalada', 'bowl'],

  desayuno: ['desayuno', 'calentado', 'changua', 'caldo de costilla'],
  arepa: ['arepa'],
  // "pan" es la palabra más peligrosa del diccionario: sin frontera de
  // palabra encuentra "panela", "pantalla" y "panal". El buscador de
  // `deriveTags` ancla siempre, pero conviene recordarlo al añadir términos.
  pan: ['pan', 'pandebono', 'almojabana', 'croissant', 'roscon', 'buñuelo', 'panaderia'],
  huevo: ['huevo', 'omelette', 'revuelto'],
  tamal: ['tamal', 'envuelto', 'hallaca'],

  postre: ['postre', 'flan', 'gelatina', 'mousse', 'cheesecake', 'tres leches'],
  helado: ['helado', 'paleta', 'sundae', 'cono'],
  torta: ['torta', 'pastel de chocolate', 'ponque', 'cupcake'],
  brownie: ['brownie'],
  waffle: ['waffle', 'wafle', 'crepe', 'panqueque', 'pancake'],

  cafe: ['cafe', 'capuchino', 'cappuccino', 'latte', 'americano', 'expreso', 'espresso', 'tinto'],
  jugo: ['jugo', 'zumo', 'smoothie'],
  gaseosa: ['gaseosa', 'soda', 'coca cola', 'postobon', 'pepsi', 'refresco'],
  limonada: ['limonada', 'limonada de coco'],
  malteada: ['malteada', 'milkshake', 'batido'],
  granizado: ['granizado', 'frappe', 'frape', 'raspado', 'cholado'],
  cerveza: ['cerveza', 'michelada', 'poker', 'aguila', 'club colombia'],
  agua: ['agua', 'botellon'],

  picante: ['picante', 'diabla', 'buffalo', 'jalapeño', 'jalapeno', 'chili'],
  vegetariano: ['vegetariano', 'vegano', 'veggie', 'sin carne'],
  saludable: ['saludable', 'light', 'fit', 'integral', 'proteico'],
  para_compartir: ['para compartir', 'familiar', 'picada', 'x2', 'x3', 'x4', 'grande', 'jumbo'],
  personal: ['personal', 'individual', 'mini', 'pequeño', 'pequeno'],
  combo: ['combo', 'promocion', 'duo', 'trio', 'pack'],

  medicamento: ['acetaminofen', 'ibuprofeno', 'pastilla', 'jarabe', 'tableta', 'capsula', 'gotas'],
  aseo: ['jabon', 'shampoo', 'champu', 'detergente', 'papel higienico', 'crema dental', 'cepillo'],
  mercado: ['arroz libra', 'aceite', 'azucar', 'sal', 'harina', 'leche', 'huevos x', 'panela'],
  mascota: ['perrarina', 'gatarina', 'concentrado', 'mascota'],
};

/**
 * Lo que la categoría del negocio implica por sí sola.
 *
 * Es la red de seguridad del relleno: un producto llamado "Caja x12" en una
 * droguería no dice nada por su nombre, pero la droguería sí. Solo se aplica
 * cuando el nombre no produjo ninguna etiqueta.
 */
export const CATEGORY_FALLBACK_TAGS: Record<string, ProductTag[]> = {
  [BusinessCategory.PHARMACY]: ['medicamento'],
  [BusinessCategory.SUPERMARKET]: ['mercado'],
  [BusinessCategory.CAFE]: ['cafe'],
};

/**
 * Cada palabra del diccionario, ya compilada y ordenada de más larga a más
 * corta.
 *
 * El orden importa: "perro caliente" tiene que poder ganarle a "perro", y
 * "pastel de yuca" a "pastel". Una coincidencia más larga es siempre una
 * coincidencia más específica.
 */
const COMPILED: { tag: ProductTag; pattern: RegExp; length: number }[] = Object.entries(TAG_KEYWORDS)
  .flatMap(([tag, words]) =>
    words.map((word) => ({
      tag: tag as ProductTag,
      // Frontera de palabra a ambos lados, con plural opcional. `searchName`
      // ya viene sin tildes y en minúscula, así que el patrón compara igual.
      pattern: new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?($|\\s)`),
      length: word.length,
    }))
  )
  .sort((a, b) => b.length - a.length);

/** Posición de cada etiqueta en `PRODUCT_TAGS`, para desempatar sin recorrer. */
const TAG_ORDER = new Map<string, number>(PRODUCT_TAGS.map((tag, index) => [tag, index]));

/**
 * Deduce las etiquetas de un producto a partir de su texto ya normalizado.
 *
 * Devuelve como mucho `MAX_TAGS_PER_PRODUCT`, priorizando la coincidencia
 * más específica y, a igualdad, el orden del vocabulario —que va de plato
 * principal a atributo, así que una hamburguesa familiar se queda con
 * `hamburguesa` antes que con `para_compartir` si hay que recortar.
 *
 * Es una función pura: la usa el relleno inicial y puede usarla también un
 * panel para proponer etiquetas mientras alguien escribe el nombre.
 */
export function deriveTags(normalizedText: string, businessCategory?: string): ProductTag[] {
  const haystack = ` ${normalizedText.trim()} `;
  const found = new Set<ProductTag>();

  for (const { tag, pattern } of COMPILED) {
    if (found.size >= MAX_TAGS_PER_PRODUCT * 2) break;
    if (pattern.test(haystack)) found.add(tag);
  }

  if (found.size === 0 && businessCategory) {
    for (const tag of CATEGORY_FALLBACK_TAGS[businessCategory] ?? []) found.add(tag);
  }

  return Array.from(found)
    .sort((a, b) => (TAG_ORDER.get(a) ?? 999) - (TAG_ORDER.get(b) ?? 999))
    .slice(0, MAX_TAGS_PER_PRODUCT);
}
