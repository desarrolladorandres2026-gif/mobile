import { Pressable, View, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
} from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import { TrazoLoader } from '../brand/Trazo';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Shadow, Size, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

export type ButtonVariant = 'primary' | 'lime' | 'secondary' | 'ghost' | 'danger' | 'success' | 'successLight';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  /** Texto anclado a la derecha, para el total en los botones de confirmar. */
  trailing?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Ocupa todo el ancho disponible. */
  full?: boolean;
  /** Esquinas redondeadas al máximo (forma de píldora) en vez del radio estándar. */
  pill?: boolean;
  haptic?: 'light' | 'medium' | 'success' | 'none';
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

const HEIGHTS: Record<ButtonSize, number> = {
  sm: Size.buttonSm,
  md: Size.buttonMd,
  lg: Size.buttonLg,
};

/**
 * Botón de acción.
 *
 * El hundido al presionar no es adorno: en una app de pedidos el usuario toca
 * con una mano, en movimiento y a veces con datos lentos. La escala responde
 * en el hilo de UI y confirma el toque de inmediato, antes de que la red
 * conteste. Eso es la mitad de la sensación de rapidez.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  trailing,
  loading,
  disabled,
  full,
  pill,
  haptic = 'light',
  style,
  accessibilityHint,
}: ButtonProps) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const inert = disabled || loading;

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const skin = {
    primary: {
      bg: c.primary,
      fg: c.textOnPrimary,
      border: 'transparent',
      shadow: Shadow.primaryGlow,
    },
    lime: {
      bg: c.lime,
      fg: c.textOnLime,
      border: 'transparent',
      shadow: Shadow.limeGlow,
    },
    secondary: {
      bg: c.surfaceLight,
      fg: c.text,
      border: c.border,
      shadow: Shadow.none,
    },
    ghost: {
      bg: 'transparent',
      fg: c.primaryText,
      border: 'transparent',
      shadow: Shadow.none,
    },
    danger: {
      bg: c.errorSoft,
      fg: c.errorText,
      border: c.error,
      shadow: Shadow.none,
    },
    success: {
      bg: c.success,
      fg: c.white,
      border: 'transparent',
      shadow: Shadow.none,
    },
    successLight: {
      bg: c.successLight,
      fg: c.white,
      border: 'transparent',
      shadow: Shadow.none,
    },
  }[variant];

  const typeVariant = size === 'lg' ? 'buttonLg' : size === 'sm' ? 'buttonSm' : 'buttonMd';

  return (
    <Animated.View style={[full && styles.full, animated, style]}>
      <Pressable
        onPress={() => {
          if (inert) return;
          if (haptic !== 'none') tap(haptic);
          onPress();
        }}
        onPressIn={() => {
          if (!inert) scale.value = withSpring(0.965, { damping: 18, stiffness: 420 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 380 });
        }}
        disabled={inert}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!inert, busy: !!loading }}
        style={[
          styles.base,
          {
            height: HEIGHTS[size],
            borderRadius: pill ? HEIGHTS[size] / 2 : BorderRadius.lg,
            backgroundColor: skin.bg,
            borderColor: skin.border,
            borderWidth: variant === 'secondary' || variant === 'danger' ? 1.5 : 0,
            paddingHorizontal: size === 'sm' ? Spacing.md : Spacing.xl,
            opacity: disabled ? 0.42 : 1,
            // Con precio a la derecha el contenido se reparte; sin él, se centra.
            justifyContent: trailing && !loading ? 'space-between' : 'center',
          },
          variant !== 'ghost' && !disabled && skin.shadow,
        ]}
      >
        {loading ? (
          <TrazoLoader
            width={56}
            color={variant === 'primary' || variant === 'lime' ? skin.fg : c.primaryText}
          />
        ) : (
          <>
            <View style={styles.row}>
              {icon ? <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} color={skin.fg} /> : null}
              <Text v={typeVariant} color={skin.fg} numberOfLines={1} style={styles.shrink}>
                {title}
              </Text>
              {iconRight ? (
                <Icon name={iconRight} size={size === 'sm' ? 'sm' : 'md'} color={skin.fg} />
              ) : null}
            </View>

            {trailing ? (
              <View style={[styles.trailing, { backgroundColor: trailingTint(variant) }]}>
                <Text v="dataM" color={skin.fg}>{trailing}</Text>
              </View>
            ) : null}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** El chip del total se oscurece sobre rellenos claros y se aclara sobre oscuros. */
function trailingTint(variant: ButtonVariant): string {
  if (variant === 'lime') return 'rgba(13, 17, 32, 0.10)';
  if (variant === 'primary') return 'rgba(255, 255, 255, 0.18)';
  return 'transparent';
}

/** Botón circular de icono. Para volver, cerrar, compartir y favoritos. */
export function IconButton({
  icon,
  onPress,
  label,
  tone = 'neutral',
  size = 40,
  filled,
}: {
  icon: IconName;
  onPress: () => void;
  /** Obligatorio: sin texto visible, es lo único que anuncia el lector de pantalla. */
  label: string;
  tone?: 'neutral' | 'primary' | 'danger' | 'lime';
  size?: number;
  filled?: boolean;
}) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const fg = {
    neutral: c.text,
    primary: c.primaryText,
    danger: c.error,
    lime: c.limeText,
  }[tone];

  const bg = {
    neutral: c.surface,
    primary: c.primarySoft,
    danger: c.errorSoft,
    lime: c.limeSoft,
  }[tone];

  return (
    <Animated.View style={animated}>
      <Pressable
        onPress={() => { tap('light'); onPress(); }}
        onPressIn={() => { scale.value = withSpring(0.9, { damping: 16, stiffness: 450 }); }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 13, stiffness: 380 }); }}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: tone === 'neutral' ? c.border : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={size >= 44 ? 'lg' : 'md'} color={fg} fill={filled ? fg : undefined} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: BorderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  full: { width: '100%' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flexShrink: 1,
  },
  shrink: { flexShrink: 1 },
  trailing: {
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: BorderRadius.sm,
    marginLeft: Spacing.sm,
  },
});
