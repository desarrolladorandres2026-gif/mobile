import { Business, Product } from '../models';
import { editDistance, tokenize } from '../utils/text';

/**
 * El vocabulario real del catálogo, para corregir lo que la gente escribe.
 *
 * "hamburgesa" no encuentra nada, y una pantalla vacía en un catálogo de
 * pueblo es una venta perdida: casi siempre el plato existe y lo único que
 * falló fue una letra.
 *
 * Se corrige contra las palabras que de verdad están en el catálogo y no
 * contra un diccionario de español. Es la diferencia entre sugerir algo que
 * se puede pedir y sugerir una palabra correcta que nadie vende.
 */

/** Cada cuánto se relee. El catálogo de un pueblo no cambia por minuto. */
const REFRESH_MS = 10 * 60 * 1000;

interface Entry {
  word: string;
  /** En cuántos nombres aparece. Desempata a favor de lo más común. */
  weight: number;
}

let entries: Entry[] = [];
let lookup = new Set<string>();
let loadedAt = 0;
/** La carga en curso, para que diez peticiones a la vez hagan una consulta. */
let inFlight: Promise<void> | null = null;

async function load(): Promise<void> {
  // Por agregación y no por `find`: `searchName` es `select: false`, y la
  // agregación ignora esa regla del esquema sin tener que pedir el resto
  // del documento solo para leer un campo.
  const [businesses, products] = await Promise.all([
    Business.aggregate<{ searchName?: string }>([
      { $match: { isActive: true, isApproved: true } },
      { $project: { _id: 0, searchName: 1 } },
    ]),
    Product.aggregate<{ searchName?: string }>([
      { $match: { isAvailable: true } },
      { $project: { _id: 0, searchName: 1 } },
    ]),
  ]);

  const counts = new Map<string, number>();
  for (const row of [...businesses, ...products]) {
    for (const word of tokenize(row.searchName ?? '')) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  // Ordenado por frecuencia: así, entre dos candidatas a la misma
  // distancia, gana la que más se repite en el catálogo. La primera que
  // encuentra el recorrido ya es la mejor, sin tener que compararlas.
  entries = [...counts.entries()]
    .map(([word, weight]) => ({ word, weight }))
    .sort((a, b) => b.weight - a.weight);

  lookup = new Set(counts.keys());
  loadedAt = Date.now();
}

async function ensureLoaded(): Promise<void> {
  if (loadedAt && Date.now() - loadedAt < REFRESH_MS) return;
  if (!inFlight) {
    inFlight = load().finally(() => {
      inFlight = null;
    });
  }
  await inFlight;
}

/**
 * Cuántas letras se le perdonan a una palabra según lo larga que sea.
 *
 * Las cortas no se tocan. Con una sola edición de margen, "pan" se
 * "corregiría" a "paz", "van" o "pal", y ninguna de las tres es lo que
 * pidió nadie. En cambio "hamburgesa" tiene sitio de sobra para equivocarse
 * sin que quepa ninguna otra palabra del catálogo.
 */
function tolerance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 6) return 1;
  return 2;
}

/** La palabra del catálogo más parecida, si alguna cae dentro del margen. */
function nearest(word: string): string | null {
  const max = tolerance(word);
  if (max === 0) return null;

  let best: string | null = null;
  let bestDistance = max + 1;

  for (const entry of entries) {
    const distance = editDistance(word, entry.word, max);
    if (distance < bestDistance) {
      best = entry.word;
      bestDistance = distance;
      // Una edición es lo más cerca que se puede estar sin ser la misma
      // palabra, y las entradas vienen ordenadas por frecuencia: no hay
      // nada mejor más adelante.
      if (distance === 1) break;
    }
  }

  return best;
}

/**
 * El término corregido, o `null` si no hacía falta tocarlo.
 *
 * Devolver `null` cuando no hay cambio es lo que permite a la pantalla
 * distinguir "no encontré nada" de "no encontré eso, pero sí esto otro".
 */
export async function correct(term: string): Promise<string | null> {
  await ensureLoaded();
  if (!entries.length) return null;

  const words = tokenize(term);
  if (!words.length) return null;

  let changed = false;
  const fixed = words.map((word) => {
    if (lookup.has(word)) return word;
    const candidate = nearest(word);
    if (!candidate) return word;
    changed = true;
    return candidate;
  });

  return changed ? fixed.join(' ') : null;
}

/** Términos del catálogo que empiezan por lo escrito, para el autocompletado. */
export async function completions(prefix: string, limit: number): Promise<string[]> {
  await ensureLoaded();
  if (!prefix) return [];

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.word.startsWith(prefix) && entry.word !== prefix) {
      found.push(entry.word);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/** Fuerza una relectura. Lo usan las pruebas, que siembran y consultan al vuelo. */
export function invalidate(): void {
  loadedAt = 0;
}

export const searchDictionaryService = { correct, completions, invalidate };
