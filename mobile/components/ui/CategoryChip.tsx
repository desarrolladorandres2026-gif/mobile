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
 * La ilustración trae su propio blob de color pálido. Sobre `c.surface`
 * contrasta bien, pero sobre el dorado del chip activo se lava: dos tonos
 * claros pegados, sin borde entre ellos.
 *
 * Se resuelve con un disco claro detrás del glifo, y solo cuando está
 * activo. Es lo mismo que hace la portada de la tarjeta de negocio con su
 * `coverBadgeCircle`: aislar el dibujo del fondo en vez de repintarlo. Y
 * tiene un efecto útil de paso — el disco aparece al seleccionar, así que el
 * chip activo no solo cambia de color: cambia de forma.
 */
function glyphSurface(active: boolean | undefined, c: ReturnType<typeof useTheme>['c']): ViewStyle {
  if (!active) return {};
  return { backgroundColor: c.surface, borderRadius: BorderRadius.full };
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
