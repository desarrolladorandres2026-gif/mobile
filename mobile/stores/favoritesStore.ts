import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface FavoriteBusiness {
  _id: string;
  name: string;
  category: string;
  rating: number;
  deliveryTime: number;
  description?: string;
}

/**
 * Almacén local de favoritos — EN RETIRADA.
 *
 * Los favoritos viven ahora en el servidor (`hooks/useFavorites.ts`). Este
 * store solo sigue existiendo para una cosa: conservar lo que los usuarios
 * ya tenían guardado en el teléfono hasta que se suba, porque estrenar la
 * sincronización vaciándoles la lista sería peor que no sincronizar.
 *
 * Cuando `useFavoritesMigration` confirme la subida, llama a `clearLocal` y
 * esto queda vacío para siempre. No añadas consumidores nuevos.
 */
interface FavoritesState {
  favorites: FavoriteBusiness[];
  toggleFavorite: (business: FavoriteBusiness) => void;
  isFavorite: (id: string) => boolean;
  /** Vacía la lista local una vez el servidor confirma que la tiene. */
  clearLocal: () => void;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      toggleFavorite: (business) => {
        const { favorites } = get();
        const exists = favorites.some((f) => f._id === business._id);
        if (exists) {
          set({ favorites: favorites.filter((f) => f._id !== business._id) });
        } else {
          set({ favorites: [...favorites, business] });
        }
      },
      isFavorite: (id) => {
        return get().favorites.some((f) => f._id === id);
      },
      clearLocal: () => set({ favorites: [] }),
    }),
    {
      name: 'zipp-favorites-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
