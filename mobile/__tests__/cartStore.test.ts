import { useCartStore, type CartItemInput } from '../stores/cartStore';

/**
 * El carrito.
 *
 * Se prueba esto y no las pantallas porque aquí es donde vive lo que puede
 * costar dinero de verdad: mezclar líneas de dos negocios en una misma
 * bolsa, o fundir dos líneas que el cliente pidió distintas (una hamburguesa
 * con queso extra y otra sin) haría que llegara a la puerta algo que nadie
 * pidió.
 */

const base: CartItemInput = {
  productId: 'p1',
  productName: 'Hamburguesa',
  quantity: 1,
  unitPrice: 20000,
  selectedExtras: [],
};

function reset() {
  useCartStore.setState({ carts: [] });
}

function itemsOf(businessId: string) {
  return useCartStore.getState().getCart(businessId)?.items ?? [];
}

beforeEach(reset);

describe('identidad de línea', () => {
  it('suma cantidades cuando el producto y los extras son idénticos', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', base);

    const items = itemsOf('b1');
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
  });

  it('mantiene líneas separadas si los extras difieren', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', {
      ...base,
      selectedExtras: [{ name: 'Queso extra', price: 3000, quantity: 1 }],
    });

    // Fundirlas entregaría dos hamburguesas iguales cuando se pidieron
    // distintas, y una de las dos estaría mal cobrada.
    expect(itemsOf('b1')).toHaveLength(2);
  });

  it('mantiene líneas separadas si la nota difiere', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', { ...base, notes: 'Sin cebolla' });

    expect(itemsOf('b1')).toHaveLength(2);
  });
});

describe('una bolsa por negocio', () => {
  it('agregar de otro negocio abre una bolsa nueva sin tocar la primera', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo' });

    const state = useCartStore.getState();
    expect(state.carts).toHaveLength(2);
    expect(itemsOf('b1')[0].productName).toBe('Hamburguesa');
    expect(itemsOf('b2')[0].productName).toBe('Pollo');
  });

  it('el subtotal y el conteo de cada bolsa son independientes', () => {
    const { addItem, getSubtotal, getItemCount } = useCartStore.getState();

    addItem('b1', 'El Corral', { ...base, quantity: 2 });
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo', unitPrice: 15000 });

    expect(getSubtotal('b1')).toBe(40000);
    expect(getSubtotal('b2')).toBe(15000);
    expect(getItemCount('b1')).toBe(2);
    expect(getItemCount('b2')).toBe(1);
    // Sin negocio, es el total de todas las bolsas juntas.
    expect(getItemCount()).toBe(3);
  });

  it('quitar todo de un negocio no afecta la bolsa de otro', () => {
    const { addItem, removeItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo' });

    const lineId = itemsOf('b1')[0].lineId;
    removeItem('b1', lineId);

    expect(useCartStore.getState().getCart('b1')).toBeUndefined();
    expect(itemsOf('b2')).toHaveLength(1);
  });
});

describe('vaciar', () => {
  it('olvida el negocio cuando se quita la última línea', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);

    const lineId = itemsOf('b1')[0].lineId;
    useCartStore.getState().removeItem('b1', lineId);

    expect(useCartStore.getState().getCart('b1')).toBeUndefined();
    expect(useCartStore.getState().carts).toHaveLength(0);
  });

  it('quitar la línea al poner cantidad cero', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);

    const lineId = itemsOf('b1')[0].lineId;
    useCartStore.getState().updateQuantity('b1', lineId, 0);

    expect(itemsOf('b1')).toHaveLength(0);
  });

  it('clearCart(businessId) solo vacía esa bolsa', () => {
    const { addItem, clearCart } = useCartStore.getState();
    addItem('b1', 'El Corral', base);
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo' });

    clearCart('b1');

    expect(useCartStore.getState().getCart('b1')).toBeUndefined();
    expect(itemsOf('b2')).toHaveLength(1);
  });

  it('clearCart() sin negocio vacía todas las bolsas (logout)', () => {
    const { addItem, clearCart } = useCartStore.getState();
    addItem('b1', 'El Corral', base);
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo' });

    clearCart();

    expect(useCartStore.getState().carts).toHaveLength(0);
  });
});

describe('grupos de modificadores', () => {
  const angus = { name: 'Angus', price: 7000, quantity: 1, groupId: 'g1', groupName: 'Tipo de carne', optionId: 'o2' };
  const res = { name: 'Res', price: 0, quantity: 1, groupId: 'g1', groupName: 'Tipo de carne', optionId: 'o1' };

  it('C-01: el mismo producto con distinta opción son dos líneas', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [angus] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [res] });

    expect(itemsOf('b1')).toHaveLength(2);
  });

  it('la misma opción se funde aunque el nombre haya cambiado', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [angus] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ ...angus, name: 'Angus 150 g' }] });

    const items = itemsOf('b1');
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
  });

  it('una opción de grupo y un extra plano con el mismo nombre no se confunden', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ name: 'Cheddar', price: 500, quantity: 1 }] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ name: 'Cheddar', price: 2500, quantity: 1, groupId: 'g', groupName: 'Queso', optionId: 'oc' }] });

    expect(itemsOf('b1')).toHaveLength(2);
  });

  it('el total de la línea suma opciones y extras heredados', () => {
    const { addItem, getLineTotal, getSubtotal } = useCartStore.getState();
    addItem('b1', 'El Corral', {
      ...base, quantity: 2,
      selectedExtras: [angus, { name: 'Queso extra', price: 3000, quantity: 2 }],
    });
    const [line] = itemsOf('b1');
    expect(getLineTotal(line)).toBe((20000 + 7000 + 6000) * 2);
    expect(getSubtotal('b1')).toBe(66000);
  });

  it('R-01: líneas heredadas y nuevas conviven en la misma bolsa', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', { ...base, productId: 'p2', productName: 'Doble', selectedExtras: [angus] });
    addItem('b1', 'El Corral', base);

    const items = itemsOf('b1');
    expect(items).toHaveLength(2);
    expect(items[0].quantity).toBe(2);
    expect(items[1].selectedExtras[0].optionId).toBe('o2');
  });
});
