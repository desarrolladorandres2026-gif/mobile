import { useMemo } from 'react';
import { useThemeStore } from '../stores/themeStore';
import { DarkColors, LightColors, type ColorScheme } from '../theme/tokens';

export interface Theme {
  /** Tokens de color del tema activo. */
  c: ColorScheme;
  isDark: boolean;
}

/**
 * Tema activo. Se llama `c` a propósito: aparece en cada línea de estilo de
 * la app y un nombre corto mantiene las hojas de estilo legibles.
 */
export function useTheme(): Theme {
  const theme = useThemeStore((s) => s.theme);
  return useMemo(
    () => ({ c: theme === 'dark' ? DarkColors : LightColors, isDark: theme === 'dark' }),
    [theme]
  );
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
