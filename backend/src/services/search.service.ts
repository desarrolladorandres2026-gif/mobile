import { PipelineStage, Types } from 'mongoose';
import { Product, Business, SearchLog, HomeCategory } from '../models';
import { BUSINESS_CATEGORY_LABELS } from '../types/enums';
import { normalize, escapeRegex } from '../utils/text';
import { LatLng } from '../utils/geo';
import {
  VISIBLE_BUSINESS,
  PUBLIC_LIST_PROJECTION,
  withDistance,
  withinRadius,
} from '../utils/catalogQuery';
import { withProductImages } from '../utils/productImageUrls';
import { searchDictionaryService } from './searchDictionary.service';
import { searchRuleService, type RuleView } from './searchRule.service';

/**
 * Búsqueda del catálogo: negocios y productos a la vez.
 *
 * Hasta ahora solo se podían buscar negocios, y con `$regex` sin índice —un
 * recorrido completo de la colección por cada tecla que pulsaba el usuario.
 * Peor que el coste: buscar "hamburguesa" no encontraba nada si ningún
 * negocio se llamaba así, aunque tres tuvieran hamburguesas en la carta.
 * Eso hace que ZIPP no se sienta un marketplace, sino un listado de sitios.
 */

export type SortKey = 'relevance' | 'distance' | 'rating' | 'deliveryTime';

export interface SearchOptions {
  limit?: number;
  page?: number;
  lat?: number;
  lng?: number;
  maxDistance?: number;
  sort?: SortKey;
  /** Ignora las reglas del panel. Lo usa la propia validación de una regla. */
  skipRules?: boolean;
}

export interface SearchResults {
  businesses: unknown[];
  products: unknown[];
  /** Qué estrategia respondió. Útil para depurar por qué salió lo que salió. */
  strategy: 'text' | 'prefix' | 'corrected' | 'synonym';
  /**
   * El término que se buscó en realidad, cuando hubo que corregirlo.
   *
   * Viaja para que la pantalla pueda decirlo. Corregir en silencio deja sin
   * salida a quien sabía perfectamente lo que estaba escribiendo.
   */
  suggestedTerm?: string;
  /**
   * A dónde ofrecer ir cuando no hubo nada. Solo viaja con resultados
   * vacíos y una regla `redirect` del panel para este término.
   */
  redirect?: NonNullable<RuleView['redirect']>;
  hasMore: boolean;
}

export interface Suggestion {
  type: 'term' | 'business' | 'product';
  id?: string;
  label: string;
  sublabel?: string;
  image?: string | null;
}

/**
 * Cuántos negocios se traen antes de ordenar y recortar la página.
 *
 * La distancia se calcula fuera de la base —`$text` y `$geoNear` no pueden
 * convivir en el mismo pipeline, los dos exigen ser la primera etapa— así
 * que ordenar por cercanía obliga a tener delante todos los candidatos. Con
 * el catálogo de un pueblo, trescientos los cubre de sobra, y el tope evita
 * que una búsqueda de una sola letra se traiga la base entera.
 */
const CANDIDATE_CAP = 300;

