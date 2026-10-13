import { create } from 'zustand';

/**
 * Tema del panel: claro, oscuro o el del sistema.
 *
 * `index.html` aplica la clase `.dark` antes del primer pintado leyendo la
 * misma clave; este almacén es quien la cambia después y quien se entera si el
 * sistema operativo cambia de tema estando en automático.
 */
export type Theme = 'light' | 'dark' | 'auto';

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  /** Claro → oscuro → automático → claro. */
  cycleTheme: () => void;
  initTheme: () => void;
}

const STORAGE_KEY = 'zipp_business_theme';

const systemTheme = (): 'light' | 'dark' =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

function applyToDOM(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

function readSaved(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' || saved === 'auto' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

let systemListenerInstalled = false;

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'auto',
  resolvedTheme: 'light',

  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Sin almacenamiento el tema vale para esta carga, nada más.
    }
    const resolvedTheme = theme === 'auto' ? systemTheme() : theme;
    applyToDOM(resolvedTheme);
    set({ theme, resolvedTheme });
  },

  cycleTheme: () => {
    const next: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };
    get().setTheme(next[get().theme]);
  },

  initTheme: () => {
    const saved = readSaved();
    const resolvedTheme = saved === 'auto' ? systemTheme() : saved;
    applyToDOM(resolvedTheme);
    set({ theme: saved, resolvedTheme });

    // Una sola vez por pestaña: en automático, seguir al sistema operativo.
    if (!systemListenerInstalled) {
      systemListenerInstalled = true;
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', () => {
        if (get().theme !== 'auto') return;
        const resolved = query.matches ? 'dark' : 'light';
        applyToDOM(resolved);
        set({ resolvedTheme: resolved });
      });
    }
  },
}));
