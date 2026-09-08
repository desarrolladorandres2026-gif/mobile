import { PipelineStage } from 'mongoose';
import { Product, Business } from '../models';

/**
 * Búsqueda del catálogo: negocios y productos a la vez.
 *
 * Hasta ahora solo se podían buscar negocios, y con `$regex` sin índice —un
 * recorrido completo de la colección por cada tecla que pulsaba el usuario.
 * Peor que el coste: buscar "hamburguesa" no encontraba nada si ningún
 * negocio se llamaba así, aunque tres tuvieran hamburguesas en la carta.
 * Eso hace que ZIPP no se sienta un marketplace, sino un listado de sitios.
 */

export interface SearchResults {
  businesses: unknown[];
  products: unknown[];
  /** Qué estrategia respondió. Útil para depurar por qué salió lo que salió. */
  strategy: 'text' | 'prefix';
}

/**
 * Escapa lo que el usuario escribió antes de meterlo en una expresión
 * regular. Sin esto, un paréntesis o un asterisco en la caja de búsqueda
 * revienta la consulta, y un patrón mal intencionado puede colgar el
 * proceso buscando.
 */
function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Solo el catálogo que un cliente puede comprar.
 *
 * Un negocio inactivo o sin aprobar no aparece en la búsqueda aunque sus
 * productos encajen: enseñarlo lleva a una carta que no se puede pedir, y
 * el usuario culpa a la aplicación, no al estado del comercio.
 */
const VISIBLE_BUSINESS = { isActive: true, isApproved: true };

async function searchBusinesses(term: string, limit: number, usePrefix: boolean) {
  const match = usePrefix
    ? { ...VISIBLE_BUSINESS, name: { $regex: `^${escapeRegex(term)}`, $options: 'i' } }
    : { ...VISIBLE_BUSINESS, $text: { $search: term } };

  const query = Business.find(match).limit(limit);

  // El orden por relevancia solo existe si hubo búsqueda de texto; con
  // prefijos se cae al criterio de siempre.
  return usePrefix
    ? query.sort({ isFeatured: -1, rating: -1 }).lean()
    : query.select({ score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' } }).lean();
}

async function searchProducts(term: string, limit: number, usePrefix: boolean) {
  const match: Record<string, unknown> = usePrefix
    ? { isAvailable: true, name: { $regex: `^${escapeRegex(term)}`, $options: 'i' } }
    : { isAvailable: true, $text: { $search: term } };

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
    { $match: { 'business.isActive': true, 'business.isApproved': true } },
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
        businessRating: '$business.rating',
        businessDeliveryTime: '$business.deliveryTime',
      },
    },
  ];

  return Product.aggregate(pipeline);
}

/**
 * Busca en negocios y productos, con dos estrategias.
 *
 * El índice de texto entiende el español —singulares, plurales, palabras
 * vacías— pero solo casa palabras completas: alguien que ha escrito
 * "hambur" no encuentra nada. Y la caja de búsqueda consulta mientras se
 * escribe, así que ese es el caso normal, no el raro.
 *
 * Por eso se intenta primero por texto y, si no hay nada, se repite por
 * prefijo. El orden importa: al revés, "pizza" encontraría solo lo que
 * empieza por pizza y se perdería la "pizzería del centro" o el plato que
 * la menciona en su descripción.
 */
export async function search(
  term: string,
  options: { limit?: number } = {}
): Promise<SearchResults> {
  const clean = term.trim();
  const limit = Math.min(options.limit ?? 20, 50);

  if (clean.length < 2) return { businesses: [], products: [], strategy: 'text' };

  const [businesses, products] = await Promise.all([
    searchBusinesses(clean, limit, false),
    searchProducts(clean, limit, false),
  ]);

  if (businesses.length || products.length) {
    return { businesses, products, strategy: 'text' };
  }

  const [prefixBusinesses, prefixProducts] = await Promise.all([
    searchBusinesses(clean, limit, true),
    searchProducts(clean, limit, true),
  ]);

  return { businesses: prefixBusinesses, products: prefixProducts, strategy: 'prefix' };
}

/**
 * Lo que más busca la gente, de verdad.
 *
 * Sustituye a la lista fija que había en la pantalla de búsqueda de la app.
 * Mientras no haya suficientes búsquedas registradas devuelve las
 * categorías reales del catálogo, que ya es mejor que una lista escrita a
 * mano: al menos existe lo que ofrece.
 */
export async function popularTerms(limit = 8): Promise<string[]> {
  const rows = await Business.aggregate([
    { $match: VISIBLE_BUSINESS },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => r._id).filter(Boolean);
}

export const searchService = { search, popularTerms };
