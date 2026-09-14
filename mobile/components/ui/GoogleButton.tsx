import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Text } from './Text';
import { TrazoLoader } from '../brand/Trazo';
import { BorderRadius, Shadow, Size } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
      <Path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
      <Path fill="#4CAF50" d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.5c-2 1.5-4.6 2.4-7.5 2.4-5.3 0-9.7-3.1-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <Path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.5 5.5C40.9 36.6 44 30.9 44 24c0-1.3-.1-2.7-.4-3.5z" />
    </Svg>
  );
}

/**
 * Alterna al botón primario para el inicio de sesión con Google. No usa el
 * sistema de iconos interno (`IconName`) porque el logo de Google es una
 * marca con colores fijos, no un ícono temático de la app.
 */
export function GoogleButton({
  onPress,
  loading,
  disabled,
  full,
  style,
}: {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const inert = disabled || loading;
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[full && styles.full, animated, style]}>
      <Pressable
        onPress={() => {
          if (inert) return;
          tap('light');
          onPress();
        }}
        onPressIn={() => { if (!inert) scale.value = withSpring(0.965, { damping: 18, stiffness: 420 }); }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 15, stiffness: 380 }); }}
        disabled={inert}
        accessibilityRole="button"
        accessibilityLabel="Continuar con Google"
        accessibilityState={{ disabled: !!inert, busy: !!loading }}
        style={[
          styles.base,
          {
            height: Size.buttonLg,
            backgroundColor: c.white,
            borderColor: 'rgba(8, 11, 17, 0.14)',
            opacity: disabled ? 0.42 : 1,
          },
          !disabled && Shadow.none,
        ]}
      >
        {loading ? (
          <TrazoLoader width={56} color={c.primaryText} />
        ) : (
          <>
            <GoogleG size={20} />
            <Text v="buttonLg" color={c.textOnPrimary}>Continuar con Google</Text>
          </>
        )}
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
    gap: 10,
    borderWidth: 1.5,
  },
  full: { width: '100%' },
});
