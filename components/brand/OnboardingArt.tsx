import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect, Circle, G } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, withRepeat, withTiming, withDelay, Easing,
} from 'react-native-reanimated';
import { palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

export type ArtName = 'pueblo' | 'precio' | 'ruta';

/**
 * Ilustraciones del onboarding.
 *
 * Construidas con el mismo vocabulario que el resto de la marca —rectángulos
 * redondeados, un trazo continuo y un punto lima de destino— en vez de
 * ilustración figurativa. Pesan casi nada, se ven nítidas en cualquier
 * densidad de pantalla y se repintan solas al cambiar de tema.
 */
export function OnboardingArt({ name, width }: { name: ArtName; width: number }) {
  const height = width * 0.72;
  return (
    <View style={{ width, height }} accessible={false}>
      {name === 'pueblo' ? <ArtPueblo width={width} height={height} /> : null}
      {name === 'precio' ? <ArtPrecio width={width} height={height} /> : null}
      {name === 'ruta' ? <ArtRuta width={width} height={height} /> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// 1 · El pueblo entero, conectado por un trazo
// ──────────────────────────────────────────────────────────────

const WEAVE = 'M22 118 C60 118 52 62 96 62 C140 62 132 30 178 30';
const WEAVE_LEN = 210;

function ArtPueblo({ width, height }: { width: number; height: number }) {
  const { c } = useTheme();
  const draw = useSharedValue(WEAVE_LEN);

  useEffect(() => {
    draw.value = withDelay(220, withTiming(0, { duration: 1100, easing: Easing.out(Easing.cubic) }));
  }, []);

  const traced = useAnimatedProps(() => ({ strokeDashoffset: draw.value }));

  return (
    <Svg width={width} height={height} viewBox="0 0 200 144">
      {/* Los negocios del pueblo */}
      <Rect x={8} y={104} width={28} height={28} rx={9} fill={c.surfaceLight} />
      <Rect x={48} y={86} width={28} height={28} rx={9} fill={c.surfaceLight} />
      <Rect x={82} y={48} width={28} height={28} rx={9} fill={palette.zipp500} />
      <Rect x={122} y={70} width={28} height={28} rx={9} fill={c.surfaceLight} />
      <Rect x={148} y={16} width={28} height={28} rx={9} fill={palette.mango500} />
      <Rect x={112} y={112} width={28} height={28} rx={9} fill={c.surfaceLight} />

      <AnimatedPath
        d={WEAVE}
        stroke={palette.lima500}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={WEAVE_LEN}
        animatedProps={traced}
      />
      <Circle cx={178} cy={30} r={6} fill={palette.lima500} />
    </Svg>
  );
}

// ──────────────────────────────────────────────────────────────
// 2 · El desglose antes de pagar
// ──────────────────────────────────────────────────────────────

function ArtPrecio({ width, height }: { width: number; height: number }) {
  const { c } = useTheme();
  const pulse = useSharedValue(0.55);

  useEffect(() => {
    pulse.value = withDelay(
      420,
      withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }), -1, true)
    );
  }, []);

  // El total late suave: es el número que la pantalla quiere que mires.
  const totalGlow = useAnimatedProps(() => ({ opacity: pulse.value }));

  return (
    <Svg width={width} height={height} viewBox="0 0 200 144">
      <Rect x={30} y={10} width={140} height={124} rx={16} fill={c.surface} stroke={c.border} strokeWidth={2} />

      {/* Renglones del desglose */}
      <G opacity={0.9}>
        <Rect x={48} y={32} width={48} height={7} rx={3.5} fill={c.borderStrong} />
        <Rect x={126} y={32} width={26} height={7} rx={3.5} fill={c.textMuted} />

        <Rect x={48} y={52} width={62} height={7} rx={3.5} fill={c.borderStrong} />
        <Rect x={130} y={52} width={22} height={7} rx={3.5} fill={c.textMuted} />

        <Rect x={48} y={72} width={40} height={7} rx={3.5} fill={c.borderStrong} />
        <Rect x={124} y={72} width={28} height={7} rx={3.5} fill={palette.lima500} />
      </G>

      <Rect x={48} y={92} width={104} height={1.5} rx={1} fill={c.border} />

      {/* El total, que es lo único que se resalta */}
      <Rect x={48} y={104} width={34} height={12} rx={6} fill={c.textMuted} />
      <AnimatedRect
        x={104} y={100} width={48} height={20} rx={10}
        fill={palette.zipp500}
        animatedProps={totalGlow}
      />
    </Svg>
  );
}

// ──────────────────────────────────────────────────────────────
// 3 · El pedido en camino
// ──────────────────────────────────────────────────────────────

const TRACK = 'M26 106 C68 106 62 44 108 44 C146 44 148 92 176 92';
const TRACK_LEN = 190;

function ArtRuta({ width, height }: { width: number; height: number }) {
  const { c } = useTheme();
  const draw = useSharedValue(TRACK_LEN);

  useEffect(() => {
    draw.value = withRepeat(
      withDelay(300, withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.cubic) })),
      -1,
      false
    );
  }, []);

  const traced = useAnimatedProps(() => ({ strokeDashoffset: draw.value }));

  return (
    <Svg width={width} height={height} viewBox="0 0 200 144">
      {/* Recorrido pendiente */}
      <Path
        d={TRACK}
        stroke={c.border}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
        strokeDasharray="1 10"
      />
      {/* Recorrido hecho */}
      <AnimatedPath
        d={TRACK}
        stroke={palette.lima500}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={TRACK_LEN}
        animatedProps={traced}
      />

      {/* El local */}
      <Rect x={8} y={88} width={36} height={36} rx={12} fill={palette.zipp500} />
      <Rect x={18} y={100} width={16} height={4} rx={2} fill={palette.paper0} />
      <Rect x={18} y={109} width={11} height={4} rx={2} fill="rgba(255,255,255,0.55)" />

      {/* Tu casa */}
      <Rect x={158} y={74} width={36} height={36} rx={12} fill={c.surfaceLight} stroke={palette.lima500} strokeWidth={2.5} />
      <Path d="M168 94 L176 86 L184 94 L184 102 L168 102 Z" fill={palette.lima500} />
    </Svg>
  );
}
