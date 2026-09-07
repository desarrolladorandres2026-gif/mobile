import { useEffect } from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, useAnimatedStyle,
  withTiming, withDelay, withSpring, Easing,
} from 'react-native-reanimated';
import { palette, Motion, Spacing } from '../../theme/tokens';
import { Type } from '../../theme/typography';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * La Z de Zipp es una ruta, no una letra.
 *
 * Un trazo continuo sale arriba a la izquierda —el negocio— baja en diagonal
 * y termina en un punto lima abajo a la derecha: el destino, que eres tú. Por
 * eso el trazo va en azul (Zipp haciendo el trabajo) y el punto en lima (lo
 * que recibes). El mismo gesto reaparece dibujándose en el splash, girando
 * como indicador de carga y trazando la ruta en el seguimiento.
 */
const Z_PATH = 'M12 13 H36 L12 35 H36';

/** Largo real del trazo, para animar el dibujado con dasharray. */
const Z_LENGTH = 81;

export interface ZippMarkProps {
  size?: number;
  /** Color del trazo. Por defecto el azul de marca. */
  stroke?: string;
  /** Color del punto de destino. Por defecto lima. */
  dot?: string;
  /** Todo de un solo color, para contextos monocromos. */
  mono?: string;
}

export function ZippMark({ size = 40, stroke, dot, mono }: ZippMarkProps) {
  const strokeColor = mono ?? stroke ?? palette.gold400;
  const dotColor = mono ?? dot ?? palette.gold300;

  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessible={false}>
      <Path
        d={Z_PATH}
        stroke={strokeColor}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={36} cy={35} r={5} fill={dotColor} />
    </Svg>
  );
}

/**
 * La marca dibujándose sola. Se usa en el splash y al confirmar un pedido:
 * el trazo se traza, y solo cuando llega, el destino aparece de golpe.
 */
export function ZippMarkDrawing({
  size = 88,
  stroke = palette.gold400,
  dot = palette.gold300,
  delay = 0,
}: ZippMarkProps & { delay?: number }) {
  const progress = useSharedValue(Z_LENGTH);
  const dotScale = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withTiming(0, { duration: Motion.trace, easing: Easing.out(Easing.cubic) })
    );
    dotScale.value = withDelay(
      delay + Motion.trace - 80,
      withSpring(1, { damping: 9, stiffness: 220 })
    );
  }, [delay]);

  const pathProps = useAnimatedProps(() => ({ strokeDashoffset: progress.value }));
  const dotStyle = useAnimatedStyle(() => ({ transform: [{ scale: dotScale.value }] }));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 48 48" accessible={false}>
        <AnimatedPath
          d={Z_PATH}
          stroke={stroke}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={Z_LENGTH}
          animatedProps={pathProps}
        />
      </Svg>
      {/* El punto se monta encima para poder animarlo con transform. */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: (36 / 48) * size - (5 / 48) * size,
            top: (35 / 48) * size - (5 / 48) * size,
            width: (10 / 48) * size,
            height: (10 / 48) * size,
            borderRadius: (5 / 48) * size,
            backgroundColor: dot,
          },
          dotStyle,
        ]}
      />
    </View>
  );
}

export interface ZippWordmarkProps {
  size?: number;
  /** Color del texto. El trazo mantiene siempre los colores de marca. */
  color?: string;
  mono?: string;
  showMark?: boolean;
  useCrown?: boolean;
}

/** Logotipo oficial ZIPP con coronita en oro cepillado de alta gama. */
export function ZippWordmark({
  size = 32,
  showMark = false,
  useCrown = true,
}: ZippWordmarkProps) {
  if (useCrown) {
    const logoHeight = size * 1.1;
    const logoWidth = logoHeight * 0.92;
    return (
      <View style={styles.wordmark} accessibilityRole="header">
        {showMark && <ZippMark size={size} />}
        <Image
          source={require('../../assets/zipp-crown-logo.png')}
          style={{ width: logoWidth, height: logoHeight }}
          resizeMode="contain"
        />
      </View>
    );
  }

  const logoHeight = size * 0.78;
  const logoWidth = (logoHeight * 374) / 131;

  return (
    <View style={styles.wordmark} accessibilityRole="header">
      {showMark && <ZippMark size={size} />}
      <Image
        source={require('../../assets/zipp-gold-logo.png')}
        style={{ width: logoWidth, height: logoHeight }}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wordmark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
});
