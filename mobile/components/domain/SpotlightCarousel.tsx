import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence,
  Easing, runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { BorderRadius, Motion, Shadow, Spacing } from '../../theme/tokens';
import { useIsFocused } from 'expo-router';

// ──────────────────────────────────────────────────────────────
// Geometría
// ──────────────────────────────────────────────────────────────

/**
 * Todo se deriva del ancho real del teléfono, no de puntos de corte.
 *
 * Un Moto E de 320pt y un iPhone Pro Max de 430pt tienen que dar la misma
 * composición —protagonista al centro, dos laterales asomando—, así que la
 * tarjeta es una fracción del ancho con un tope, y el desplazamiento
 * lateral es una fracción de la tarjeta. El tope evita que en una tablet
 * el carrusel se coma media pantalla.
 */
export function spotlightGeometry(width: number, aspect = 0.58, sizeScale = 1) {
  const cardWidth = Math.min(width * 0.92, 380) * sizeScale;
  return {
    cardWidth,
    cardHeight: Math.round(cardWidth * aspect),
    /** Cuánto se aparta del centro cada lateral. Deja ~55pt asomando. */
    offsetX: cardWidth * 0.56,
  };
}

/** Cuánto encoge y se inclina un lateral. Suficiente para dar fondo, sin deformar. */
const SIDE = { scale: 0.14, rotateY: 16, rotateZ: 3, fade: 0.45 } as const;

/** Mitades del cruce cuando una tarjeta salta de un extremo al otro. */
const WRAP = { out: 150, in: 250 } as const;

/** Los laterales se atenúan; lo que queda detrás desaparece del todo. */
function targetOpacity(rel: number): number {
  if (Math.abs(rel) > 1) return 0;
  return 1 - Math.abs(rel) * SIDE.fade;
}

/**
 * Posición de una tarjeta respecto al frente: 0 al centro, -1 izquierda,
 * +1 derecha. Con más de tres items los demás se apilan detrás del lateral
 * que les toca y se ocultan; la composición sigue siendo de tres.
 */
function relativeSlot(i: number, active: number, total: number): number {
  const raw = ((i - active) % total + total) % total;
  return raw > total / 2 ? raw - total : raw;
}

// ──────────────────────────────────────────────────────────────
// Carrusel genérico
// ──────────────────────────────────────────────────────────────

export interface SpotlightRenderOpts {
  /** `true` solo en la tarjeta protagonista (al centro). */
  front: boolean;
  /** Ancho/alto ya resueltos por la geometría compartida. */
  width: number;
  height: number;
}

export interface SpotlightCarouselProps<T> {
  items: T[];
  keyExtractor: (item: T) => string;
  renderCard: (item: T, opts: SpotlightRenderOpts) => ReactNode;
  /** Etiqueta de accesibilidad de cada item, para la protagonista y los puntos. */
  accessibilityLabel: (item: T) => string;
  /** Se dispara al tocar la protagonista. Un lateral primero se trae al frente. */
  onPressActive?: (item: T, index: number) => void;
  /** Relación alto/ancho de la tarjeta. Por defecto la de `PromoCarousel`. */
  aspect?: number;
  /** Segundos entre avances automáticos. Puede depender de la tarjeta al frente. */
  durationSeconds?: number | ((item: T) => number);
  /** Factor sobre el ancho base. 1 = tamaño del carrusel de promociones. */
  sizeScale?: number;
}

/**
 * Mecánica compartida del carrusel "protagonista al centro": geometría,
 * pila 3D, arrastre horizontal, avance automático, animación de cruce al
 * dar la vuelta y puntos de paginación. No sabe nada de lo que hay dentro
 * de cada tarjeta — eso lo decide `renderCard`.
 */
