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

interface FavoritesState {
  favorites: FavoriteBusiness[];
  toggleFavorite: (business: FavoriteBusiness) => void;
  isFavorite: (id: string) => boolean;
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
    }),
    {
      name: 'zipp-favorites-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
