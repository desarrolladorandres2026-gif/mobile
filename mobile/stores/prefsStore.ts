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

      reset: () => set({ lastAddressId: null, recentSearches: [] }),
    }),
    {
      name: 'zipp-prefs',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

