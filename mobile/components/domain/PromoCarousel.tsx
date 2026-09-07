import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence,
  Easing, runOnJS, FadeIn,
} from 'react-native-reanimated';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useHomeBanners } from '../../hooks/useApi';
import { hasAction, runBannerAction } from '../../lib/bannerAction';
import { tap } from '../../lib/haptics';
import type { PromoBanner } from '../../services/endpoints';
import { BorderRadius, Motion, Shadow, Spacing } from '../../theme/tokens';

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
function geometry(width: number) {
  const cardWidth = Math.min(width * 0.7, 300);
  return {
    cardWidth,
    cardHeight: Math.round(cardWidth * 0.58),
    /** Cuánto se aparta del centro cada lateral. Deja ~55pt asomando. */
    offsetX: cardWidth * 0.56,
  };
}

/** Cuánto encoge y se inclina un lateral. Suficiente para dar fondo, sin deformar. */
const SIDE = { scale: 0.14, rotateY: 16, rotateZ: 3, fade: 0.45 } as const;

/** Mitades del cruce cuando una tarjeta salta de un extremo al otro. */
const WRAP = { out: 150, in: 250 } as const;

// ──────────────────────────────────────────────────────────────
// Carrusel
// ──────────────────────────────────────────────────────────────

/**
 * Promociones de la pantalla inicial.
 *
 * No decide nada sobre qué se muestra: pinta, en orden, lo que el servidor
 * ya resolvió que está vigente. Si no hay nada que pintar —lista vacía, sin
 * conexión, API caída, todas las imágenes rotas— devuelve `null` y la
 * sección de Categorías sube sola, sin hueco.
 */
