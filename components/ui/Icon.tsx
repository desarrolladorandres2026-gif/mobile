import { IconRegistry, type IconName } from '../../theme/icons';
import { Size } from '../../theme/tokens';

const SIZES = {
  sm: Size.iconSm,
  md: Size.iconMd,
  lg: Size.iconLg,
} as const;

export interface IconProps {
  name: IconName;
  /** `sm` 16 · `md` 20 · `lg` 24. Un número solo para casos excepcionales. */
  size?: keyof typeof SIZES | number;
  color: string;
  /** Trazo grueso. Reservado para el estado activo de la navegación. */
  strong?: boolean;
  /** Relleno del icono, para favoritos y calificaciones marcadas. */
  fill?: string;
  /**
   * Descripción para lectores de pantalla.
   *
   * Ponlo únicamente cuando el icono viaja solo y carga significado. Si al
   * lado hay texto que ya dice lo mismo, omítelo: el icono se marca como
   * decorativo y el lector no lee la etiqueta dos veces.
   */
  label?: string;
}

/**
 * Único punto de entrada para iconos de interfaz.
 *
 * Centralizar aquí es lo que hace que el tamaño, el grosor de línea y el
 * comportamiento de accesibilidad sean iguales en toda la app, en vez de
 * depender de que cada pantalla se acuerde.
 */
export function Icon({ name, size = 'md', color, strong, fill, label }: IconProps) {
  const Glyph = IconRegistry[name];
  const px = typeof size === 'number' ? size : SIZES[size];

  const a11y = label
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
    : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

  return (
    <Glyph
      size={px}
      color={color}
      strokeWidth={strong ? Size.iconStrokeBold : Size.iconStroke}
      fill={fill ?? 'none'}
      {...a11y}
    />
  );
}
