import { View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
} from 'react-native-reanimated';
import { Text } from './Text';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

export interface CategoryChipProps {
  /** Clave de categoría del backend (`restaurant`, `pharmacy`…). */
  categoryKey: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}

/**
 * Filtro de categoría con mini-ilustración en lugar de icono.
 *
 * Gemelo de `<Chip>` (misma caja, mismo resorte al pulsar), pero para el
 * carrusel de categorías de Buscar: ahí una categoría es contenido, no una
 * acción, así que se dibuja la ilustración propia de la categoría —la misma
 * que el grid de Home— y no un glifo de librería.
 */
export function CategoryChip({ categoryKey, label, active, onPress }: CategoryChipProps) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const Illustration = categoryIllustration(categoryKey);

  return (
    <Animated.View style={animated}>
      <Pressable
        onPress={() => { tap('select'); onPress(); }}
        onPressIn={() => { scale.value = withSpring(0.94, { damping: 18, stiffness: 450 }); }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 14, stiffness: 380 }); }}
        accessibilityRole="button"
        accessibilityState={{ selected: !!active }}
        accessibilityLabel={label}
        style={[
          styles.chip,
          {
            backgroundColor: active ? c.primary : c.surface,
            borderColor: active ? c.primary : c.border,
          },
        ]}
      >
        <View style={[styles.glyph, glyphSurface(active, c)]}>
          <Illustration size={22} />
        </View>
        <Text v="strongS" color={active ? c.textOnPrimary : c.textSecondary}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Tratamiento de la mini-ilustración cuando el chip está seleccionado.
 *
 * TODO(diseño): decidir cómo se lee la ilustración sobre el fondo dorado del
 * chip activo. La ilustración trae su propio blob de color pálido, que sobre
 * `c.surface` contrasta bien pero sobre `c.primary` puede lavarse. Opciones:
 *   a) devolver `{}` — la ilustración se apoya directamente en el dorado.
 *   b) fondo `c.surface` + `borderRadius: BorderRadius.full` → disco claro
 *      detrás del glifo, que lo aísla del dorado (unos 26–28 px).
 *   c) `opacity` reducida cuando `!active` para que el color "encienda" al
 *      seleccionar.
 * Son ~5–8 líneas y definen el carácter del filtro seleccionado.
 */
function glyphSurface(_active: boolean | undefined, _c: ReturnType<typeof useTheme>['c']): ViewStyle {
  return {};
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.lg,
    height: 40,
    borderRadius: BorderRadius.full,
    borderWidth: 1.5,
  },
  glyph: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
