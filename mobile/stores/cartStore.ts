import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CartExtra {
  name: string;
  price: number;
  quantity: number;
  /** Solo cuando la elección salió de un grupo de modificadores. */
  groupId?: string;
  groupName?: string;
  optionId?: string;
}

export interface CartItem {
  /** Stable identity for this cart line. Same product + same extras + same note. */
  lineId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  image?: string;
  selectedExtras: CartExtra[];
  notes?: string;
  /** Precio de lista antes del descuento. Solo cuando el producto tenía uno. */
  originalUnitPrice?: number;
}

/** Input shape callers provide; the store derives `lineId`. */
export type CartItemInput = Omit<CartItem, 'lineId'>;

/**
 * Una bolsa por negocio.
 *
 * Cada negocio con algo agregado tiene la suya, viva al mismo tiempo que las
 * demás: elegir en la Panadería ya no borra lo que llevabas de la Pizzería.
 * Cada una se cobra y se entrega por separado, así que el pedido en el
 * servidor sigue siendo de un solo negocio — lo que cambia es que el
 * teléfono puede tener varias en curso a la vez.
 */
export interface BusinessCart {
  businessId: string;
  businessName: string;
  businessLogo: string | null;
  items: CartItem[];
}

interface CartState {
  /** Una entrada por negocio con algo agregado, en el orden en que se tocaron. */
  carts: BusinessCart[];

  addItem: (
    businessId: string,
    businessName: string,
    item: CartItemInput,
    businessLogo?: string | null
  ) => void;
  removeItem: (businessId: string, lineId: string) => void;
  updateQuantity: (businessId: string, lineId: string, quantity: number) => void;
  /** Vacía la bolsa de un negocio. Sin negocio, borra todo (logout). */
  clearCart: (businessId?: string) => void;

  getCart: (businessId: string) => BusinessCart | undefined;
  getLineTotal: (item: CartItem) => number;
  getSubtotal: (businessId: string) => number;
  getSavings: (businessId: string) => number;
  /** Unidades de un negocio, o de todos si se omite. */
  getItemCount: (businessId?: string) => number;
}

/**
 * Two cart lines are the same only when the product, its extras, and the
 * note all match. Merging purely by productId silently discarded the extras
 * of the second line — the customer paid for a burger without the bacon
 * they picked.
 */
function buildLineId(item: CartItemInput): string {
  // Una opción de grupo se identifica por su id, no por su nombre: el
  // comercio puede renombrar "Angus" sin que dos bolsas se confundan, y
  // dos grupos distintos pueden tener una opción que se llame igual.
  const extras = [...item.selectedExtras]
    .map((e) => `${e.optionId ?? e.name}x${e.quantity}`)
    .sort()
    .join('|');
  return `${item.productId}::${extras}::${(item.notes || '').trim()}`;
}

/** Line total including extras, each extra multiplied by its own quantity. */
function lineTotal(item: CartItem): number {
  const extrasTotal = item.selectedExtras.reduce(
    (sum, e) => sum + e.price * e.quantity,
    0
  );
  return (item.unitPrice + extrasTotal) * item.quantity;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      carts: [],

      addItem: (businessId, businessName, item, businessLogo = null) => {
        const state = get();
        const lineId = buildLineId(item);
        const newItem: CartItem = { ...item, lineId };

        const existingCartIndex = state.carts.findIndex((c) => c.businessId === businessId);

        if (existingCartIndex < 0) {
          const cart: BusinessCart = {
            businessId, businessName, businessLogo, items: [newItem],
          };
          set({ carts: [...state.carts, cart] });
          return;
        }

        const cart = state.carts[existingCartIndex];
        const existingLineIndex = cart.items.findIndex((i) => i.lineId === lineId);
        const items = existingLineIndex >= 0
          ? cart.items.map((i, idx) =>
              idx === existingLineIndex ? { ...i, quantity: i.quantity + item.quantity } : i
            )
          : [...cart.items, newItem];

        const updatedCart: BusinessCart = { businessId, businessName, businessLogo, items };
        const carts = [...state.carts];
        carts[existingCartIndex] = updatedCart;
        set({ carts });
      },

      removeItem: (businessId, lineId) => {
        const carts = get().carts
          .map((cart) => (
            cart.businessId === businessId
              ? { ...cart, items: cart.items.filter((i) => i.lineId !== lineId) }
              : cart
          ))
          .filter((cart) => cart.businessId !== businessId || cart.items.length > 0);
        set({ carts });
      },

      updateQuantity: (businessId, lineId, quantity) => {
        if (quantity <= 0) {
          get().removeItem(businessId, lineId);
          return;
        }
        const carts = get().carts.map((cart) => (
          cart.businessId === businessId
            ? {
                ...cart,
                items: cart.items.map((i) => (i.lineId === lineId ? { ...i, quantity } : i)),
              }
            : cart
        ));
        set({ carts });
      },

      clearCart: (businessId) => {
        if (!businessId) {
          set({ carts: [] });
          return;
        }
        set({ carts: get().carts.filter((c) => c.businessId !== businessId) });
      },

      getCart: (businessId) => get().carts.find((c) => c.businessId === businessId),

      getLineTotal: (item) => lineTotal(item),

      getSubtotal: (businessId) => {
        const cart = get().getCart(businessId);
        return cart ? cart.items.reduce((sum, item) => sum + lineTotal(item), 0) : 0;
      },

      getItemCount: (businessId) => {
        const carts = businessId
          ? get().carts.filter((c) => c.businessId === businessId)
          : get().carts;
        return carts.reduce(
          (sum, cart) => sum + cart.items.reduce((s, i) => s + i.quantity, 0),
          0
        );
      },

      getSavings: (businessId) => {
        const cart = get().getCart(businessId);
        if (!cart) return 0;
        return cart.items.reduce((sum, item) => {
          if (!item.originalUnitPrice || item.originalUnitPrice <= item.unitPrice) return sum;
          return sum + (item.originalUnitPrice - item.unitPrice) * item.quantity;
        }, 0);
      },
    }),
    {
      name: 'zipp-cart-storage',
      storage: createJSONStorage(() => AsyncStorage),
      version: 3,
      // v2 guardaba una sola bolsa (businessId/businessName/items sueltos).
      // v3 la envuelve en `carts: []` para poder tener varias a la vez. Los
      // ids de línea de antes de v2 se reconstruyen igual que siempre.
      migrate: (persisted: any, version) => {
        if (!persisted) return persisted;

        if (version < 2 && Array.isArray(persisted.items)) {
          persisted.items = persisted.items.map((item: any) => ({
            ...item,
            selectedExtras: item.selectedExtras ?? [],
            lineId: item.lineId ?? buildLineId(item),
          }));
        }

        if (version < 3) {
          const { businessId, businessName, businessLogo, items } = persisted;
          persisted.carts = businessId && Array.isArray(items) && items.length > 0
            ? [{ businessId, businessName, businessLogo: businessLogo ?? null, items }]
            : [];
          delete persisted.businessId;
          delete persisted.businessName;
          delete persisted.businessLogo;
          delete persisted.items;
        }

        return persisted;
      },
    }
  )
);
