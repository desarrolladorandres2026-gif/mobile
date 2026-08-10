import { useEffect } from 'react';
import { View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSpring, Easing,
} from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { ORDER_STATUS_LABELS } from '../../constants/config';
import { tap } from '../../lib/haptics';

export type BadgeTone = 'neutral' | 'primary' | 'lime' | 'warning' | 'error' | 'live';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  icon?: IconName;
  /** Punto que late. Solo para lo que de verdad está pasando ahora. */
  pulse?: boolean;
  style?: ViewStyle;
}

export function Badge({ label, tone = 'neutral', icon, pulse, style }: BadgeProps) {
  const { c } = useTheme();

  const skin = {
    neutral: { bg: c.surfaceLight, fg: c.textSecondary, border: c.border },
    primary: { bg: c.primarySoft, fg: c.primaryText, border: c.primarySoftBorder },
    lime: { bg: c.limeSoft, fg: c.limeText, border: c.limeSoftBorder },
    warning: { bg: c.warningSoft, fg: c.warningText, border: 'transparent' },
    error: { bg: c.errorSoft, fg: c.errorText, border: 'transparent' },
    live: { bg: c.limeSoft, fg: c.limeText, border: c.limeSoftBorder },
  }[tone];

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: skin.bg, borderColor: skin.border },
        style,
      ]}
    >
      {pulse ? <PulseDot color={skin.fg} /> : null}
      {icon ? <Icon name={icon} size="sm" color={skin.fg} /> : null}
      <Text v="captionStrong" color={skin.fg}>{label}</Text>
    </View>
  );
}

/** Punto que late. Marca lo que está ocurriendo en tiempo real. */
export function PulseDot({ color, size = 7 }: { color: string; size?: number }) {
  const s = useSharedValue(1);

  useEffect(() => {
    s.value = withRepeat(
      withTiming(2.4, { duration: 1200, easing: Easing.out(Easing.quad) }),
      -1,
      false
    );
  }, []);

  const halo = useAnimatedStyle(() => ({
    transform: [{ scale: s.value }],
    opacity: 1 - (s.value - 1) / 1.4,
  }));

  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        style={[
          { position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: 0.4 },
          halo,
        ]}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Estado del pedido
// ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warning',
  accepted: 'primary',
  preparing: 'warning',
  ready: 'primary',
  picked_up: 'primary',
  on_way: 'primary',
  delivered: 'lime',
  cancelled: 'error',
};

const STATUS_ICON: Record<string, IconName> = {
  pending: 'reloj',
  accepted: 'check',
  preparing: 'catRestaurante',
  ready: 'paquete',
  picked_up: 'domiciliario',
  on_way: 'domiciliario',
  delivered: 'checkCirculo',
  cancelled: 'error',
};

const IN_MOTION = ['pending', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way'];

/** Estado del pedido con su color, icono y latido si sigue en curso. */
export function StatusPill({ status, showIcon = true }: { status: string; showIcon?: boolean }) {
  return (
    <Badge
      label={ORDER_STATUS_LABELS[status] ?? status}
      tone={STATUS_TONE[status] ?? 'neutral'}
      icon={showIcon ? STATUS_ICON[status] : undefined}
      pulse={IN_MOTION.includes(status)}
    />
  );
}

// ──────────────────────────────────────────────────────────────
// Filtros
// ──────────────────────────────────────────────────────────────

export interface ChipProps {
  label: string;
  active?: boolean;
  onPress: () => void;
  icon?: IconName;
}

/** Filtro seleccionable. Se hunde levemente al tocarlo. */
export function Chip({ label, active, onPress, icon }: ChipProps) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

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
        {icon ? (
          <Icon name={icon} size="sm" color={active ? c.textOnPrimary : c.textSecondary} />
        ) : null}
        <Text v="strongS" color={active ? c.textOnPrimary : c.textSecondary}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────
// Metadatos en línea
// ──────────────────────────────────────────────────────────────

export interface MetaItem {
  icon?: IconName;
  text: string;
  /** Resalta el dato. Se usa para la calificación y para los minutos. */
  strong?: boolean;
  tone?: 'textMuted' | 'text' | 'limeText' | 'primaryText';
}

/**
 * Fila de datos separados por puntos: calificación, minutos, envío.
 *
 * Va en mono porque son cifras, y porque así todas las tarjetas de una lista
 * alinean sus números aunque los nombres midan distinto.
 */
export function MetaRow({ items }: { items: MetaItem[] }) {
  const { c } = useTheme();
  return (
    <View style={styles.metaRow}>
      {items.map((item, i) => (
        <View key={`${item.text}-${i}`} style={styles.metaItem}>
          {i > 0 ? <View style={[styles.metaDot, { backgroundColor: c.borderStrong }]} /> : null}
          {item.icon ? (
            <Icon
              name={item.icon}
              size="sm"
              color={c[item.tone ?? 'textMuted'] as string}
              fill={item.icon === 'calificacion' ? (c[item.tone ?? 'textMuted'] as string) : undefined}
            />
          ) : null}
          <Text v={item.strong ? 'dataM' : 'dataS'} tone={item.tone ?? 'textMuted'}>
            {item.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Contador sobre un icono: artículos en la bolsa, avisos sin leer. */
export function CountBadge({ count, tone = 'lime' }: { count: number; tone?: 'lime' | 'error' }) {
  const { c } = useTheme();
  if (count <= 0) return null;
  return (
    <View
      style={[
        styles.count,
        { backgroundColor: tone === 'lime' ? c.lime : c.error, borderColor: c.background },
      ]}
    >
      <Text v="dataXS" color={tone === 'lime' ? c.textOnLime : c.white}>
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 1,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingHorizontal: Spacing.lg,
    height: 40,
    borderRadius: BorderRadius.full,
    borderWidth: 1.5,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.xs + 1 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  metaDot: { width: 3, height: 3, borderRadius: 1.5, marginRight: Spacing.xs },
  count: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
});
