import { useCartStore, type CartItemInput } from '../stores/cartStore';

/**
 * El carrito.
 *
 * Se prueba esto y no las pantallas porque aquí es donde vive lo que puede
 * costar dinero de verdad: mezclar productos de dos negocios en un pedido,
 * o fundir dos líneas que el cliente pidió distintas (una hamburguesa con
 * queso extra y otra sin) haría que llegara a la puerta algo que nadie pidió.
 */

const base: CartItemInput = {
  productId: 'p1',
  productName: 'Hamburguesa',
  quantity: 1,
  unitPrice: 20000,
  selectedExtras: [],
};

function reset() {
  useCartStore.setState({ businessId: null, businessName: null, items: [] });
}

beforeEach(reset);

describe('identidad de línea', () => {
  it('suma cantidades cuando el producto y los extras son idénticos', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', base);

    const { items } = useCartStore.getState();
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
    expect(useCartStore.getState().items).toHaveLength(2);
  });

  it('mantiene líneas separadas si la nota difiere', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', { ...base, notes: 'Sin cebolla' });

    expect(useCartStore.getState().items).toHaveLength(2);
  });
});

describe('un solo negocio por carrito', () => {
  it('reemplaza el carrito al añadir de otro negocio', () => {
    const { addItem } = useCartStore.getState();

    addItem('b1', 'El Corral', base);
    addItem('b2', 'Frisby', { ...base, productId: 'p2', productName: 'Pollo' });

    const state = useCartStore.getState();
    expect(state.businessId).toBe('b2');
    expect(state.items).toHaveLength(1);
    expect(state.items[0].productName).toBe('Pollo');
  });
});

describe('vaciar', () => {
  it('olvida el negocio cuando se quita la última línea', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);

    const lineId = useCartStore.getState().items[0].lineId;
    useCartStore.getState().removeItem(lineId);

    const state = useCartStore.getState();
    expect(state.items).toHaveLength(0);
    // Si el negocio se quedara pegado, el siguiente producto de otro sitio
    // se trataría como "cambio de negocio" y borraría un carrito vacío,
    // o peor, se mezclaría.
    expect(state.businessId).toBeNull();
  });

  it('quitar la línea al poner cantidad cero', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);

    const lineId = useCartStore.getState().items[0].lineId;
    useCartStore.getState().updateQuantity(lineId, 0);

    expect(useCartStore.getState().items).toHaveLength(0);
  });
});

describe('grupos de modificadores', () => {
  const angus = { name: 'Angus', price: 7000, quantity: 1, groupId: 'g1', groupName: 'Tipo de carne', optionId: 'o2' };
  const res = { name: 'Res', price: 0, quantity: 1, groupId: 'g1', groupName: 'Tipo de carne', optionId: 'o1' };

  it('C-01: el mismo producto con distinta opción son dos líneas', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [angus] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [res] });

    const { items } = useCartStore.getState();
    expect(items).toHaveLength(2);
  });

  it('la misma opción se funde aunque el nombre haya cambiado', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [angus] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ ...angus, name: 'Angus 150 g' }] });

    const { items } = useCartStore.getState();
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
  });

  it('una opción de grupo y un extra plano con el mismo nombre no se confunden', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ name: 'Cheddar', price: 500, quantity: 1 }] });
    addItem('b1', 'El Corral', { ...base, selectedExtras: [{ name: 'Cheddar', price: 2500, quantity: 1, groupId: 'g', groupName: 'Queso', optionId: 'oc' }] });

    expect(useCartStore.getState().items).toHaveLength(2);
  });

  it('el total de la línea suma opciones y extras heredados', () => {
    const { addItem, getLineTotal, getSubtotal } = useCartStore.getState();
    addItem('b1', 'El Corral', {
      ...base, quantity: 2,
      selectedExtras: [angus, { name: 'Queso extra', price: 3000, quantity: 2 }],
    });
    const [line] = useCartStore.getState().items;
    expect(getLineTotal(line)).toBe((20000 + 7000 + 6000) * 2);
    expect(getSubtotal()).toBe(66000);
  });

  it('R-01: líneas heredadas y nuevas conviven en la misma bolsa', () => {
    const { addItem } = useCartStore.getState();
    addItem('b1', 'El Corral', base);
    addItem('b1', 'El Corral', { ...base, productId: 'p2', productName: 'Doble', selectedExtras: [angus] });
    addItem('b1', 'El Corral', base);

    const { items } = useCartStore.getState();
    expect(items).toHaveLength(2);
    expect(items[0].quantity).toBe(2);
    expect(items[1].selectedExtras[0].optionId).toBe('o2');
  });
});
