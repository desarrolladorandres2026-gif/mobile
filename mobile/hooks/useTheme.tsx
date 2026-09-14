import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { useThemeStore, type Theme as ThemeMode } from '../stores/themeStore';
import { DarkColors, LightColors, type ColorScheme } from '../theme/tokens';

export interface Theme {
  /** Tokens de color del tema activo. */
  c: ColorScheme;
  isDark: boolean;
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (theme: ThemeMode) => void;
}

const ThemeOverrideContext = createContext<boolean | null>(null);

/**
 * Permite forzar un tema específico (ej. dark en pantallas de autenticación
 * que usan fondos cinematográficos oscuros con la identidad Obsidian & Gold).
 */
export function ForceTheme({ isDark, children }: { isDark: boolean; children: ReactNode }) {
  return (
    <ThemeOverrideContext.Provider value={isDark}>
      {children}
    </ThemeOverrideContext.Provider>
  );
}

/**
 * Tema activo. Se llama `c` a propósito: aparece en cada línea de estilo de
 * la app y un nombre corto mantiene las hojas de estilo legibles.
 * Soporta modos: 'light' (claro), 'dark' (oscuro) y 'auto' (según el sistema operativo).
 */
export function useTheme(): Theme {
  const forcedDark = useContext(ThemeOverrideContext);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const systemScheme = useColorScheme();

  const isDark = useMemo(() => {
    if (forcedDark !== null && forcedDark !== undefined) {
      return forcedDark;
    }
    if (theme === 'auto') {
      return systemScheme === 'dark';
    }
    return theme === 'dark';
  }, [forcedDark, theme, systemScheme]);

  const colors = useMemo(() => (isDark ? DarkColors : LightColors), [isDark]);

  return {
    c: colors,
    isDark,
    theme,
    toggleTheme,
    setTheme,
  };
}

/**
 * Crea la hoja de estilos una sola vez por tema.
 *
 * Sin esto, cada render reconstruye el StyleSheet y React Native pierde el
 * cacheo de estilos, que en listas largas se nota.
 */
export function useStyles<T>(factory: (c: ColorScheme, isDark: boolean) => T): T {
  const { c, isDark } = useTheme();
  return useMemo(() => factory(c, isDark), [c, isDark]);
}
