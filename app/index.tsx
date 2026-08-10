import { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';
import { Text } from '../components/ui';
import { ZippMarkDrawing } from '../components/brand/ZippLogo';
import { useAuthStore } from '../stores/authStore';
import { usePrefsStore } from '../stores/prefsStore';
import { useTheme } from '../hooks/useTheme';
import { Spacing, palette } from '../theme/tokens';

/** Lo que dura el trazo dibujándose, más un respiro para leer la marca. */
const HOLD_MS = 1700;

/**
 * Apertura.
 *
 * La marca se dibuja sola: el mismo trazo que después recorre el seguimiento
 * del pedido. Es lo primero que se ve de Zipp y lo último que queda.
 */
export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, user } = useAuthStore();
  const onboardingSeen = usePrefsStore((s) => s.onboardingSeen);
  const { c } = useTheme();

  useEffect(() => {
    const timer = setTimeout(() => {
      // Las cuentas de administrador y comercio no operan desde el móvil.
      if (isAuthenticated && user) {
        if (user.role === 'admin' || user.role === 'business') {
          useAuthStore.getState().logout();
          router.replace('/(auth)/login');
        } else if (!user.isVerified) {
          router.replace('/(auth)/otp');
        } else if (user.role === 'driver') {
          router.replace('/(driver)/(tabs)/dashboard');
        } else {
          router.replace('/(client)/(tabs)/home');
        }
        return;
      }

      router.replace(onboardingSeen ? '/(auth)/login' : '/(auth)/welcome');
    }, HOLD_MS);

    return () => clearTimeout(timer);
  }, [isAuthenticated, user, onboardingSeen]);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ZippMarkDrawing size={104} />

      <Animated.View entering={FadeInUp.delay(760).duration(420)} style={styles.words}>
        <Text v="displayXL" style={styles.wordmark}>zipp</Text>
        <Text v="bodyM" tone="textSecondary">Tu pueblo, a domicilio</Text>
      </Animated.View>

      <Animated.View entering={FadeIn.delay(1100).duration(400)} style={styles.footer}>
        <View style={[styles.dot, { backgroundColor: palette.lima500 }]} />
        <Text v="dataS" tone="textMuted">GARZÓN · HUILA</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  words: { alignItems: 'center', marginTop: Spacing.lg, gap: Spacing.xs },
  wordmark: { letterSpacing: -2 },
  footer: {
    position: 'absolute',
    bottom: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});
