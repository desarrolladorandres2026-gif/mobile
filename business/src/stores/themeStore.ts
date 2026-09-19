import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'auto';

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  initTheme: () => void;
}

const STORAGE_KEY = 'zipp_business_theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeToDOM(resolvedTheme: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (resolvedTheme === 'dark') {
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
  } else {
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
  }
}

let systemListenerInstalled = false;

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'auto',
  resolvedTheme: 'light',

  setTheme: (theme: Theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    const resolvedTheme = theme === 'auto' ? getSystemTheme() : theme;
    applyThemeToDOM(resolvedTheme);
    set({ theme, resolvedTheme });
  },

  initTheme: () => {
    const saved = (localStorage.getItem(STORAGE_KEY) as Theme) || 'auto';
    const resolvedTheme = saved === 'auto' ? getSystemTheme() : saved;
    applyThemeToDOM(resolvedTheme);
    set({ theme: saved, resolvedTheme });

    // Listener para cambios en el sistema operativo
    // Una sola vez por pestaña. Antes se quitaba con `removeEventListener`
    // pasándole una función recién creada —que nunca era la registrada—,
    // así que cada llamada a `initTheme` sumaba otro listener.
    if (typeof window !== 'undefined' && !systemListenerInstalled) {
      systemListenerInstalled = true;
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener('change', () => {
        if (get().theme === 'auto') {
          const newResolved = mediaQuery.matches ? 'dark' : 'light';
          applyThemeToDOM(newResolved);
          set({ resolvedTheme: newResolved });
        }
      });
    }
  },
}));

