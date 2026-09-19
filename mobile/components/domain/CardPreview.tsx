import { useEffect } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeIn, FadeInDown, FadeOut, ZoomIn,
  interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { Text } from '../ui';
import { CardBrandLogo } from '../brand/CardBrandLogo';
import { cardNumberSlots, detectBrand, type CardBrand, type CardFormValues } from '../../lib/card';
import { BorderRadius, Motion, Spacing } from '../../theme/tokens';
import { FontFamily } from '../../theme/typography';

export type CardField = keyof CardFormValues;

/**
 * La tarjeta que se va armando mientras se escribe.
 *
 * Es un espejo de los campos, nada más: no guarda estado propio salvo la
 * animación del volteo. Cada dígito entra con su propia animación, el color
 * del plástico cambia al reconocer la marca por el BIN y, al enfocar el
 * código, gira para mostrar el reverso (salvo American Express, que lo
 * lleva impreso al frente).
 *
 * Es decorativa para los lectores de pantalla: lo mismo ya lo dicen los
 * campos, y leerlo dos veces solo estorba.
 */
interface Props {
  values: CardFormValues;
  /** Campo con el foco, para resaltar su zona en la tarjeta. */
  focused: CardField | null;
}

const PLASTIC: Record<CardBrand, readonly [string, string]> = {
  UNKNOWN: ['#17171B', '#34343C'],
  VISA: ['#141B6B', '#2F46B8'],
  MASTERCARD: ['#1B1B1F', '#4A3426'],
  AMEX: ['#0B5F7E', '#1FA2C4'],
  DINERS: ['#343A46', '#707A8C'],
};

const WHITE = '#FFFFFF';
const WHITE_SOFT = 'rgba(255,255,255,0.62)';
const WHITE_GHOST = 'rgba(255,255,255,0.38)';

export function CardPreview({ values, focused }: Props) {
  const brand = detectBrand(values.number);
  const reduceMotion = useReducedMotion();
  const groups = cardNumberSlots(values.number);
  const cvcOnFront = brand === 'AMEX';
  const showBack = focused === 'cvc' && !cvcOnFront;

  const turn = useSharedValue(0);
  useEffect(() => {
    turn.value = withTiming(showBack ? 180 : 0, { duration: reduceMotion ? 0 : Motion.slow });
  }, [showBack, reduceMotion, turn]);

  // La cara que no mira a la persona se apaga en los 90°: `backfaceVisibility`
  // solo no basta en todos los Android.
  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1000 }, { rotateY: `${turn.value}deg` }],
    opacity: interpolate(turn.value, [89, 91], [1, 0], 'clamp'),
  }));
  const backStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1000 }, { rotateY: `${turn.value - 180}deg` }],
    opacity: interpolate(turn.value, [89, 91], [0, 1], 'clamp'),
  }));

  const holder = values.holder.trim().toUpperCase();
  const [mm = '', yy = ''] = values.expiry.split('/');
  const cvcDots = '•'.repeat(values.cvc.length).padEnd(cvcOnFront ? 4 : 3, '·');

  return (
    <View
      style={styles.stage}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* ── Frente ── */}
      <Animated.View style={[styles.face, frontStyle]}>
        <Plastic brand={brand} />

        <View style={styles.topRow}>
          <Chip />
          <Animated.View key={brand} entering={ZoomIn.duration(Motion.base)} style={styles.logo}>
            {brand === 'UNKNOWN' ? (
              <Text v="strongS" color={WHITE_GHOST}>TARJETA</Text>
            ) : (
              <CardBrandLogo brand={brand} height={brand === 'VISA' ? 22 : 30} />
            )}
          </Animated.View>
        </View>

        {cvcOnFront ? (
          <View style={[styles.amexCvc, zone(focused === 'cvc')]}>
            <Text style={styles.cvcText} color={WHITE}>{cvcDots}</Text>
          </View>
        ) : null}

        <View style={[styles.numberRow, zone(focused === 'number')]}>
          {groups.map((group, g) => (
            <View key={g} style={styles.group}>
              {group.map((slot, i) =>
                slot.filled ? (
                  <Animated.Text
                    key={`${i}-${slot.char}`}
                    entering={FadeInDown.duration(Motion.fast)}
                    style={[styles.digit, { color: WHITE }]}
                  >
                    {slot.char}
                  </Animated.Text>
                ) : (
                  <Animated.Text key={`${i}-empty`} entering={FadeIn} style={[styles.digit, { color: WHITE_GHOST }]}>
                    {slot.char}
                  </Animated.Text>
                ),
              )}
            </View>
          ))}
        </View>

        <View style={styles.bottomRow}>
          <View style={[styles.flex, zone(focused === 'holder')]}>
            <Text style={styles.caption} color={WHITE_SOFT}>TITULAR</Text>
            <Text style={styles.value} color={holder ? WHITE : WHITE_GHOST} numberOfLines={1}>
              {holder || 'NOMBRE Y APELLIDO'}
            </Text>
          </View>
          <View style={zone(focused === 'expiry')}>
            <Text style={styles.caption} color={WHITE_SOFT}>VENCE</Text>
            <Text style={styles.value} color={WHITE}>
              <Text color={mm ? WHITE : WHITE_GHOST}>{mm.padEnd(2, '•')}</Text>
              <Text color={WHITE_SOFT}>/</Text>
              <Text color={yy ? WHITE : WHITE_GHOST}>{yy.padEnd(2, '•')}</Text>
            </Text>
          </View>
        </View>
      </Animated.View>

      {/* ── Reverso ── */}
      <Animated.View style={[styles.face, styles.back, backStyle]}>
        <Plastic brand={brand} />
        <View style={styles.stripe} />
        <View style={styles.signatureRow}>
          <View style={styles.signature} />
          <View style={styles.cvcBox}>
            <Text style={styles.cvcText} color="#1B1B1F">{cvcDots}</Text>
          </View>
        </View>
        <Text style={[styles.caption, styles.cvcHint]} color={WHITE_SOFT}>CÓDIGO DE SEGURIDAD</Text>
        <View style={styles.backLogo}>
          <CardBrandLogo brand={brand} height={brand === 'VISA' ? 16 : 22} />
        </View>
      </Animated.View>
    </View>
  );
}

