import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface PrefsState {
  /** Última dirección usada, para no volver a preguntarla en cada pedido. */
  lastAddressId: string | null;
  setLastAddress: (id: string | null) => void;

  /** Historial de búsquedas recientes del usuario. */
  recentSearches: string[];
  addRecentSearch: (query: string) => void;
  removeRecentSearch: (query: string) => void;
  clearRecentSearches: () => void;

  /**
   * El documento de términos de Wompi que esta persona aceptó, por su URL.
   *
   * Se recuerda la versión, no un "sí" genérico: si Wompi publica otros
   * términos la URL cambia y la casilla vuelve a aparecer vacía. Así el
   * segundo pago es de un toque sin que el consentimiento se herede a un
   * documento que nadie leyó.
   */
  acceptedPaymentTerms: string | null;
  setAcceptedPaymentTerms: (permalink: string | null) => void;

  /** Se guarda para poder restaurar el estado en pruebas y soporte. */
  reset: () => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      lastAddressId: null,
      setLastAddress: (id) => set({ lastAddressId: id }),

      recentSearches: [],
      addRecentSearch: (query: string) => {
        const clean = query.trim();
        if (!clean) return;
        set((state) => {
          const filtered = (state.recentSearches || []).filter(
            (item) => item.toLowerCase() !== clean.toLowerCase()
          );
          return { recentSearches: [clean, ...filtered].slice(0, 8) };
        });
      },
      removeRecentSearch: (query: string) => {
        set((state) => ({
          recentSearches: (state.recentSearches || []).filter(
            (item) => item.toLowerCase() !== query.toLowerCase()
          ),
        }));
      },
      clearRecentSearches: () => set({ recentSearches: [] }),

      acceptedPaymentTerms: null,
      setAcceptedPaymentTerms: (permalink) => set({ acceptedPaymentTerms: permalink }),

      reset: () =>
        set({ lastAddressId: null, recentSearches: [], acceptedPaymentTerms: null }),
    }),
    {
      name: 'zipp-prefs',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

