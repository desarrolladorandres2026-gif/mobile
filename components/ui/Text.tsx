import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { Type, type TypeVariant } from '../../theme/typography';
import type { ColorScheme } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

export interface TextProps extends RNTextProps {
  /** Variante de la escala tipográfica. */
  v?: TypeVariant;
  /** Color semántico del tema. Preferible a pasar un hex. */
  tone?: keyof ColorScheme;
  /** Color literal. Solo para superficies de color donde no aplica el tema. */
  color?: string;
  center?: boolean;
}

/**
 * Todo el texto de la app pasa por aquí.
 *
 * En React Native no existe herencia de tipografía: cada `<Text>` arranca con
 * la fuente del sistema. Sin un componente central, mantener tres familias y
 * dieciocho estilos consistentes en cuarenta pantallas es imposible.
 */
export function Text({
  v = 'bodyM',
  tone = 'text',
  color,
  center,
  style,
  ...rest
}: TextProps) {
  const { c } = useTheme();

  const base: TextStyle = {
    ...(Type[v] as TextStyle),
    color: color ?? (c[tone] as string),
    ...(center ? { textAlign: 'center' } : null),
  };

  return <RNText style={[base, style]} {...rest} />;
}
