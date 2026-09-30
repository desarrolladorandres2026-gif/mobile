import { create } from 'zustand';

interface User {
  _id: string;
  name: string;
  phone: string;
  role: string;
  twoFactorEnabled?: boolean;
}

interface Business {
  _id: string;
  name: string;
  category: string;
  city: string;
  /**
   * Si el local esta recibiendo pedidos.
   *
   * Es el mismo campo que `order.service.create` comprueba antes de
   * aceptar un pedido nuevo, asi que el interruptor Abierto/Cerrado del
   * menu lateral lo escribe de verdad en el servidor.
   */
  isActive?: boolean;
  /** Suspendido por ZIPP: el dueño no puede quitarlo desde aquí. */
  isSuspended?: boolean;
  suspensionReason?: string;
  isApproved?: boolean;
  isArchived?: boolean;
  /** Portada del negocio; también decora el encabezado de cada página. */
  coverImage?: string | null;
}

/**
 * Decide qué establecimiento queda activo cuando llega una lista nueva.
 *
 * El caso que importa es la lista vacía. Tal y como está hoy, un `[]` borra
 * la selección guardada: el comercio se queda sin local activo y todas las
 * páginas del panel pasan a su estado vacío. Eso es correcto si de verdad
 * perdió el acceso, y es un destrozo si el `[]` viene de un fallo del
 * servidor o de una sesión a medio refrescar.
 *
 * Es una política de negocio, no de código, y por eso vive aquí sola en vez
 * de estar enterrada dentro de `setBusinesses`.
 */
function pickSelected(businesses: Business[], current: Business | null): Business | null {
  // Conservar la selección solo si sigue perteneciendo al usuario.
  const stillOwned = current ? businesses.find((b) => b._id === current._id) : undefined;
  return stillOwned || businesses[0] || null;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  businesses: Business[];
  selectedBusiness: Business | null;
  isAuthenticated: boolean;
  businessesLoaded: boolean;

  setAuth: (user: User, token: string, refreshToken: string) => void;
  setTokens: (token: string, refreshToken: string) => void;
  /** Toma tokens que otra pestaña ya guardó: cambia el estado, no escribe. */
  adoptTokens: (token: string, refreshToken: string) => void;
  markTwoFactorEnabled: () => void;
  setBusinesses: (businesses: Business[]) => void;
  setSelectedBusiness: (business: Business | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: JSON.parse(localStorage.getItem('business_user') || 'null'),
  token: localStorage.getItem('business_token'),
  refreshToken: localStorage.getItem('business_refresh_token'),
  businesses: JSON.parse(localStorage.getItem('business_list') || '[]'),
  selectedBusiness: JSON.parse(localStorage.getItem('business_selected') || 'null'),
  isAuthenticated: !!localStorage.getItem('business_token'),
  businessesLoaded: false,

  setBusinesses: (businesses) => {
    localStorage.setItem('business_list', JSON.stringify(businesses));

    const nextSelected = pickSelected(businesses, get().selectedBusiness);

    if (nextSelected) {
      localStorage.setItem('business_selected', JSON.stringify(nextSelected));
    } else {
      localStorage.removeItem('business_selected');
    }

    set({ businesses, selectedBusiness: nextSelected, businessesLoaded: true });
  },

  setAuth: (user, token, refreshToken) => {
    localStorage.setItem('business_user', JSON.stringify(user));
    localStorage.setItem('business_token', token);
    localStorage.setItem('business_refresh_token', refreshToken);
    set({ user, token, refreshToken, isAuthenticated: true });
  },

  setTokens: (token, refreshToken) => {
    localStorage.setItem('business_token', token);
    localStorage.setItem('business_refresh_token', refreshToken);
    set({ token, refreshToken });
  },

  adoptTokens: (token, refreshToken) => {
    if (get().token === token && get().refreshToken === refreshToken) return;
    set({ token, refreshToken, isAuthenticated: true });
  },

  markTwoFactorEnabled: () => {
    const user = get().user;
    if (!user) return;
    const next = { ...user, twoFactorEnabled: true };
    localStorage.setItem('business_user', JSON.stringify(next));
    set({ user: next });
  },

  setSelectedBusiness: (business) => {
    if (business) {
      localStorage.setItem('business_selected', JSON.stringify(business));
    } else {
      localStorage.removeItem('business_selected');
    }
    set({ selectedBusiness: business });
  },

  logout: () => {
    localStorage.removeItem('business_user');
    localStorage.removeItem('business_token');
    localStorage.removeItem('business_refresh_token');
    localStorage.removeItem('business_list');
    localStorage.removeItem('business_selected');
    set({ user: null, token: null, refreshToken: null, businesses: [], selectedBusiness: null, isAuthenticated: false, businessesLoaded: false });
  },
}));

/**
 * Mantiene al día las demás pestañas del mismo navegador.
 *
 * El evento `storage` solo se dispara en las pestañas que NO escribieron.
 * Sin esto, cada pestaña conservaba en memoria el refresh token con el que
 * arrancó y lo presentaba ya rotado (ver `lib/session.ts`).
 */
window.addEventListener('storage', (event) => {
  if (event.key !== 'business_token' && event.key !== 'business_refresh_token') return;
  const state = useAuthStore.getState();
  const token = localStorage.getItem('business_token');
  const refreshToken = localStorage.getItem('business_refresh_token');

  // Cerraron sesión en otra pestaña: aquí también.
  if (!token || !refreshToken) {
    if (state.token) state.logout();
    return;
  }

  // Entró otra cuenta en este navegador: recargar, no mezclar negocios.
  const idOf = (t: string | null) => {
    try {
      return JSON.parse(atob((t ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id as string | undefined;
    } catch {
      return undefined;
    }
  };
  const before = idOf(state.token);
  const after = idOf(token);
  if (before && after && before !== after) {
    window.location.reload();
    return;
  }

  state.adoptTokens(token, refreshToken);
});
