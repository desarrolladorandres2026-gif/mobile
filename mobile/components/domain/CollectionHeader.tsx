import { memo, useEffect, type ComponentType } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming,
  withDelay, Easing, useReducedMotion,
} from 'react-native-reanimated';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import type { IllustrationProps } from '../illustrations';
import { Spacing } from '../../theme/tokens';

/**
 * Los siete "vestidos" de encabezado de colección. El servidor no sabe nada
 * de esto — es puramente cómo se presenta `section.title`/`subtitle`, nunca
 * qué tarjeta de producto se usa (`section.displayVariant`, un sistema
 * aparte, ver `ProductCollectionRow.tsx`).
 */
export type HeaderVariant =
  | 'editorial'
  | 'numbered'
  | 'illustrated'
  | 'featured'
  | 'minimal'
  | 'trend'
  | 'commercial';

export interface CollectionHeaderProps {
  variant: HeaderVariant;
  title: string;
  subtitle?: string;
  Illustration: ComponentType<IllustrationProps>;
  /** Solo lo usa `numbered`: el "01" antes del título. Base 1, no índice de arreglo. */
  index?: number;
}

/**
 * El "respiro" sutil de la mini-ilustración: mismo patrón de escala que ya
 * usaba `ProductCollectionRow` (`withRepeat(withSequence(...), -1, false)`).
 * Vive aquí porque ahora solo el encabezado la usa.
 */
const AnimatedIcon = memo(function AnimatedIcon({
  Illustration, size = 40,
}: { Illustration: ComponentType<IllustrationProps>; size?: number }) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    scale.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );
  }, [scale, reduceMotion]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={style}>
      <Illustration size={size} />
    </Animated.View>
  );
});

/**
 * Entrada discreta y única (no repite, no rebota): opacidad 0→1 + un
 * pequeño corrimiento hacia arriba, con la ilustración/acento adelantándose
 * un poco al bloque de texto. Con "Reducir movimiento" no hay animación —
 * se pinta ya en su estado final, sin excepción.
 */
function useEntrance(delayMs = 0) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) })
    );
  }, [progress, reduceMotion, delayMs]);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 8 }],
  }));
}

const ICON_SIZE_DEFAULT = 44;
const ICON_SIZE_LARGE = 50;

/**
 * Encabezado de una colección del inicio. Siete variantes reutilizables por
 * varias secciones (nunca una a medida por sección) — la asignación
 * `section.key → variant` vive en `ProductCollectionRow.tsx`.
 *
 * Reglas duras que todas las variantes respetan: nada de caja/borde/fondo
 * alrededor del título, el dorado es acento — nunca un lavado de color — y
 * el título nunca le quita el protagonismo al carrusel de abajo.
 */
export const CollectionHeader = memo(function CollectionHeader({
  variant, title, subtitle, Illustration, index = 1,
}: CollectionHeaderProps) {
  const { c } = useTheme();
  const iconStyle = useEntrance(0);
  const textStyle = useEntrance(60);

  switch (variant) {
    case 'editorial':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <AnimatedIcon Illustration={Illustration} size={ICON_SIZE_LARGE} />
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text
                v="displayM"
                style={[styles.editorialTitle, { color: c.text }]}
              >
                {title}
              </Text>
              <View style={[styles.dash, { backgroundColor: c.gold }]} />
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'numbered':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <Text v="dataS" color={c.gold} style={styles.numberLabel}>
              {String(index).padStart(2, '0')}
            </Text>
            <View style={[styles.numberDash, { backgroundColor: c.gold }]} />
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text v="titleL">{title}</Text>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'illustrated':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <AnimatedIcon Illustration={Illustration} size={56} />
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text v="displayS">{title}</Text>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'featured':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <View style={[styles.featuredMark, { backgroundColor: c.primarySoft, borderColor: c.primarySoftBorder }]}>
              <Icon name="calificacion" size={14} color={c.gold} />
            </View>
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text v="displayS">{title}</Text>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'trend':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <AnimatedIcon Illustration={Illustration} size={ICON_SIZE_DEFAULT} />
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <View style={styles.trendTitleRow}>
                <Text v="displayS">{title}</Text>
                <Icon name="siguiente" size={14} color={c.gold} strong />
              </View>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'commercial':
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <View style={[styles.commercialMark, { backgroundColor: c.gold }]}>
              <Icon name="descuento" size={13} color={c.black} />
            </View>
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text v="displayS">{title}</Text>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );

    case 'minimal':
    default:
      return (
        <View style={styles.section}>
          <Animated.View style={[styles.row, iconStyle]}>
            <AnimatedIcon Illustration={Illustration} size={ICON_SIZE_DEFAULT} />
            <Animated.View style={[styles.headerTitles, textStyle]}>
              <Text v="displayS">{title}</Text>
              {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
            </Animated.View>
          </Animated.View>
        </View>
      );
  }
});

const styles = StyleSheet.create({
  section: { marginBottom: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  headerTitles: { flex: 1, gap: 1 },

  // editorial
  editorialTitle: {
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dash: { width: 28, height: 3, borderRadius: 2, marginVertical: 4 },

  // numbered
  numberLabel: { fontWeight: '700' },
  numberDash: { width: 14, height: 2, borderRadius: 1 },

  // featured
  featuredMark: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },

  // trend
  trendTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  // commercial
  commercialMark: {
    width: 26, height: 26, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
});
