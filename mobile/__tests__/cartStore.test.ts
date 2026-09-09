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
