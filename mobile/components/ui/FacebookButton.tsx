import { Pressable, StyleSheet, ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text } from './Text';
import { BorderRadius, Size } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

function FacebookF({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#FFFFFF"
        d="M22 12.06C22 6.51 17.52 2 12 2S2 6.51 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.89h2.78l-.44 2.91h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94Z"
      />
    </Svg>
  );
}

/**
 * "Continuar con Facebook".
 *
 * Solo se monta cuando hay App ID de Meta (ver `lib/facebookAuth.ts`): un
 * botón que no lleva a ninguna parte es peor que no tenerlo. Mientras
 * carga, el texto se cambia por un indicador y no admite otro toque.
 */
export function FacebookButton({
  onPress,
  loading,
  full,
  pill,
  style,
}: {
  onPress: () => void;
  loading?: boolean;
  full?: boolean;
  /** Esquinas redondeadas al máximo (forma de píldora) en vez del radio estándar. */
  pill?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={() => {
        if (loading) return;
        tap('light');
        onPress();
      }}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel="Continuar con Facebook"
      accessibilityState={{ busy: !!loading }}
      style={({ pressed }) => [
        full && styles.full,
        styles.base,
        pill && { borderRadius: Size.buttonLg / 2 },
        pressed && !loading && { opacity: 0.85 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <>
          <FacebookF size={20} />
          <Text v="buttonLg" color="#FFFFFF">Continuar con Facebook</Text>
        </>
      )}
    </Pressable>
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
    // El azul de marca de Facebook.
    backgroundColor: '#1877F2',
  },
  full: { width: '100%' },
});