export function SpotlightCarousel<T>({
  items, keyExtractor, renderCard, accessibilityLabel, onPressActive,
  aspect = 0.58, durationSeconds = 5, sizeScale = 1,
}: SpotlightCarouselProps<T>) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const { cardWidth, cardHeight, offsetX } = useMemo(
    () => spotlightGeometry(width, aspect, sizeScale),
    [width, aspect, sizeScale]
  );

  const [active, setActive] = useState(0);
  // Acotado en cada render: la lista puede encoger entre dos vueltas del
  // temporizador y `active` quedaría apuntando fuera del arreglo.
  const index = items.length ? active % items.length : 0;

  const go = useCallback((delta: number) => {
    setActive((prev) => {
      const total = items.length;
      if (total < 2) return prev;
      return (((prev + delta) % total) + total) % total;
    });
  }, [items.length]);

  const focus = useCallback((target: number) => {
    tap('light');
    setActive(target);
  }, []);

  // Avance automático. Cada tarjeta puede traer su propia duración (ej. la
  // que configuró un admin por banner), así que el temporizador se rearma
  // con la del item que está al frente en vez de una fija para todo el carrusel.
  const seconds = typeof durationSeconds === 'function'
    ? durationSeconds(items[index])
    : durationSeconds;
  //
  // Solo con la pantalla a la vista: antes seguía rotando (y re-renderizando)
  // mientras el usuario estaba en otra pestaña o dentro de una tienda.
  const focused = useIsFocused();
  useEffect(() => {
    if (items.length < 2 || !focused) return;
    const timer = setTimeout(() => go(1), seconds * 1000);
    return () => clearTimeout(timer);
  }, [index, items.length, go, seconds, focused]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        // El carrusel vive dentro del scroll vertical de la pantalla: solo
        // reclama el gesto cuando el movimiento es claramente horizontal.
        .activeOffsetX([-14, 14])
        .failOffsetY([-10, 10])
        .onEnd((e) => {
          if (e.translationX < -40) runOnJS(go)(1);
          else if (e.translationX > 40) runOnJS(go)(-1);
        }),
    [go]
  );

  const press = useCallback(
    (item: T, rel: number, position: number) => {
      // Un lateral primero se trae al frente: tocar media tarjeta y que se
      // abra algo que no se alcanza a ver es la forma más rápida de que el
      // cliente desconfíe del carrusel.
      if (rel !== 0) {
        focus(position);
        return;
      }
      onPressActive?.(item, position);
    },
    [focus, onPressActive]
  );

  if (items.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={swipe}>
        <View style={[styles.stage, { height: cardHeight + Spacing.lg }]}>
          {items.map((item, i) => (
            <SpotlightSlot
              key={keyExtractor(item)}
              rel={relativeSlot(i, index, items.length)}
              width={cardWidth}
              height={cardHeight}
              offsetX={offsetX}
              label={accessibilityLabel(item)}
              onPress={(rel) => press(item, rel, i)}
            >
              {(opts) => renderCard(item, opts)}
            </SpotlightSlot>
          ))}
        </View>
      </GestureDetector>

      {items.length > 1 ? (
        <View style={styles.dots}>
          {items.map((item, i) => (
            <Pressable
              key={keyExtractor(item)}
              onPress={() => focus(i)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Ver ${accessibilityLabel(item)}, ${i + 1} de ${items.length}`}
              style={[
                styles.dot,
                i === index
                  ? { width: 18, backgroundColor: c.warning }
                  : { backgroundColor: c.borderStrong },
              ]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Slot animado (posición, opacidad, transform 3D)
// ──────────────────────────────────────────────────────────────

interface SlotProps {
  rel: number;
  width: number;
  height: number;
  offsetX: number;
  label: string;
  onPress: (rel: number) => void;
  children: (opts: SpotlightRenderOpts) => ReactNode;
}

const SpotlightSlot = memo(function SpotlightSlot({
  rel, width, height, offsetX, label, onPress, children,
}: SlotProps) {
  const slot = useSharedValue(rel);
  const opacity = useSharedValue(targetOpacity(rel));
  const previous = useRef(rel);

  useEffect(() => {
    const from = previous.current;
    previous.current = rel;
    if (from === rel) return;

    const target = targetOpacity(rel);

    // Un salto de más de una posición es la vuelta del carrusel: la tarjeta
    // que estaba a la izquierda tiene que reaparecer a la derecha. Cruzar la
    // pantalla por el medio se vería como un error, así que se disuelve,
    // salta con la opacidad en cero y vuelve a aparecer del otro lado.
    if (Math.abs(rel - from) > 1) {
      opacity.value = withSequence(
        withTiming(0, { duration: WRAP.out }),
        withTiming(target, { duration: WRAP.in })
      );
      slot.value = withDelay(WRAP.out, withTiming(rel, { duration: 1 }));
      return;
    }

    slot.value = withTiming(rel, { duration: Motion.slow, easing: Easing.out(Easing.cubic) });
    opacity.value = withTiming(target, { duration: Motion.base });
  }, [rel]);

  const animated = useAnimatedStyle(() => {
    // Más allá del primer lateral la tarjeta ya no se ve, pero su posición
    // se acota para que no salga volando fuera de la pantalla al girar.
    const p = Math.max(-1, Math.min(1, slot.value));
    return {
      opacity: opacity.value,
      transform: [
        { perspective: 900 },
        { translateX: p * offsetX },
        { rotateY: `${p * -SIDE.rotateY}deg` },
        { rotateZ: `${p * SIDE.rotateZ}deg` },
        { scale: 1 - Math.abs(p) * SIDE.scale },
      ],
    };
  });

  const front = rel === 0;

  return (
    <Animated.View
      style={[
        styles.card,
        {
          width, height, marginLeft: -width / 2,
          // Vistas absolutas y hermanas: sin esto, React Native las apila
          // por orden de la lista, no por cuál está al frente, y una lateral
          // termina tapando a la protagonista. La que va llegando al centro
          // siempre debe montarse encima de las demás.
          zIndex: 10 - Math.abs(rel),
        },
        front ? Shadow.md : Shadow.sm,
        animated,
      ]}
      // La de atrás nunca debe robarle el toque a la de adelante.
      pointerEvents={Math.abs(rel) > 1 ? 'none' : 'auto'}
      // El lector de pantalla solo anuncia la protagonista: leer varias
      // tarjetas seguidas convierte la pantalla inicial en un muro.
      accessibilityElementsHidden={!front}
      importantForAccessibility={front ? 'yes' : 'no-hide-descendants'}
    >
      <Pressable
        onPress={() => onPress(rel)}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={front ? undefined : 'Trae esta tarjeta al frente'}
      >
        {children({ front, width, height })}
      </Pressable>
    </Animated.View>
  );
});

// ──────────────────────────────────────────────────────────────
// Fantasma de carga
// ──────────────────────────────────────────────────────────────

/**
 * Composición fantasma con la misma pila 3D, para cuando el llamador todavía
 * está cargando datos. Ocupa exactamente el alto del carrusel real, así que
 * nada salta cuando los datos llegan.
 */
export function SpotlightSkeleton({ width, aspect = 0.58 }: { width: number; aspect?: number }) {
  const { c } = useTheme();
  const { cardWidth, cardHeight, offsetX } = useMemo(() => spotlightGeometry(width, aspect), [width, aspect]);
  const pulse = useSharedValue(0.45);

  useEffect(() => {
    pulse.value = withTiming(0.75, { duration: 850, easing: Easing.inOut(Easing.quad) });
  }, []);

  const glow = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={styles.wrap}>
      <View style={[styles.stage, { height: cardHeight + Spacing.lg }]}>
        {[-1, 1, 0].map((rel) => (
          <Animated.View
            key={rel}
            style={[
              styles.card,
              {
                width: cardWidth,
                height: cardHeight,
                marginLeft: -cardWidth / 2,
                backgroundColor: c.skeleton,
                zIndex: 10 - Math.abs(rel),
                transform: [
                  { translateX: rel * offsetX },
                  { scale: 1 - Math.abs(rel) * SIDE.scale },
                ],
              },
              rel === 0 ? glow : { opacity: targetOpacity(rel) },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},

  stage: {
    justifyContent: 'center',
    // Sin `overflow: hidden` a propósito. Los laterales se salen del ancho
    // útil —es lo que da la sensación de que el carrusel sigue más allá del
    // borde— y los recorta la pantalla, no este contenedor. Recortar aquí
    // también cortaría el halo de la tarjeta del frente.
  },
  card: {
    position: 'absolute',
    // Centrado por el punto medio: así `translateX` es la distancia real al
    // centro de la pantalla y no hay que compensar el ancho en cada cálculo.
    left: '50%',
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },

  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    marginTop: Spacing.md,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
