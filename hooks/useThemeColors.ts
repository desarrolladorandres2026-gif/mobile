import { useTheme } from './useTheme';
import { type ColorScheme } from '../theme/tokens';

export function useThemeColors(): ColorScheme {
  const { c } = useTheme();
  return c;
}