function readCoords(options: SearchOptions): LatLng | null {
  const { lat, lng } = options;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function searchBusinesses(
  term: string,
  usePrefix: boolean,
  coords: LatLng | null,
  maxDistance: number
) {
  const geo = withinRadius(coords, maxDistance);

  const match = usePrefix
    ? { ...VISIBLE_BUSINESS, ...geo, searchName: { $regex: `^${escapeRegex(normalize(term))}` } }
    : { ...VISIBLE_BUSINESS, ...geo, $text: { $search: term } };

  const query = Business.find(match).limit(CANDIDATE_CAP);

  // A2: misma lista blanca que el resto del catálogo público — sin esto,
  // `$text` y el prefijo devolvían el documento crudo, con
  // `commissionRate(Bps)` y `ownerId` incluidos.
  // El orden por relevancia solo existe si hubo búsqueda de texto; con
  // prefijos se cae al criterio de siempre. El `_id` al final de cada orden
  // desempata: sin él, dos negocios con el mismo rating (o el mismo
  // puntaje de texto) pueden salir en orden distinto entre una página y la
  // siguiente —cada una es una consulta aparte—, y eso repite uno y se come
  // otro al deslizar.
  return usePrefix
    ? query.select(PUBLIC_LIST_PROJECTION).sort({ isFeatured: -1, rating: -1, _id: 1 }).lean()
    : query
        .select({ ...PUBLIC_LIST_PROJECTION, score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' }, _id: 1 })
        .lean();
}

async function searchProducts(
  term: string,
  limit: number,
  usePrefix: boolean,
  coords: LatLng | null,
  maxDistance: number
) {
  const match: Record<string, unknown> = usePrefix
    ? { isAvailable: true, searchName: { $regex: `^${escapeRegex(normalize(term))}` } }
    : { isAvailable: true, $text: { $search: term } };

  const businessMatch: Record<string, unknown> = Object.fromEntries(
    Object.entries(VISIBLE_BUSINESS).map(([key, value]) => [`business.${key}`, value])
  );

  // Aquí el radio va después del cruce, porque la ubicación es del negocio
  // y no del producto. Así no usa índice, pero a estas alturas del pipeline
  // ya quedan como mucho unas decenas de filas.
  if (coords) {
    businessMatch['business.location'] = withinRadius(coords, maxDistance).location;
  }

  const pipeline: PipelineStage[] = [
    { $match: match },
    ...(usePrefix
      ? []
      : [{ $addFields: { score: { $meta: 'textScore' } } } as PipelineStage,
         { $sort: { score: -1 } } as PipelineStage]),
    // Se recorta antes del cruce con negocios: unir primero y filtrar
    // después obligaría a resolver el negocio de cada producto que encaje,
    // y en una búsqueda genérica eso es media carta del pueblo.
    { $limit: limit * 3 },
    {
      $lookup: {
        from: 'businesses',
        localField: 'businessId',
        foreignField: '_id',
        as: 'business',
      },
    },
    { $unwind: '$business' },
    { $match: businessMatch },
    { $limit: limit },
    {
      $project: {
        name: 1,
        description: 1,
        price: 1,
        discountPrice: 1,
        image: 1,
        imageAsset: 1,
        isAvailable: 1,
        businessId: '$business._id',
        businessName: '$business.name',
        businessCategory: '$business.category',
        businessRating: '$business.rating',
        businessDeliveryTime: '$business.deliveryTime',
        businessLocation: '$business.location',
      },
    },
  ];

  return (await Product.aggregate(pipeline)).map(withProductImages);
}

/**
 * Cómo se ordenan los negocios encontrados.
 *
 * `relevance` devuelve `null` a propósito: en ese caso manda el orden que ya
 * trajo Mongo —puntuación de texto, o destacados y calificación en la rama
 * de prefijo— y volver a ordenar aquí solo lo estropearía.
 */
function comparator(sort: SortKey): ((a: any, b: any) => number) | null {
  switch (sort) {
    case 'distance':
      return (a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
    case 'rating':
      return (a, b) => (b.rating ?? 0) - (a.rating ?? 0);
    case 'deliveryTime':
      return (a, b) => (a.deliveryTime ?? Infinity) - (b.deliveryTime ?? Infinity);
    default:
      return null;
  }
}

/**
 * Busca en negocios y productos, con tres estrategias en cascada.
 *
 * El índice de texto entiende el español —singulares, plurales, palabras
 * vacías— pero solo casa palabras completas: alguien que ha escrito
 * "hambur" no encuentra nada. Y la caja de búsqueda consulta mientras se
 * escribe, así que ese es el caso normal, no el raro.
 *
 * Por eso se intenta primero por texto, luego por prefijo y, solo si las dos
 * vienen vacías, se corrige el término y se repite. El orden importa en los
 * dos saltos: corregir antes de haber probado el término literal haría que
 * un plato con nombre raro nunca se encontrara por su nombre real, y empezar
 * por prefijo perdería la "pizzería del centro" al buscar "pizza".
 */
export async function search(
  term: string,
  options: SearchOptions = {}
): Promise<SearchResults> {
  const clean = term.trim();
  const limit = Math.min(options.limit ?? 20, 50);
  const page = Math.max(options.page ?? 1, 1);
  const sort = options.sort ?? 'relevance';
  const coords = readCoords(options);
  const maxDistance = options.maxDistance ?? 10_000;

  if (clean.length < 2) {
    return { businesses: [], products: [], strategy: 'text', hasMore: false };
  }

  const run = async (searchTerm: string, usePrefix: boolean) => {
    const [businesses, products] = await Promise.all([
      searchBusinesses(searchTerm, usePrefix, coords, maxDistance),
      // Los productos solo viajan en la primera página: son la sección de
      // cabecera de los resultados, no la lista que se sigue deslizando.
      page === 1
        ? searchProducts(searchTerm, limit, usePrefix, coords, maxDistance)
        : Promise.resolve([] as any[]),
    ]);
    return { businesses: businesses as any[], products: products as any[] };
  };

  let strategy: SearchResults['strategy'] = 'text';
  let suggestedTerm: string | undefined;
  let found = await run(clean, false);

  if (!found.businesses.length && !found.products.length) {
    strategy = 'prefix';
    found = await run(clean, true);
  }

  const empty = () => !found.businesses.length && !found.products.length;

  // Las reglas del panel solo actúan cuando la búsqueda vendría vacía, y
  // van antes de la corrección: un sinónimo puesto a mano es más fiable
  // que una corrección por parecido de letras.
  const rule = options.skipRules ? null : await searchRuleService.ruleFor(clean);

  if (empty() && rule?.kind === 'synonym' && rule.synonymOf) {
    const rescued = await run(rule.synonymOf, false);
    if (rescued.businesses.length || rescued.products.length) {
      strategy = 'synonym';
      suggestedTerm = rule.synonymOf;
      found = rescued;
    }
  }

  if (empty()) {
    const corrected = await searchDictionaryService.correct(clean);
    if (corrected) {
      const rescued = await run(corrected, false);
      if (rescued.businesses.length || rescued.products.length) {
        strategy = 'corrected';
        suggestedTerm = corrected;
        found = rescued;
      }
    }
  }

  const ranked = withDistance(found.businesses, coords, 'location');
  const order = comparator(sort);
  if (order) ranked.sort(order);

  const start = (page - 1) * limit;

  return {
    businesses: ranked.slice(start, start + limit),
    products: withDistance(found.products, coords, 'businessLocation'),
    strategy,
    ...(suggestedTerm ? { suggestedTerm } : {}),
    ...(empty() && rule?.kind === 'redirect' && rule.redirect ? { redirect: rule.redirect } : {}),
    hasMore: ranked.length > start + limit,
  };
}

/**
 * Sugerencias mientras se escribe.
 *
 * Devuelve etiquetas, no fichas: es una lista que se repinta en cada tecla,
 * y mandar la carta entera de cada negocio para pintar una fila de texto
 * gastaría los datos del móvil sin que se llegue a ver nada de eso.
 */
export async function suggest(term: string, limit = 8): Promise<Suggestion[]> {
  const clean = normalize(term.trim());
  if (clean.length < 2) return [];

  const pattern = { $regex: `^${escapeRegex(clean)}` };

  const [businesses, products, terms] = await Promise.all([
    Business.find({ ...VISIBLE_BUSINESS, searchName: pattern })
      .select('name category logo')
      .limit(3)
      .lean(),
    Product.aggregate([
      { $match: { isAvailable: true, searchName: pattern } },
      { $limit: 9 },
      {
        $lookup: {
          from: 'businesses',
          localField: 'businessId',
          foreignField: '_id',
          as: 'business',
        },
      },
      { $unwind: '$business' },
      { $match: { 'business.isActive': true, 'business.isApproved': true } },
      { $limit: 3 },
      { $project: { name: 1, image: 1, imageAsset: 1, businessId: '$business._id', businessName: '$business.name' } },
    ]),
    searchDictionaryService.completions(clean, 4),
  ]);

  const suggestions: Suggestion[] = [
    ...businesses.map((b: any) => ({
      type: 'business' as const,
      id: String(b._id),
      label: b.name,
      sublabel: b.category,
      image: b.logo ?? null,
    })),
    ...products.map((p: any) => ({
      type: 'product' as const,
      // El destino de un plato es su negocio: el carrito necesita saber a
      // qué local pertenece, y una ficha suelta no lo dice.
      id: String(p.businessId),
      label: p.name,
      sublabel: p.businessName,
      // La miniatura y no la de catálogo: la sugerencia se pinta a 40 pt.
      image: withProductImages(p).images?.thumb ?? p.image ?? null,
    })),
    ...terms.map((word) => ({ type: 'term' as const, label: word })),
  ];

  // Un negocio y un plato pueden llamarse igual, y ver la misma palabra dos
  // veces seguidas parece un fallo aunque lleven iconos distintos.
  const seen = new Set<string>();
  return suggestions
    .filter((item) => {
      const key = `${item.type}:${normalize(item.label)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/**
 * Registra una búsqueda que el usuario confirmó.
 *
 * Nunca lanza: si el registro falla, la búsqueda ya se respondió y no tiene
 * ningún sentido que el usuario vea un error por culpa de una estadística.
 */
export async function logSearch(input: {
  term: string;
  userId?: string | null;
  resultCount: number;
  suggestedTerm?: string | null;
}): Promise<void> {
  const raw = input.term.trim().slice(0, 100);
  if (raw.length < 2) return;

  try {
    await SearchLog.create({
      termRaw: raw,
      term: normalize(raw),
      userId: input.userId ? new Types.ObjectId(input.userId) : null,
      resultCount: Math.max(0, Math.round(input.resultCount)),
      suggestedTerm: input.suggestedTerm ?? null,
    });
  } catch (error) {
    console.error('No se pudo registrar la búsqueda:', error);
  }
}

/** Ventana de la que se leen tendencias e informes. */
const INSIGHT_DAYS = 30;

function since(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface PopularTerm {
  term: string;
  /**
   * Cuánta gente lo buscó en la ventana de informes.
   *
   * Cero significa "esto no sale de búsquedas reales": es el respaldo por
   * categorías del catálogo. La app solo imprime el número cuando es mayor
   * que cero, porque el conteo del respaldo mide cuántos negocios hay en esa
   * categoría y no cuánta gente la buscó — publicarlo sería mentir con un
   * dato que existe.
   */
  count: number;
}

/**
 * Lo que más busca la gente, de verdad.
 *
 * Sale del registro de búsquedas confirmadas. Mientras no haya volumen
 * suficiente se cae a las categorías reales del catálogo, que es lo que
 * había antes y sigue siendo mejor que una lista escrita a mano: al menos
 * existe lo que anuncia.
 *
 * Viaja con el conteo porque la pantalla lo pinta como un ranking, y un
 * ranking sin número es una nube de etiquetas ordenada por nada visible.
 */
export async function popularTerms(limit = 8): Promise<PopularTerm[]> {
  const logged = await SearchLog.aggregate<{ _id: string; count: number; label?: string }>([
    { $match: { createdAt: { $gte: since(INSIGHT_DAYS) }, resultCount: { $gt: 0 } } },
    // Se agrupa por el normalizado —si no, "Café" y "cafe" salen como dos
    // filas distintas en una lista de ocho— pero lo que se devuelve es una
    // escritura real de la gente: `term` va sin tildes ni mayúsculas y esto
    // se pinta a tamaño de lectura, donde "cafe" se nota.
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$term', count: { $sum: 1 }, label: { $first: '$termRaw' } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  if (logged.length >= limit) {
    return logged
      .map((row) => ({ term: row.label || row._id, count: row.count }))
      .filter((row) => !!row.term);
  }

  const rows = await Business.aggregate<{ _id: string; count: number }>([
    { $match: VISIBLE_BUSINESS },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  const keys = rows.map((r) => r._id).filter(Boolean);
  const labels = await categoryLabels(keys);

  return keys.map((key) => ({ term: labels[key] ?? key, count: 0 }));
}

/**
 * Cómo se llama cada categoría para un humano.
 *
 * El respaldo de arriba agrupa por el campo `category` de los negocios, que
 * guarda claves (`fast_food`). Sin este paso la pantalla anunciaba
 * literalmente "fast_food" como lo más buscado — y como el camino de
 * respaldo es el normal mientras no haya volumen, era el caso habitual.
 *
 * Manda el nombre que administración le puso a la categoría en la vitrina;
 * si esa fila no existe, la etiqueta de siempre.
 */
async function categoryLabels(keys: string[]): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  if (keys.length === 0) return labels;

  const rows = await HomeCategory.find({ key: { $in: keys } })
    .select('key name')
    .lean();

  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    const label = row?.name || BUSINESS_CATEGORY_LABELS[key];
    if (label) labels[key] = label;
  }

  return labels;
}

export interface SearchInsights {
  top: { term: string; count: number }[];
  /** Lo que se buscó y no había. La lista de qué falta en el catálogo. */
  empty: { term: string; key: string; count: number; lastAt: Date; rule: RuleView | null }[];
  days: number;
}

/**
 * Qué busca la gente y, sobre todo, qué busca y no encuentra.
 *
 * La segunda tabla es la que vale: cada término sin resultados es alguien
 * que quiso comprar algo que ZIPP no tiene, y esa es exactamente la lista
 * priorizada de qué comercios hay que salir a captar. Nadie más la tiene,
 * porque el cliente que no encuentra nada se va sin decírselo a nadie.
 */
export async function insights(limit = 25): Promise<SearchInsights> {
  const from = since(INSIGHT_DAYS);
  const handled = await searchRuleService.handledTerms();

  const [top, empty] = await Promise.all([
    SearchLog.aggregate([
      { $match: { createdAt: { $gte: from }, resultCount: { $gt: 0 } } },
      { $group: { _id: '$termRaw', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    // Se agrupa por el término normalizado: "Sushi" y "sushi" son la misma
    // demanda, y las reglas se guardan por esa misma clave.
    SearchLog.aggregate([
      { $match: { createdAt: { $gte: from }, resultCount: 0, term: { $nin: handled } } },
      { $group: { _id: '$term', label: { $first: '$termRaw' }, count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
  ]);

  // La regla que ya tiene cada término sin resultado, para que el panel
  // enseñe "ya redirigido a…" y no vuelva a ofrecerlo como pendiente.
  const rules = await Promise.all(empty.map((row) => searchRuleService.ruleFor(row._id)));

  return {
    top: top.map((row) => ({ term: row._id, count: row.count })),
    empty: empty.map((row, i) => ({
      term: row.label as string,
      key: row._id as string,
      count: row.count,
      lastAt: row.lastAt,
      rule: rules[i],
    })),
    days: INSIGHT_DAYS,
  };
}

export const searchService = { search, suggest, logSearch, popularTerms, insights };
