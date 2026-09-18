import {
  pickSuggestions, freeDeliveryGap, MAX_SUGGESTIONS, type SuggestableProduct,
} from '../lib/catalog';

/**
 * Las sugerencias se muestran en dos sitios distintos —la ficha del producto
 * y la bolsa— y tienen que ofrecer lo mismo en los dos. Con la regla escrita
 * en cada pantalla, una acabaría sugiriendo otra hamburguesa junto a la
 * hamburguesa y la otra no.
 */

const p = (
  _id: string,
  categoryId?: string,
  isAvailable = true
): SuggestableProduct => ({ _id, categoryId, isAvailable });

const hamburguesa = p('h1', 'fuertes');
const otraHamburguesa = p('h2', 'fuertes');
const gaseosa = p('b1', 'bebidas');
const postre = p('d1', 'postres');

describe('pickSuggestions', () => {
  it('ofrece primero lo de una sección que el pedido no cubre', () => {
    const out = pickSuggestions([otraHamburguesa, gaseosa, postre], {
      exclude: ['h1'],
      covered: ['fuertes'],
    });

    expect(out.map((x) => x._id)).toEqual(['b1', 'd1', 'h2']);
  });

  it('nunca sugiere lo que ya está en la bolsa ni el plato que se mira', () => {
    const out = pickSuggestions([hamburguesa, otraHamburguesa, gaseosa], {
      exclude: ['h1', 'h2'],
    });

    expect(out.map((x) => x._id)).toEqual(['b1']);
  });

  it('deja fuera lo agotado', () => {
    const out = pickSuggestions([p('x1', 'bebidas', false), gaseosa]);

    expect(out.map((x) => x._id)).toEqual(['b1']);
  });

  it('sin variedad de secciones sugiere igual, en vez de no sugerir nada', () => {
    const out = pickSuggestions([otraHamburguesa, p('h3', 'fuertes')], {
      exclude: ['h1'],
      covered: ['fuertes'],
    });

    expect(out.map((x) => x._id)).toEqual(['h2', 'h3']);
  });

  it('corta en el máximo', () => {
    const many = Array.from({ length: 20 }, (_, i) => p(`m${i}`, 'bebidas'));

    expect(pickSuggestions(many)).toHaveLength(MAX_SUGGESTIONS);
    expect(pickSuggestions(many, { limit: 3 })).toHaveLength(3);
  });

  it('no altera la lista que recibe: viene de la caché de react-query', () => {
    const catalog = [otraHamburguesa, gaseosa, postre];
    const before = [...catalog];

    pickSuggestions(catalog, { covered: ['fuertes'] });

    expect(catalog).toEqual(before);
  });
});

describe('freeDeliveryGap', () => {
  it('dice cuánto falta mientras no se alcanza el umbral', () => {
    expect(freeDeliveryGap(28_900, 40_000)).toBe(11_100);
  });

  it('calla cuando ya se alcanzó, y cuando el negocio no tiene umbral', () => {
    expect(freeDeliveryGap(40_000, 40_000)).toBeNull();
    expect(freeDeliveryGap(50_000, 40_000)).toBeNull();
    expect(freeDeliveryGap(10_000, 0)).toBeNull();
    expect(freeDeliveryGap(10_000, undefined)).toBeNull();
  });
});