export function PromoCarousel() {
  const { c } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { data: banners, isLoading } = useHomeBanners();

  const { cardWidth, cardHeight, offsetX } = useMemo(() => geometry(width), [width]);

  // Una imagen que no carga saca a su banner del carrusel en vez de dejar
  // un rectángulo vacío rotando. Se guarda por id, no por índice: si el
  // admin borra un banner mientras la app está abierta, los índices se
  // corren y el fallo se pegaría al banner equivocado.
  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const markBroken = useCallback((id: string) => {
    setBrokenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const visible = useMemo(
    () => (banners ?? []).filter((b) => !brokenIds.includes(b.id)),
    [banners, brokenIds]
  );

  const [active, setActive] = useState(0);
  // Acotado en cada render: la lista puede encoger entre dos vueltas del
  // temporizador y `active` quedaría apuntando fuera del arreglo.
  const index = visible.length ? active % visible.length : 0;

  const go = useCallback((delta: number) => {
    setActive((prev) => {
      const total = visible.length;
      if (total < 2) return prev;
      return (((prev + delta) % total) + total) % total;
    });
  }, [visible.length]);

  const focus = useCallback((target: number) => {
    tap('light');
    setActive(target);
  }, []);

  // Avance automático. Cada banner trae su propia duración desde el panel,
  // así que el temporizador se rearma con la del banner que está al frente.
  useEffect(() => {
    if (visible.length < 2) return;
    const seconds = visible[index]?.durationSeconds ?? 5;
    const timer = setTimeout(() => go(1), seconds * 1000);
    return () => clearTimeout(timer);
  }, [index, visible, go]);

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
    (banner: PromoBanner, rel: number, position: number) => {
      // Un lateral primero se trae al frente: tocar media tarjeta y que se
      // abra algo que no se alcanza a ver es la forma más rápida de que el
      // cliente desconfíe del carrusel.
      if (rel !== 0) {
        focus(position);
        return;
      }
      if (!hasAction(banner)) return;
      tap('medium');
      runBannerAction(banner, router);
    },
    [focus, router]
  );

  if (isLoading) return <PromoSkeleton cardWidth={cardWidth} cardHeight={cardHeight} offsetX={offsetX} />;
  if (visible.length === 0) return null;

  return (
    <Animated.View entering={FadeIn.duration(Motion.base)} style={styles.section}>
      <GestureDetector gesture={swipe}>
        <View style={[styles.stage, { height: cardHeight + Spacing.lg }]}>
          {visible.map((banner, i) => (
            <BannerCard
              key={banner.id}
              banner={banner}
              rel={relativeSlot(i, index, visible.length)}
              width={cardWidth}
              height={cardHeight}
              offsetX={offsetX}
              onPress={(rel) => press(banner, rel, i)}
              onBroken={markBroken}
            />
          ))}
        </View>
      </GestureDetector>

      {visible.length > 1 ? (
        <View style={styles.dots}>
          {visible.map((banner, i) => (
            <Pressable
              key={banner.id}
              onPress={() => focus(i)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Ver promoción ${i + 1} de ${visible.length}`}
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
    </Animated.View>
  );
}

/**
 * Posición de una tarjeta respecto al frente: 0 al centro, -1 izquierda,
 * +1 derecha. Con más de tres banners los demás se apilan detrás del
 * lateral que les toca y se ocultan; la composición sigue siendo de tres.
 */
function relativeSlot(i: number, active: number, total: number): number {
  const raw = ((i - active) % total + total) % total;
  return raw > total / 2 ? raw - total : raw;
}

// ──────────────────────────────────────────────────────────────
// Tarjeta
// ──────────────────────────────────────────────────────────────

interface CardProps {
  banner: PromoBanner;
  rel: number;
  width: number;
  height: number;
  offsetX: number;
  onPress: (rel: number) => void;
  onBroken: (id: string) => void;
}

const BannerCard = memo(function BannerCard({
  banner, rel, width, height, offsetX, onPress, onBroken,
}: CardProps) {
  const { c } = useTheme();

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
  const tappable = front ? hasAction(banner) : true;
  const hasCaption = !!(banner.title || banner.description || banner.buttonText);

  return (
    <Animated.View
      style={[
        styles.card,
        {
          width, height, marginLeft: -width / 2, backgroundColor: c.surface,
          // Vistas absolutas y hermanas: sin esto, React Native las apila
          // por orden de la lista, no por cuál está al frente, y una lateral
          // termina tapando a la protagonista. La que va llegando al centro
          // siempre debe montarse encima de las demás.
          zIndex: 10 - Math.abs(rel),
        },
        front ? Shadow.goldGlow : Shadow.sm,
        animated,
      ]}
      // La de atrás nunca debe robarle el toque a la de adelante.
      pointerEvents={Math.abs(rel) > 1 ? 'none' : 'auto'}
      // El lector de pantalla solo anuncia la protagonista: leer tres
      // promociones seguidas convierte la pantalla inicial en un muro.
      accessibilityElementsHidden={!front}
      importantForAccessibility={front ? 'yes' : 'no-hide-descendants'}
    >
      <Pressable
        onPress={() => onPress(rel)}
        disabled={!tappable}
        style={StyleSheet.absoluteFill}
        accessibilityRole={front && hasAction(banner) ? 'button' : 'image'}
        accessibilityLabel={banner.title || 'Promoción de Zipp'}
        accessibilityHint={
          front
            ? hasAction(banner)
              ? banner.buttonText || 'Abre la promoción'
              : undefined
            : 'Trae esta promoción al frente'
        }
      >
        <Image
          source={{ uri: banner.imageUrl }}
          style={StyleSheet.absoluteFill}
          // La imagen llena la tarjeta sin deformarse, venga vertical,
          // cuadrada o panorámica desde el panel.
          contentFit="cover"
          // Memoria y disco: la misma promoción no se vuelve a descargar en
          // cada arranque ni en cada vuelta del carrusel.
          cachePolicy="memory-disk"
          recyclingKey={banner.id}
          transition={Motion.base}
          onError={() => onBroken(banner.id)}
          accessible={false}
        />

        {hasCaption ? (
          <LinearGradient
            colors={['transparent', 'rgba(8,11,20,0.55)', 'rgba(8,11,20,0.92)']}
            locations={[0.25, 0.6, 1]}
            style={styles.scrim}
          >
            {banner.title ? (
              <Text v="titleM" color="#FFFFFF" numberOfLines={1}>{banner.title}</Text>
            ) : null}
            {banner.description ? (
              <Text v="bodyS" color="rgba(255,255,255,0.84)" numberOfLines={1}>
                {banner.description}
              </Text>
            ) : null}
            {banner.buttonText ? (
              <View style={[styles.cta, { backgroundColor: c.warning }]}>
                <Text v="strongS" color={c.black} numberOfLines={1}>{banner.buttonText}</Text>
                <Icon name="adelante" size={14} color={c.black} />
              </View>
            ) : null}
          </LinearGradient>
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

/** Los laterales se atenúan; lo que queda detrás desaparece del todo. */
function targetOpacity(rel: number): number {
  if (Math.abs(rel) > 1) return 0;
  return 1 - Math.abs(rel) * SIDE.fade;
}

// ──────────────────────────────────────────────────────────────
// Carga
// ──────────────────────────────────────────────────────────────

/**
 * Fantasma con la misma composición del carrusel.
 *
 * Ocupa exactamente el alto que ocupará el contenido, así que cuando los
 * banners llegan nada salta hacia abajo. Si al final no hay ninguno, el
 * espacio se cierra de una vez y Categorías sube.
 */
function PromoSkeleton({
  cardWidth, cardHeight, offsetX,
}: { cardWidth: number; cardHeight: number; offsetX: number }) {
  const { c } = useTheme();
  const pulse = useSharedValue(0.45);

  useEffect(() => {
    pulse.value = withTiming(0.75, { duration: 850, easing: Easing.inOut(Easing.quad) });
  }, []);

  const glow = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={styles.section}>
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
  section: { marginTop: Spacing.xxxl },

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

  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.md,
    gap: 2,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
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
