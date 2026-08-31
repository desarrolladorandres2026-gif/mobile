import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Theme = 'dark' | 'light' | 'auto';

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'auto',
      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === 'dark' ? 'light' : state.theme === 'light' ? 'auto' : 'dark',
        })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'zipp-theme',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
