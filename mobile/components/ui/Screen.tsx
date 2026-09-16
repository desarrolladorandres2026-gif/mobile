import type { ReactNode } from 'react';
import { View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { HOME_ROUTE } from '../../constants/variant';

export function Screen({
  children, edges = ['top'], style,
}: { children: ReactNode; edges?: Edge[]; style?: ViewStyle }) {
  const { c } = useTheme();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }, style]} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

/**
 * Barra fija al pie de una pantalla, para la acción principal.
 *
 * Añade el inset inferior real del dispositivo al relleno: así el botón nunca
 * queda bajo el home indicator de iPhone ni bajo la barra de navegación de
 * Android, en vez de confiar en un número fijo que solo funciona en algunos
 * teléfonos. Pensada para pantallas con `Screen` (safe area solo arriba).
 */
export function ScreenFooter({
  children, style,
}: { children: ReactNode; style?: ViewStyle }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.footer,
        {
          borderTopColor: c.border,
          backgroundColor: c.background,
          paddingBottom: Math.max(insets.bottom, Spacing.md) + Spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface HeaderProps {
  title?: string;
  subtitle?: string;
  /** A dónde volver si no hay historial. Evita dejar al usuario encerrado. */
  fallback?: string;
  onBack?: () => void;
  hideBack?: boolean;
  right?: ReactNode;
  /** Sin línea inferior, para cabeceras sobre contenido que se desplaza. */
  bare?: boolean;
}

/**
 * Cabecera de pantalla.
 *
 * El botón de volver siempre tiene a dónde ir: si la pila está vacía —caso
 * típico al abrir la app desde una notificación— cae a una ruta conocida en
 * vez de quedarse sin hacer nada.
 */
export function Header({
  title, subtitle, fallback = HOME_ROUTE, onBack, hideBack, right, bare,
}: HeaderProps) {
  const { c } = useTheme();
  const router = useRouter();

  const goBack = () => {
    tap('light');
    if (onBack) return onBack();
    if (router.canGoBack()) router.back();
    else router.replace(fallback as never);
  };

  return (
    <View
      style={[
        styles.header,
        { borderBottomColor: c.border, borderBottomWidth: bare ? 0 : StyleSheet.hairlineWidth },
      ]}
    >
      {hideBack ? (
        <View style={styles.headerSpacer} />
      ) : (
        <Pressable
          onPress={goBack}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Volver"
          style={[styles.backBtn, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <Icon name="atras" size="md" color={c.text} />
        </Pressable>
      )}

      <View style={styles.headerTitles}>
        {title ? <Text v="titleM" numberOfLines={1} center>{title}</Text> : null}
        {subtitle ? (
          <Text v="caption" tone="textMuted" numberOfLines={1} center>{subtitle}</Text>
        ) : null}
      </View>

      <View style={styles.headerRight}>{right ?? <View style={styles.headerSpacer} />}</View>
    </View>
  );
}

/**
 * Contador de cantidad.
 *
 * A una unidad el botón de restar se vuelve el de eliminar, con su color y su
 * etiqueta: bajar a cero y que la línea desaparezca sin avisar desconcierta.
 */
export function QtyStepper({
  value, onChange, min = 1, itemName, size = 'md',
}: {
  value: number;
  onChange: (next: number) => void;
  /** Con `min` en 1, restar desde 1 elimina la línea. */
  min?: number;
  itemName?: string;
  size?: 'sm' | 'md';
}) {
  const { c } = useTheme();
  const removes = min === 1 && value === 1;
  const btn = size === 'sm' ? 32 : 38;

  return (
    <View style={[styles.stepper, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
      <StepperButton
        icon={removes ? 'eliminar' : 'menos'}
        color={removes ? c.error : c.text}
        bg={c.surface}
        size={btn}
        label={
          removes
            ? `Quitar ${itemName ?? 'producto'} del pedido`
            : `Quitar una unidad${itemName ? ` de ${itemName}` : ''}`
        }
        onPress={() => onChange(value - 1)}
      />
      <Text v="dataM" style={{ minWidth: 22, textAlign: 'center' }}>{value}</Text>
      <StepperButton
        icon="mas"
        color={c.text}
        bg={c.surface}
        size={btn}
        label={`Agregar una unidad${itemName ? ` de ${itemName}` : ''}`}
        onPress={() => onChange(value + 1)}
      />
    </View>
  );
}

function StepperButton({
  icon, color, bg, size, label, onPress,
}: {
  icon: 'mas' | 'menos' | 'eliminar';
  color: string; bg: string; size: number; label: string; onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animated}>
      <Pressable
        onPress={() => { tap('light'); onPress(); }}
        onPressIn={() => { scale.value = withSpring(0.86, { damping: 16, stiffness: 500 }); }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 12, stiffness: 400 }); }}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          width: size, height: size, borderRadius: BorderRadius.sm,
          backgroundColor: bg, alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={icon} size="sm" color={color} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  footer: {
    paddingTop: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    height: 58,
    gap: Spacing.md,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  headerSpacer: { width: 38 },
  headerTitles: { flex: 1, gap: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    padding: 3,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
  },
});
