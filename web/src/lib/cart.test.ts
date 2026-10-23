import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetCartForTests, addLine, clearCart, estimatedSubtotal, getCart, itemCount, lineKey, MAX_LINE_QUANTITY, removeLine, setQuantity,
} from './cart';

const bakery = { id: 'b1', name: 'Panadería', slug: 'panaderia' };
const pizza = { id: 'b2', name: 'Pizzería', slug: 'pizzeria' };
const choice = { groupId: 'g1', groupName: 'Salsa', optionId: 'o1', name: 'BBQ', price: 500 };

const line = (over: Partial<Parameters<typeof addLine>[1]> = {}) => ({
  productId: 'p1', name: 'Pan', unitPrice: 2000, quantity: 1, notes: '', choices: [], ...over,
});

describe('carrito', () => {
  beforeEach(() => __resetCartForTests());

  it('agrega una línea y cuenta unidades', () => {
    expect(addLine(bakery, line({ quantity: 2 }))).toBe('added');
    expect(itemCount(getCart())).toBe(2);
    expect(estimatedSubtotal(getCart())).toBe(4000);
  });

  it('junta la misma línea (producto, opciones y nota) y separa las distintas', () => {
    addLine(bakery, line());
    addLine(bakery, line());
    addLine(bakery, line({ choices: [choice] }));
    expect(getCart().lines).toHaveLength(2);
    expect(getCart().lines[0].quantity).toBe(2);
  });

  it('no deja pasar de la cantidad máxima por línea', () => {
    addLine(bakery, line({ quantity: MAX_LINE_QUANTITY }));
    addLine(bakery, line({ quantity: 5 }));
    expect(getCart().lines[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it('un producto de otro comercio no entra sin confirmar y reemplaza si se confirma', () => {
    addLine(bakery, line());
    expect(addLine(pizza, line({ productId: 'p9', name: 'Pizza' }))).toBe('conflict');
    expect(getCart().businessId).toBe('b1');

    expect(addLine(pizza, line({ productId: 'p9', name: 'Pizza' }), { replace: true })).toBe('added');
    expect(getCart().businessId).toBe('b2');
    expect(getCart().lines).toHaveLength(1);
  });

  it('cantidad cero quita la línea y el carrito vacío vuelve al estado inicial', () => {
    addLine(bakery, line());
    const key = getCart().lines[0].key;
    setQuantity(key, 0);
    expect(getCart().lines).toHaveLength(0);
    expect(getCart().businessId).toBeNull();
  });

  it('quitar y vaciar', () => {
    addLine(bakery, line());
    addLine(bakery, line({ productId: 'p2' }));
    removeLine(getCart().lines[0].key);
    expect(getCart().lines).toHaveLength(1);
    clearCart();
    expect(getCart().lines).toHaveLength(0);
  });

  it('la llave ignora el orden de las opciones y las mayúsculas de la nota', () => {
    const a = { ...choice, optionId: 'a' };
    const b = { ...choice, optionId: 'b' };
    expect(lineKey('p', [a, b], 'Sin Cebolla')).toBe(lineKey('p', [b, a], ' sin cebolla '));
  });
});
