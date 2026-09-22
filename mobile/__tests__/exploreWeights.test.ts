import { alternateWeights } from '../lib/exploreWeights';
import type { ExploreEntry, HomeSectionDisplayVariant } from '../services/endpoints';

/**
 * Regla dura de `docs/EXPLORAR.md` §5: nunca dos carruseles del mismo peso
 * visual seguidos. El motor de descubrimiento del backend no la aplica —
 * ordena por franja, rotación y presupuesto de exposición, sin saber qué
 * tarjeta va a dibujar el cliente — así que esto es lo que la hace cumplir
 * del lado móvil, con el mínimo reordenamiento posible.
 */

function collection(key: string, displayVariant: HomeSectionDisplayVariant): ExploreEntry {
  return {
    kind: 'collection',
    order: 0,
    key,
    emoji: '',
    title: key,
    displayVariant,
    products: [],
  };
}

function promo(order: number): ExploreEntry {
  return { kind: 'promo', order, banners: [] };
}

describe('alternateWeights', () => {
  it('deja intacta una lista que ya alterna', () => {
    const entries = [
      collection('a', 'large'),
      collection('b', 'compact'),
      collection('c', 'featured'),
      collection('d', 'horizontal'),
    ];
    expect(alternateWeights(entries).map((e) => (e as any).key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('intercambia cuando dos "protagonista" quedan seguidos', () => {
    const entries = [
      collection('a', 'large'),
      collection('b', 'featured'), // choca con 'a': mismo peso
      collection('c', 'compact'),
    ];
    const result = alternateWeights(entries).map((e) => (e as any).key);
    // 'b' se intercambia con 'c', el único candidato de peso distinto por delante.
    expect(result).toEqual(['a', 'c', 'b']);
  });

  it('intercambia cuando dos "secundario" quedan seguidos', () => {
    const entries = [
      collection('a', 'compact'),
      collection('b', 'price_focus'), // ambos "secundario"
      collection('c', 'large'),
    ];
    const result = alternateWeights(entries).map((e) => (e as any).key);
    expect(result).toEqual(['a', 'c', 'b']);
  });

  it('deja el par tal cual si no hay con qué intercambiar', () => {
    const entries = [
      collection('a', 'compact'),
      collection('b', 'horizontal'), // los dos "secundario", y no hay nada más
    ];
    expect(alternateWeights(entries).map((e) => (e as any).key)).toEqual(['a', 'b']);
  });

  it('un "promo" rompe la racha y nunca se mueve', () => {
    const entries = [
      collection('a', 'large'),
      promo(1),
      collection('b', 'featured'),
    ];
    const result = alternateWeights(entries);
    expect(result[1].kind).toBe('promo');
    expect((result[0] as any).key).toBe('a');
    expect((result[2] as any).key).toBe('b');
  });

  it('no pierde ni duplica entradas', () => {
    const entries = [
      collection('a', 'large'),
      collection('b', 'featured'),
      collection('c', 'banner'),
      collection('d', 'compact'),
      collection('e', 'horizontal'),
      promo(1),
    ];
    const result = alternateWeights(entries);
    expect(result).toHaveLength(entries.length);
    expect(new Set(result.map((e) => (e.kind === 'collection' ? e.key : 'promo')))).toEqual(
      new Set(['a', 'b', 'c', 'd', 'e', 'promo'])
    );
  });
});
