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
import { SectionHeader } from '../ui/Surface';
import { CatalogBadge } from '../ui/Badge';
import { useTheme } from '../../hooks/useTheme';
import { useProductsByCategory } from '../../hooks/useApi';
import { discountPercent } from '../../lib/catalog';
import { businessAccent } from '../../lib/business';
import { money, minutes } from '../../lib/format';
import { tap } from '../../lib/haptics';
import {
  productImageUri, productImagePlaceholder, hasProductImage, type WithProductImage,
} from '../../lib/productImage';
import { BorderRadius, Motion, Shadow, Spacing } from '../../theme/tokens';

interface CategoryProduct extends WithProductImage {
  _id: string;
  name: string;
  price: number;
  discountPrice?: number | null;
  businessId: { _id: string; name: string; rating?: number; deliveryTime?: number } | string;
}

// ──────────────────────────────────────────────────────────────
// Geometría — idéntica a la del carrusel de banners del inicio.
// ──────────────────────────────────────────────────────────────

function geometry(width: number) {
  const cardWidth = Math.min(width * 0.92, 380);
  return {
    cardWidth,
    cardHeight: Math.round(cardWidth * 0.58),
    offsetX: cardWidth * 0.56,
  };
}

const SIDE = { scale: 0.14, rotateY: 16, rotateZ: 3, fade: 0.45 } as const;
const WRAP = { out: 150, in: 250 } as const;

/** Cada producto queda al frente este tiempo antes de avanzar solo. */
const AUTO_ADVANCE_MS = 4500;

// ──────────────────────────────────────────────────────────────
// Carrusel
// ──────────────────────────────────────────────────────────────

/**
 * El mismo carrusel de "Banners de Inicio" (`PromoCarousel`), pero mostrando
 * productos de una categoría en vez de promociones editoriales.
 *
 * Se intercala cada dos negocios en el home. Igual que su original: si no
 * hay nada que mostrar —categoría sin productos, sin conexión, todas las
 * fotos rotas— devuelve `null` y no deja hueco.
 */
