import { create } from 'zustand';

interface User {
  _id: string;
  name: string;
  phone: string;
  role: string;
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

    // Conservar la selección solo si sigue perteneciendo al usuario
    const current = get().selectedBusiness;
    const stillOwned = current ? businesses.find((b) => b._id === current._id) : undefined;
    const nextSelected = stillOwned || businesses[0] || null;

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

