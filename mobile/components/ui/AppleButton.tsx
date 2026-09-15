import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Text } from './Text';
import { TrazoLoader } from '../brand/Trazo';
import { BorderRadius, Shadow, Size } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

function AppleLogo({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#FFFFFF"
        d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.652.95 3.562.95.865 0 2.222-1.01 3.87-1.01.63 0 2.99.06 4.53 2.29-.12.08-2.705 1.58-2.705 4.84 0 3.75 3.29 5.07 3.19 5.7z"
      />
    </Svg>
  );
}

/**
 * Botón de "Continuar con Apple". No usa el sistema de iconos interno
 * (`IconName`) por lo mismo que `GoogleG` en `GoogleButton`: el logo de
 * Apple es una marca con forma fija, no un ícono temático de la app.
 *
 * `onPress` puede llegar `undefined` mientras `isConfigured` (ver
 * `useAppleAuth`) sea falso — el Services ID de Apple todavía no existe.
 * En ese caso el botón se deshabilita solo, igual que `GoogleButton` cuando
 * `googleConfigured` es falso.
 */
export function AppleButton({
  onPress,
  loading,
  disabled,
  full,
  pill,
  style,
}: {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  /** Esquinas redondeadas al máximo (forma de píldora) en vez del radio estándar. */
  pill?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
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
        accessibilityLabel="Continuar con Apple"
        accessibilityState={{ disabled: !!inert, busy: !!loading }}
        style={[
          styles.base,
          {
            borderRadius: pill ? Size.buttonLg / 2 : BorderRadius.lg,
            opacity: disabled ? 0.42 : 1,
          },
          !disabled && Shadow.none,
        ]}
      >
        {loading ? (
          <TrazoLoader width={56} color="#FFFFFF" />
        ) : (
          <>
            <AppleLogo size={20} />
            <Text v="buttonLg" color="#FFFFFF">Continuar con Apple</Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    height: Size.buttonLg,
    borderRadius: BorderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#000000',
  },
  full: { width: '100%' },
});
