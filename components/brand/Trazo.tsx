import { useEffect } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedProps,
  withTiming, withRepeat, withDelay, Easing,
} from 'react-native-reanimated';
import { palette, Motion, BorderRadius } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// ──────────────────────────────────────────────────────────────
// Indicador de carga
// ──────────────────────────────────────────────────────────────

/**
 * Un segmento lima que cruza la pista de izquierda a derecha, en bucle.
 *
 * Reemplaza al spinner del sistema. Un círculo girando comunica "espera"; un
 * segmento disparado de lado a lado comunica "va rápido", que es lo que Zipp
 * quiere que sientas mientras carga.
 */
export function TrazoLoader({
  width = 96,
  color,
  style,
}: { width?: number; color?: string; style?: ViewStyle }) {
  const { c } = useTheme();
  const x = useSharedValue(-0.45);

  useEffect(() => {
    x.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.cubic) }),
      -1,
      false
    );
  }, []);

  const segment = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value * width }],
  }));

  return (
    <View
      style={[styles.track, { width, backgroundColor: c.border }, style]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Cargando"
    >
      <Animated.View
        style={[
          styles.segment,
          { width: width * 0.45, backgroundColor: color ?? palette.lima500 },
          segment,
        ]}
      />
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Divisor
// ──────────────────────────────────────────────────────────────

/**
 * Separador de secciones con un quiebre en el centro: el trazo, en pequeño.
 * Es el detalle que hace que una lista larga siga sintiéndose de Zipp.
 */
export function TrazoDivider({ color }: { color?: string }) {
  const { c } = useTheme();
  return (
    <Svg width="100%" height={10} viewBox="0 0 200 10" accessible={false}>
      <Path
        d="M0 5 H86 L94 1 L106 9 L114 5 H200"
        stroke={color ?? c.border}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

// ──────────────────────────────────────────────────────────────
// Ruta del pedido
// ──────────────────────────────────────────────────────────────

/** Ruta en tres curvas: del negocio (arriba izquierda) a tu casa (abajo derecha). */
const ROUTE = 'M12 20 C56 20 60 52 100 52 C144 52 150 18 194 18 C236 18 244 52 288 52';
const ROUTE_LENGTH = 300;
const VB_W = 300;
const VB_H = 72;

/** Los tres tramos cúbicos de la ruta, para poder ubicar al domiciliario. */
const SEGMENTS = [
  [12, 20, 56, 20, 60, 52, 100, 52],
  [100, 52, 144, 52, 150, 18, 194, 18],
  [194, 18, 236, 18, 244, 52, 288, 52],
] as const;

/**
 * Punto sobre la ruta para un avance de 0 a 1.
 *
 * Corre como worklet en el hilo de UI para que el domiciliario se deslice a
 * 60fps sin pasar por JavaScript en cada cuadro.
 */
function pointOnRoute(p: number): { x: number; y: number } {
  'worklet';
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const scaled = clamped * 3;
  const i = scaled >= 3 ? 2 : Math.floor(scaled);
  const t = scaled - i;
  const s = SEGMENTS[i];

  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const cc = 3 * u * t * t;
  const d = t * t * t;

  return {
    x: a * s[0] + b * s[2] + cc * s[4] + d * s[6],
    y: a * s[1] + b * s[3] + cc * s[5] + d * s[7],
  };
}

export interface TrazoRutaProps {
  /** Avance del pedido, de 0 a 1. */
  progress: number;
  width: number;
  /** Detiene la animación del marcador cuando el pedido ya terminó. */
  settled?: boolean;
}

/**
 * La ruta del pedido dibujándose.
 *
 * No es un mapa y no pretende serlo: no tenemos posición GPS del domiciliario
 * en vivo, así que fingir un mapa sería mentir sobre la precisión. Lo que sí
 * es cierto es en qué punto del recorrido va el pedido, y eso es lo que
 * muestra: el tramo recorrido en lima, lo que falta apagado.
 */
export function TrazoRuta({ progress, width, settled }: TrazoRutaProps) {
  const { c } = useTheme();
  const height = (width / VB_W) * VB_H;
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = withTiming(progress, { duration: Motion.slow, easing: Easing.inOut(Easing.cubic) });
  }, [progress]);

  const drawn = useAnimatedProps(() => ({
    strokeDashoffset: ROUTE_LENGTH * (1 - p.value),
  }));

  const marker = useAnimatedStyle(() => {
    const pt = pointOnRoute(p.value);
    const scale = width / VB_W;
    return {
      transform: [
        { translateX: pt.x * scale - 7 },
        { translateY: pt.y * scale - 7 },
      ],
    };
  });

  const pulse = useSharedValue(1);
  useEffect(() => {
    if (settled) {
      pulse.value = withTiming(1);
      return;
    }
    pulse.value = withRepeat(
      withTiming(1.9, { duration: 1100, easing: Easing.out(Easing.quad) }),
      -1,
      false
    );
  }, [settled]);

  const halo = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: 1 - (pulse.value - 1) / 0.9,
  }));

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height} viewBox={`0 0 ${VB_W} ${VB_H}`} accessible={false}>
        {/* Lo que falta por recorrer */}
        <Path
          d={ROUTE}
          stroke={c.border}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          strokeDasharray="1 9"
        />
        {/* Lo ya recorrido */}
        <AnimatedPath
          d={ROUTE}
          stroke={palette.lima500}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={ROUTE_LENGTH}
          animatedProps={drawn}
        />
        {/* Origen: el negocio */}
        <Circle cx={12} cy={20} r={5} fill={c.surface} stroke={palette.lima500} strokeWidth={3} />
        {/* Destino: tu casa */}
        <Circle cx={288} cy={52} r={5} fill={c.surface} stroke={c.borderStrong} strokeWidth={3} />
      </Svg>

      {/* Domiciliario. Late mientras el pedido sigue en movimiento. */}
      <Animated.View style={[styles.markerWrap, marker]} pointerEvents="none">
        <Animated.View style={[styles.markerHalo, halo]} />
        <View style={styles.markerDot} />
      </Animated.View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Conector vertical del stepper
// ──────────────────────────────────────────────────────────────

/** Tramo entre dos pasos del seguimiento. Se llena de lima al completarse. */
export function TrazoConnector({ done, animate }: { done: boolean; animate?: boolean }) {
  const { c } = useTheme();
  const fill = useSharedValue(done ? 1 : 0);

  useEffect(() => {
    fill.value = withDelay(
      animate ? 120 : 0,
      withTiming(done ? 1 : 0, { duration: Motion.base })
    );
  }, [done]);

  const style = useAnimatedStyle(() => ({ height: `${fill.value * 100}%` }));

  return (
    <View style={[styles.connector, { backgroundColor: c.border }]}>
      <Animated.View style={[styles.connectorFill, style]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: BorderRadius.full,
    overflow: 'hidden',
  },
  segment: {
    height: '100%',
    borderRadius: BorderRadius.full,
  },
  markerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerHalo: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: palette.lima500,
    opacity: 0.35,
  },
  markerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.lima500,
    borderWidth: 2.5,
    borderColor: palette.ink800,
  },
  connector: {
    width: 2.5,
    flex: 1,
    borderRadius: 2,
    marginVertical: 4,
    overflow: 'hidden',
  },
  connectorFill: {
    width: '100%',
    backgroundColor: palette.lima500,
    borderRadius: 2,
  },
});
