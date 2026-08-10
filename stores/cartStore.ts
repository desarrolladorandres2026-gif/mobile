import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CartExtra {
  name: string;
  price: number;
  quantity: number;
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
}

/** Input shape callers provide; the store derives `lineId`. */
export type CartItemInput = Omit<CartItem, 'lineId'>;

interface CartState {
  businessId: string | null;
  businessName: string | null;
  items: CartItem[];

  addItem: (businessId: string, businessName: string, item: CartItemInput) => void;
  removeItem: (lineId: string) => void;
  updateQuantity: (lineId: string, quantity: number) => void;
  clearCart: () => void;

  getLineTotal: (item: CartItem) => number;
  getSubtotal: () => number;
  getItemCount: () => number;
}

/**
 * Two cart lines are the same only when the product, its extras, and the
 * note all match. Merging purely by productId silently discarded the extras
 * of the second line — the customer paid for a burger without the bacon
 * they picked.
 */
function buildLineId(item: CartItemInput): string {
  const extras = [...item.selectedExtras]
    .map((e) => `${e.name}x${e.quantity}`)
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
      businessId: null,
      businessName: null,
      items: [],

      addItem: (businessId, businessName, item) => {
        const state = get();
        const lineId = buildLineId(item);
        const newItem: CartItem = { ...item, lineId };

        // Zipp carts hold one business at a time.
        if (state.businessId && state.businessId !== businessId) {
          set({ businessId, businessName, items: [newItem] });
          return;
        }

        const existingIndex = state.items.findIndex((i) => i.lineId === lineId);

        if (existingIndex >= 0) {
          const updated = [...state.items];
          updated[existingIndex] = {
            ...updated[existingIndex],
            quantity: updated[existingIndex].quantity + item.quantity,
          };
          set({ items: updated, businessId, businessName });
        } else {
          set({ items: [...state.items, newItem], businessId, businessName });
        }
      },

      removeItem: (lineId) => {
        const items = get().items.filter((i) => i.lineId !== lineId);
        if (items.length === 0) {
          set({ items: [], businessId: null, businessName: null });
        } else {
          set({ items });
        }
      },

      updateQuantity: (lineId, quantity) => {
        if (quantity <= 0) {
          get().removeItem(lineId);
          return;
        }
        const items = get().items.map((i) =>
          i.lineId === lineId ? { ...i, quantity } : i
        );
        set({ items });
      },

      clearCart: () => set({ items: [], businessId: null, businessName: null }),

      getLineTotal: (item) => lineTotal(item),

      getSubtotal: () => get().items.reduce((sum, item) => sum + lineTotal(item), 0),

      getItemCount: () => get().items.reduce((sum, item) => sum + item.quantity, 0),
    }),
    {
      name: 'zipp-cart-storage',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      // Carts persisted before line identity existed have no lineId, which
      // would break every remove/update. Rebuild it on load.
      migrate: (persisted: any, version) => {
        if (!persisted) return persisted;
        if (version < 2 && Array.isArray(persisted.items)) {
          persisted.items = persisted.items.map((item: any) => ({
            ...item,
            selectedExtras: item.selectedExtras ?? [],
            lineId: item.lineId ?? buildLineId(item),
          }));
        }
        return persisted;
      },
    }
  )
);