export const CategoryProductCarousel = memo(function CategoryProductCarousel({
  category,
}: { category: { key: string; label: string } }) {
  const { c } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { data: products, isLoading } = useProductsByCategory(category.key);

  const { cardWidth, cardHeight, offsetX } = useMemo(() => geometry(width), [width]);

  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const markBroken = useCallback((id: string) => {
    setBrokenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const visible = useMemo(
    () => ((products ?? []) as CategoryProduct[]).filter((p) => !brokenIds.includes(p._id)),
    [products, brokenIds]
  );

  const [active, setActive] = useState(0);
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

  useEffect(() => {
    if (visible.length < 2) return;
    const timer = setTimeout(() => go(1), AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [index, visible.length, go]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-10, 10])
        .onEnd((e) => {
          if (e.translationX < -40) runOnJS(go)(1);
          else if (e.translationX > 40) runOnJS(go)(-1);
        }),
    [go]
  );

  const goToProduct = useCallback((product: CategoryProduct) => {
    const businessId = typeof product.businessId === 'string' ? product.businessId : product.businessId._id;
    router.push({
      pathname: '/(client)/business/[id]',
      params: { id: businessId, productId: product._id },
    });
  }, [router]);

  const press = useCallback(
    (product: CategoryProduct, rel: number, position: number) => {
      if (rel !== 0) {
        focus(position);
        return;
      }
      tap('medium');
      goToProduct(product);
    },
    [focus, goToProduct]
  );

  if (!isLoading && visible.length === 0) return null;
  if (isLoading) return null;

  return (
    // `marginHorizontal` negativo: el negocio de arriba vive dentro de una
    // sección con relleno lateral, pero este carrusel necesita el mismo
    // sangrado a los bordes que `PromoCarousel` en la parte alta del home
    // —es lo que deja asomar los laterales— así que rompe ese relleno y lo
    // vuelve a poner solo en el título.
    <Animated.View entering={FadeIn.duration(Motion.base)} style={styles.section}>
      <View style={styles.header}>
        <SectionHeader title={category.label} subtitle="Para ti, cerca de ti" />
      </View>

      <GestureDetector gesture={swipe}>
        <View style={[styles.stage, { height: cardHeight + Spacing.lg }]}>
          {visible.map((product, i) => (
            <ProductCard
              key={product._id}
              product={product}
              rel={relativeSlot(i, index, visible.length)}
              width={cardWidth}
              height={cardHeight}
              offsetX={offsetX}
              onPress={(rel) => press(product, rel, i)}
              onBroken={markBroken}
            />
          ))}
        </View>
      </GestureDetector>

      {visible.length > 1 ? (
        <View style={styles.dots}>
          {visible.map((product, i) => (
            <Pressable
              key={product._id}
              onPress={() => focus(i)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Ver producto ${i + 1} de ${visible.length}`}
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
});

function relativeSlot(i: number, active: number, total: number): number {
  const raw = ((i - active) % total + total) % total;
  return raw > total / 2 ? raw - total : raw;
}

// ──────────────────────────────────────────────────────────────
// Tarjeta
// ──────────────────────────────────────────────────────────────

interface CardProps {
  product: CategoryProduct;
  rel: number;
  width: number;
  height: number;
  offsetX: number;
  onPress: (rel: number) => void;
  onBroken: (id: string) => void;
}

const ProductCard = memo(function ProductCard({
  product, rel, width, height, offsetX, onPress, onBroken,
}: CardProps) {
  const { c } = useTheme();
  const businessName = typeof product.businessId === 'string' ? '' : product.businessId.name;
  const businessRating = typeof product.businessId === 'string' ? undefined : product.businessId.rating;
  const businessDeliveryTime = typeof product.businessId === 'string' ? undefined : product.businessId.deliveryTime;
  const businessId = typeof product.businessId === 'string' ? product.businessId : product.businessId._id;
  const accent = businessAccent(businessId);
  const pct = discountPercent(product);

  const slot = useSharedValue(rel);
  const opacity = useSharedValue(targetOpacity(rel));
  const previous = useRef(rel);

  useEffect(() => {
    const from = previous.current;
    previous.current = rel;
    if (from === rel) return;

    const target = targetOpacity(rel);

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
  const hasImage = hasProductImage(product);

  return (
    <Animated.View
      style={[
        styles.card,
        {
          width, height, marginLeft: -width / 2, backgroundColor: c.surface,
          zIndex: 10 - Math.abs(rel),
        },
        front ? Shadow.goldGlow : Shadow.sm,
        animated,
      ]}
      pointerEvents={Math.abs(rel) > 1 ? 'none' : 'auto'}
      accessibilityElementsHidden={!front}
      importantForAccessibility={front ? 'yes' : 'no-hide-descendants'}
    >
      <Pressable
        onPress={() => onPress(rel)}
        style={StyleSheet.absoluteFill}
        accessibilityRole={front ? 'button' : 'image'}
        accessibilityLabel={`${product.name}, ${businessName}, ${money(product.discountPrice ?? product.price)}`}
        accessibilityHint={front ? 'Abre este producto en su negocio' : 'Trae este producto al frente'}
      >
        {hasImage ? (
          <Image
            source={{ uri: productImageUri(product, 'detail')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={product._id}
            transition={Motion.base}
            onError={() => onBroken(product._id)}
            accessible={false}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: accent }]} />
        )}

        {pct ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${pct}%`} />
          </View>
        ) : null}

        <LinearGradient
          colors={['transparent', 'rgba(8,11,20,0.55)', 'rgba(8,11,20,0.92)']}
          locations={[0.25, 0.6, 1]}
          style={styles.scrim}
        >
          <Text v="titleM" color="#FFFFFF" numberOfLines={1}>{product.name}</Text>
          {businessName ? (
            <View style={styles.businessRow}>
              <Text v="bodyS" color="rgba(255,255,255,0.84)" numberOfLines={1}>{businessName}</Text>
              {/* Calificación del comercio: no existe una por producto, así
                  que es la misma nota que se ve en su ficha. */}
              <View style={styles.rating}>
                <Icon name="calificacion" size={11} color={c.warning} />
                <Text v="caption" color="rgba(255,255,255,0.84)">{(businessRating ?? 0).toFixed(1)}</Text>
              </View>
              {businessDeliveryTime ? (
                <View style={styles.rating}>
                  <Icon name="domiciliario" size={11} color="#FFFFFF" />
                  <Text v="captionStrong" color="#FFFFFF">{minutes(businessDeliveryTime)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          <View style={[styles.cta, { backgroundColor: c.warning }]}>
            <Text v="strongS" color={c.black} numberOfLines={1}>
              {money(product.discountPrice ?? product.price)}
            </Text>
            <Icon name="adelante" size={14} color={c.black} />
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
});

function targetOpacity(rel: number): number {
  if (Math.abs(rel) > 1) return 0;
  return 1 - Math.abs(rel) * SIDE.fade;
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, marginHorizontal: -Spacing.xl },
  header: { paddingHorizontal: Spacing.xl },

  stage: {
    justifyContent: 'center',
    marginTop: Spacing.md,
  },
  card: {
    position: 'absolute',
    left: '50%',
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
  },

  ribbon: { position: 'absolute', top: Spacing.md, left: Spacing.md },

  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.md,
    gap: 2,
  },
  businessRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 3 },
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
