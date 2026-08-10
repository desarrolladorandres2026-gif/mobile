import { useThemeStore } from '../stores/themeStore';
import { DarkColors, LightColors, ColorScheme } from '../constants/theme';

export function useThemeColors(): ColorScheme {
  const theme = useThemeStore((s) => s.theme);
  return theme === 'dark' ? DarkColors : LightColors;
}
