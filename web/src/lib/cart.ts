import { useSyncExternalStore } from 'react';
import type { ModifierChoice } from './modifiers';

/**
 * Carrito del navegador: un solo comercio a la vez.
 *
 * El precio que se guarda (`unitPrice`) es solo para mostrar mientras se
 * arma el pedido. El total real lo calcula el servidor en cada cotización
 * (`POST /orders/quote`); el carrito nunca suma dinero que se vaya a cobrar.
 */
export interface CartLine {
  key: string;
  productId: string;
  name: string;
  image?: string | null;
  /** Precio unitario visible (con descuento y adicionales). Solo orientativo. */
  unitPrice: number;
  quantity: number;
  notes: string;
  choices: ModifierChoice[];
}

export interface CartState {
  businessId: string | null;
  businessName: string;
  businessSlug: string;
  lines: CartLine[];
}

export const MAX_LINE_QUANTITY = 20;
const STORAGE_KEY = 'zipp_cart_v1';
const EMPTY: CartState = { businessId: null, businessName: '', businessSlug: '', lines: [] };

function load(): CartState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<CartState>;
    if (!parsed || typeof parsed.businessId !== 'string' || !Array.isArray(parsed.lines)) return EMPTY;
    return {
      businessId: parsed.businessId,
      businessName: String(parsed.businessName ?? ''),
      businessSlug: String(parsed.businessSlug ?? ''),
      lines: parsed.lines.filter((l): l is CartLine => Boolean(l && typeof l.productId === 'string' && l.quantity > 0)),
    };
  } catch {
    return EMPTY;
  }
}

let state: CartState = load();
const listeners = new Set<() => void>();

function commit(next: CartState): void {
  state = next.lines.length === 0 ? EMPTY : next;
  try {
    if (state === EMPTY) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Sin almacenamiento: el carrito vive solo mientras la pestaña esté abierta.
  }
  listeners.forEach((l) => l());
}

/** Misma línea = mismo producto, mismas opciones y misma nota. */
export function lineKey(productId: string, choices: ModifierChoice[], notes: string): string {
  const options = choices.map((c) => c.optionId).sort().join(',');
  return `${productId}|${options}|${notes.trim().toLowerCase()}`;
}

export function getCart(): CartState {
  return state;
}

export function subscribeCart(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCart(): CartState {
  return useSyncExternalStore(subscribeCart, getCart, () => EMPTY);
}

export interface BusinessRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * Agrega una línea. Si el carrito ya tiene productos de OTRO comercio no
 * hace nada y devuelve `'conflict'`: la pantalla pregunta y, si la persona
 * acepta, llama de nuevo con `replace: true`.
 */
export function addLine(
  business: BusinessRef,
  line: Omit<CartLine, 'key'>,
  options: { replace?: boolean } = {},
): 'added' | 'conflict' {
  const sameBusiness = state.businessId === business.id || state.lines.length === 0;
  if (!sameBusiness && !options.replace) return 'conflict';

  const base: CartState = sameBusiness
    ? { ...state, businessId: business.id, businessName: business.name, businessSlug: business.slug }
    : { businessId: business.id, businessName: business.name, businessSlug: business.slug, lines: [] };

  const key = lineKey(line.productId, line.choices, line.notes);
  const existing = base.lines.find((l) => l.key === key);
  const lines = existing
    ? base.lines.map((l) =>
        l.key === key ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, l.quantity + line.quantity), unitPrice: line.unitPrice } : l,
      )
    : [...base.lines, { ...line, key, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity) }];

  commit({ ...base, lines });
  return 'added';
}

export function setQuantity(key: string, quantity: number): void {
  if (quantity <= 0) {
    removeLine(key);
    return;
  }
  commit({
    ...state,
    lines: state.lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, quantity) } : l)),
  });
}

export function removeLine(key: string): void {
  commit({ ...state, lines: state.lines.filter((l) => l.key !== key) });
}

export function clearCart(): void {
  commit(EMPTY);
}

/** Suma orientativa para el aviso del carrito. El total que se cobra lo calcula el servidor. */
export function estimatedSubtotal(cart: CartState): number {
  return cart.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

export function itemCount(cart: CartState): number {
  return cart.lines.reduce((sum, l) => sum + l.quantity, 0);
}

/** Solo para pruebas: reinicia el estado en memoria sin tocar el almacenamiento real. */
export function __resetCartForTests(): void {
  state = EMPTY;
  listeners.forEach((l) => l());
}