/** Fondo del plástico. Al cambiar de marca el nuevo color entra fundido sobre el anterior. */
function Plastic({ brand }: { brand: CardBrand }) {
  return (
    <>
      <LinearGradient colors={PLASTIC.UNKNOWN} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {brand !== 'UNKNOWN' ? (
        <Animated.View key={brand} entering={FadeIn.duration(Motion.slow)} exiting={FadeOut.duration(Motion.base)} style={StyleSheet.absoluteFill}>
          <LinearGradient colors={PLASTIC[brand]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      ) : null}
      {/* Brillo diagonal, para que se lea como plástico y no como un rectángulo plano. */}
      <LinearGradient
        colors={['rgba(255,255,255,0.14)', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.7, y: 0.6 }}
        style={StyleSheet.absoluteFill}
      />
    </>
  );
}

function Chip() {
  return (
    <LinearGradient colors={['#F3CE72', '#B88214']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.chip}>
      <View style={styles.chipLineH} />
      <View style={styles.chipLineV} />
    </LinearGradient>
  );
}

/** Marco suave alrededor de la zona que se está escribiendo. */
function zone(active: boolean): ViewStyle {
  return {
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderColor: active ? 'rgba(255,255,255,0.55)' : 'transparent',
    paddingHorizontal: 6,
    paddingVertical: 3,
  };
}

const styles = StyleSheet.create({
  stage: { width: '100%', maxWidth: 360, aspectRatio: 1.586, alignSelf: 'center' },
  face: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    padding: Spacing.lg,
    justifyContent: 'space-between',
    backfaceVisibility: 'hidden',
  },
  back: { paddingHorizontal: 0, justifyContent: 'flex-start' },
  flex: { flex: 1 },

  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { minHeight: 30, justifyContent: 'center' },
  chip: { width: 42, height: 32, borderRadius: 6, justifyContent: 'center', alignItems: 'center' },
  chipLineH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  chipLineV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(0,0,0,0.25)' },

  numberRow: { flexDirection: 'row', gap: 10, alignSelf: 'flex-start', marginLeft: -6 },
  group: { flexDirection: 'row' },
  digit: { fontFamily: FontFamily.dataBold, fontSize: 19, width: 12, textAlign: 'center' },

  bottomRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.md, marginHorizontal: -6 },
  caption: { fontFamily: FontFamily.semibold, fontSize: 9, letterSpacing: 1 },
  value: { fontFamily: FontFamily.dataBold, fontSize: 14, letterSpacing: 0.5, marginTop: 2 },

  amexCvc: { position: 'absolute', right: Spacing.lg - 6, top: '42%' },
  cvcText: { fontFamily: FontFamily.dataBold, fontSize: 15, letterSpacing: 2 },

  stripe: { height: 44, marginTop: Spacing.xl, backgroundColor: '#0B0B0D' },
  signatureRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.lg, marginHorizontal: Spacing.lg },
  signature: { flex: 1, height: 34, backgroundColor: 'rgba(255,255,255,0.85)', borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },
  cvcBox: {
    height: 34, paddingHorizontal: Spacing.md, justifyContent: 'center',
    backgroundColor: WHITE, borderTopRightRadius: 4, borderBottomRightRadius: 4,
  },
  cvcHint: { alignSelf: 'flex-end', marginTop: 6, marginRight: Spacing.lg },
  backLogo: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg },
});
