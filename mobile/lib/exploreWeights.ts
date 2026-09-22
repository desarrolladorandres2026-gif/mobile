import type { ExploreEntry, HomeSectionDisplayVariant } from '../services/endpoints';

/**
 * Peso visual de una entrada del feed de Explorar (`docs/EXPLORAR.md` §5).
 *
 * Tres pesos ahí definidos: "protagonista" (foto que ocupa toda la tarjeta,
 * 200-240 pt), "secundario" (foto + nombre + precio, 130-160 pt) e "índice"
 * (grid/chips — no aplica a las entradas del feed, solo a los antojos de
 * arriba). La regla dura del documento es que nunca dos carruseles del
 * mismo peso queden seguidos.
 *
 * El servidor no decide el orden pensando en esto — `discovery.service.ts`
 * ordena por `order`, franja y rotación, sin conocer el peso visual de la
 * tarjeta que el cliente va a dibujar. Corregirlo ahí acoplaría el motor de
 * descubrimiento a una decisión puramente de maquetación; corregirlo aquí,
 * en el cliente, es lo mínimo necesario.
 */
type Weight = 'protagonista' | 'secundario' | 'ninguno';

/** `banner` es alias visual de `large` (`ProductCollectionRow.tsx`), mismo peso. */
const PROTAGONISTA = new Set<HomeSectionDisplayVariant>(['large', 'featured', 'banner', 'spotlight', 'business_row']);

function weightOf(entry: ExploreEntry): Weight {
  // Un `promo` es una banda completa, no un carrusel: no compite por peso
  // con nada y de hecho rompe cualquier racha, igual que el grid de antojos
  // o el spotlight editorial lo harían si llegaran a pasar por aquí.
  if (entry.kind !== 'collection') return 'ninguno';
  // `grid` sí llega hasta aquí (descuentosLocos, buenoYBarato,
  // porMenosDe10000): ocupa casi una pantalla entera, así que no tiene
  // sentido compararlo por peso contra un carrusel de 130-240 pt — cuenta
  // como 'ninguno' para que nunca alterne mecánicamente con su vecino, pero
  // tampoco fuerce un intercambio que no resuelve nada a esa escala.
  if (entry.displayVariant === 'grid') return 'ninguno';
  return PROTAGONISTA.has(entry.displayVariant) ? 'protagonista' : 'secundario';
}

/**
 * Reordena lo mínimo para que dos carruseles del mismo peso nunca queden
 * seguidos.
 *
 * Es un intercambio local, no una redistribución global: el servidor ya
 * decidió el orden por franja horaria, rotación y presupuesto de exposición,
 * y esto solo corrige la alternancia visual sin tocar esa decisión más de lo
 * necesario. Cuando no encuentra con qué intercambiar (por ejemplo, todo lo
 * que queda por delante pesa igual), deja el par tal cual — preferible a
 * mover contenido más de lo justo para una regla puramente estética.
 */
export function alternateWeights(entries: ExploreEntry[]): ExploreEntry[] {
  const result = [...entries];

  for (let i = 1; i < result.length; i++) {
    const prevWeight = weightOf(result[i - 1]);
    const currWeight = weightOf(result[i]);
    if (prevWeight === 'ninguno' || currWeight === 'ninguno' || prevWeight !== currWeight) continue;

    const swapIndex = result.findIndex((entry, j) => j > i && weightOf(entry) !== currWeight);
    if (swapIndex === -1) continue;

    [result[i], result[swapIndex]] = [result[swapIndex], result[i]];
  }

  return result;
}
