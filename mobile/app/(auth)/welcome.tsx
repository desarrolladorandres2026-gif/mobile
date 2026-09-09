import { useRef, useState } from 'react';
import {
  View, ScrollView, StyleSheet, useWindowDimensions,
  type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Text, Button } from '../../components/ui';
import { ZippWordmark } from '../../components/brand/ZippLogo';
import { OnboardingArt, type ArtName } from '../../components/brand/OnboardingArt';
import { usePrefsStore } from '../../stores/prefsStore';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, palette } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

interface Slide {
  art: ArtName;
  title: string;
  body: string;
}

/**
 * Tres pantallas, tres promesas.
 *
 * Ninguna vende funciones: cada una responde una duda real de alguien que
 * todavía no confía en pedir por una app. Qué hay, cuánto cuesta, y qué pasa
 * después de que pago.
 */
const SLIDES: Slide[] = [
  {
    art: 'pueblo',
    title: 'Tu pueblo entero,\nen tu bolsillo',
    body: 'Restaurantes, droguerías, cafés y mercados del pueblo. Los mismos de siempre, ahora sin salir de casa.',
  },
  {
    art: 'precio',
    title: 'El precio,\nantes de pagar',
    body: 'El envío se calcula por la distancia real hasta tu puerta. Ves el desglose completo y decides. Nunca cobramos algo distinto a lo que te mostramos.',
  },
  {
    art: 'ruta',
    title: 'Míralo venir,\npaso a paso',
    body: 'Sabes cuándo el local lo acepta, cuándo sale y quién te lo lleva. Y si algo se demora, te enteras primero.',
  },
];

export default function WelcomeScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const completeOnboarding = usePrefsStore((s) => s.completeOnboarding);

  // El primer arranque nunca está autenticado. Si hay sesión, esta pantalla
  // se abrió desde Ajustes → "Ver la introducción otra vez": es una vista
  // previa, no un embudo de registro.
  const isReplay = useAuthStore((s) => s.isAuthenticated);

  const [index, setIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const isLast = index === SLIDES.length - 1;

  /**
   * Salida de la intro cuando se abre desde Ajustes, con sesión ya iniciada.
   *
   * No se llama a `completeOnboarding()` —ya está en true— ni se navega a
   * ninguna ruta de `(auth)`: terminar en login o registro le hacía sentir
   * al usuario que le habían cerrado la sesión, aunque `authStore` no se
   * toque en ningún momento.
   *
   * `replace` y no `push` para que la intro no quede en el historial detrás
   * de la app: volver atrás desde Inicio debe salir, no reabrir la
   * introducción.
   */
  const exitReplay = () => {
    tap('light');
    router.replace('/(client)/(tabs)/home');
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== index) {
      setIndex(next);
      tap('select');
    }
  };

  const advance = () => {
    if (isLast) {
      if (isReplay) return exitReplay();
      completeOnboarding();
      router.replace('/(auth)/register');
      return;
    }
    scrollRef.current?.scrollTo({ x: (index + 1) * width, animated: true });
  };

  const skip = () => {
    if (isReplay) return exitReplay();
    completeOnboarding();
    router.replace('/(auth)/login');
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      <View style={styles.top}>
        <ZippWordmark size={26} color={c.text} />
        <Button
          title={isReplay ? 'Cerrar' : 'Saltar'}
          variant="ghost"
          size="sm"
          onPress={skip}
          haptic="light"
        />
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={styles.pager}
      >
        {SLIDES.map((slide, i) => (
          <View key={slide.art} style={[styles.slide, { width }]}>
            <Animated.View entering={FadeIn.delay(i === 0 ? 120 : 0).duration(500)}>
              <OnboardingArt name={slide.art} width={Math.min(width - Spacing.huge * 2, 300)} />
            </Animated.View>

            <Animated.View
              entering={FadeInDown.delay(i === 0 ? 260 : 0).duration(480)}
              style={styles.copy}
            >
              <Text v="displayL">{slide.title}</Text>
              <Text v="bodyL" tone="textSecondary">{slide.body}</Text>
            </Animated.View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.bottom}>
        {/* El punto activo se estira: el trazo, otra vez, marcando dónde estás. */}
        <View style={styles.dots} accessibilityRole="tablist">
          {SLIDES.map((slide, i) => (
            <View
              key={slide.art}
              style={[
                styles.dot,
                {
                  width: i === index ? 26 : 7,
                  backgroundColor: i === index ? palette.lima500 : c.border,
                },
              ]}
            />
          ))}
        </View>

        {isReplay ? (
          <Button
            title={isLast ? 'Listo' : 'Siguiente'}
            iconRight={isLast ? undefined : 'adelante'}
            size="lg"
            full
            onPress={advance}
            haptic={isLast ? 'medium' : 'light'}
          />
        ) : (
          <>
            <Button
              title={isLast ? 'Crear mi cuenta' : 'Siguiente'}
              iconRight={isLast ? undefined : 'adelante'}
              size="lg"
              full
              onPress={advance}
              haptic={isLast ? 'medium' : 'light'}
            />

            <Button
              title="Ya tengo cuenta"
              variant="ghost"
              full
              onPress={() => { completeOnboarding(); router.replace('/(auth)/login'); }}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  pager: { flex: 1 },
  slide: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.huge,
  },
  copy: { gap: Spacing.md },
  bottom: {
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.lg,
    gap: Spacing.md,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs + 2,
    marginBottom: Spacing.lg,
  },
  dot: { height: 7, borderRadius: BorderRadius.full },
});
