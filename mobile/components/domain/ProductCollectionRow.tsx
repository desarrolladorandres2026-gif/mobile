import { memo, useCallback, useEffect, useState, type ComponentType } from 'react';
import { View, Pressable, FlatList, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming, withDelay, Easing,
} from 'react-native-reanimated';
import { Text, Icon } from '../ui';
import { CatalogBadge, Badge } from '../ui/Badge';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent } from '../../lib/business';
import { BusinessTile, formatDistance, type Business } from './BusinessCard';
import { money } from '../../lib/format';
import { tap } from '../../lib/haptics';
import {
  productImageUri, productImagePlaceholder, hasProductImage,
} from '../../lib/productImage';
import {
  contentIllustration, categoryIllustration, DefaultIllustration, type IllustrationProps,
} from '../illustrations';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import type { HomeSection, HomeSectionProduct } from '../../services/endpoints';

const CARD_WIDTH = 148;

/**
 * Icono de cada colección.
 *
 * Sin emojis: mini-ilustraciones propias, el mismo sistema que ya usan
 * Categorías y los estados vacíos — nunca un glifo de Lucide suelto. Las de
 * categoría de negocio (`categoryIllustration`) encajan mejor en las
 * secciones de comida por franja (antojo, desayuno, noche); el resto sale
 * del registro de "contenido". `dulce`/`bebida`/`etiqueta`/`corona`/
 * `tendencia`/`hielo` son las seis que no tenían equivalente y se sumaron a
 * `contentIllustrations.ts` siguiendo exactamente el mismo patrón visual.
 */
const SECTION_ILLUSTRATION: Record<string, ComponentType<IllustrationProps>> = {
  losMasPedidos: contentIllustration('racha'),
  pideYRepite: contentIllustration('calificacion'),
  descuentosLocos: contentIllustration('cupon'),
  antojoDelDia: categoryIllustration('fast_food'),
  paraCompartir: contentIllustration('paquete'),
  algoDulce: contentIllustration('dulce'),
  paraEmpezarElDia: categoryIllustration('cafe'),
  paraLaNoche: categoryIllustration('restaurant'),
  algoParaTomar: contentIllustration('bebida'),
  buenoYBarato: contentIllustration('efectivo'),
  listoParaPedir: contentIllustration('domiciliario'),
  recienLlegados: contentIllustration('notificaciones'),
  favoritosZipp: contentIllustration('favorito'),
  estaEnTendencia: contentIllustration('tendencia'),
  favoritosCiudad: contentIllustration('trofeo'),
  cercaDeTi: contentIllustration('ubicacion'),
  combosQueValenLaPena: contentIllustration('regalo'),
  porMenosDe10000: contentIllustration('etiqueta'),
  dateUnGusto: contentIllustration('corona'),
  refrescaElDia: contentIllustration('hielo'),
};

/**
 * Una colección dinámica del inicio: "Los más pedidos", "Descuentos
 * locos"… — un carrusel horizontal simple, no el coverflow de
 * `CategoryProductCarousel`.
 *
 * Ese carrusel está pensado para "un producto destacado a la vez" dentro de
 * una sola categoría; estas veinte secciones mezclan comercios y necesitan
 * enseñar varias tarjetas a la vez para que "mezcla" se note de un vistazo,
 * así que la pieza que se parece es `MenuPreviewItem` (`BusinessCard.tsx`),
 * no el carrusel 3D.
 */
export const ProductCollectionRow = memo(function ProductCollectionRow({
  section,
}: { section: HomeSection }) {
  const router = useRouter();

  const goToProduct = useCallback((product: HomeSectionProduct) => {
    tap('medium');
    router.push({
      pathname: '/(client)/business/[id]',
      params: { id: product.businessId, productId: product._id },
    });
  }, [router]);

  if (section.products.length === 0) return null;

  const Illustration = SECTION_ILLUSTRATION[section.key] ?? DefaultIllustration;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <AnimatedIcon Illustration={Illustration} />
        <View style={styles.headerTitles}>
          <Text v="titleL">{section.title}</Text>
          {section.subtitle ? <Text v="bodyS" tone="textMuted">{section.subtitle}</Text> : null}
        </View>
      </View>
      <FlatList
        horizontal
        data={section.products}
        keyExtractor={(item) => item._id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.hList}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={9}
        initialNumToRender={6}
        renderItem={({ item }) => <DiscoveryCard product={item} onPress={() => goToProduct(item)} />}
      />
    </View>
  );
});

/**
 * El "respiro" sutil de la mini-ilustración: mismo patrón de escala que ya
 * usa `SosButton` (`withRepeat(withSequence(...), -1, false)`), no una
 * animación nueva. Corre en el hilo de UI, así que un icono de 28pt no
 * cuesta nada de rendimiento aunque haya veinte en pantalla.
 */
const AnimatedIcon = memo(function AnimatedIcon({
  Illustration,
}: { Illustration: ComponentType<IllustrationProps> }) {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );
  }, [scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={style}>
      <Illustration size={40} />
    </Animated.View>
  );
});

const DiscoveryCard = memo(function DiscoveryCard({
  product, onPress,
}: { product: HomeSectionProduct; onPress: () => void }) {
  const { c } = useTheme();
  const router = useRouter();
  const [broken, setBroken] = useState(false);
  const accent = businessAccent(product.businessId);
  const hasDiscount = product.discountPercent > 0;
  const distance = formatDistance(product.distanceMeters);

  // Identidad del comercio, resuelta con lo que ya trae cada producto —
  // nunca una segunda consulta: los productos vienen mezclados de varios
  // negocios, así que este bloque es lo que le dice al cliente de dónde
  // sale cada uno.
  const business: Business = {
    _id: product.businessId,
    name: product.businessName,
    category: product.businessCategory,
    rating: product.businessRating,
    deliveryTime: product.businessDeliveryTime,
    logo: product.businessLogo,
  };

  const goToBusiness = useCallback(() => {
    tap('light');
    router.push(`/(client)/business/${product.businessId}`);
  }, [router, product.businessId]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
    >
      <View style={[styles.image, { backgroundColor: c.surfaceLight }]}>
        {hasProductImage(product) && !broken ? (
          <Image
            source={{ uri: productImageUri(product, 'catalog')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={product._id}
            onError={() => setBroken(true)}
            accessible={false}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: accent }]} />
        )}

        {hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : distance ? (
          <View style={styles.ribbon}>
            <Badge label={distance} tone="neutral" icon="ubicacion" style={{ backgroundColor: c.surface }} />
          </View>
        ) : null}

        {/* El botón flotante "+" de Rappi: invita a sumar el plato sin abrir
            la ficha primero. Lleva al mismo sitio que el resto de la
            tarjeta — un plato con modificadores no se resuelve en un toque —
            pero la promesa visual es la que hace que la tira invite. */}
        <View style={[styles.add, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="sm" color={c.textOnPrimary} />
        </View>
      </View>

      <View style={styles.body}>
        {/* Identidad del comercio: aro con logo (o su ilustración de
            categoría si no tiene) + nombre. Toque propio hacia el perfil
            del negocio, distinto del toque del resto de la tarjeta —
            funciona porque es un `Pressable` anidado: RN entrega el toque
            al que está más adentro. */}
        <Pressable
          onPress={goToBusiness}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Ver el perfil de ${product.businessName}`}
          style={styles.businessRow}
        >
          <BusinessTile business={business} size={16} radius={8} />
          <Text v="caption" tone="textMuted" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
          {/* Calificación del comercio: no existe una por producto (solo
              `Business.rating` en el modelo), así que es la misma nota que
              se ve en su ficha — no un número inventado para la tarjeta. */}
          {product.businessRating > 0 ? (
            <View style={styles.rating}>
              <Icon name="calificacion" size={11} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          ) : null}
        </Pressable>

        <Text v="bodyS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.priceRow}>
          <Text v="dataS" tone="primaryText" style={styles.priceStrong}>
            {money(product.effectivePrice)}
          </Text>
          {hasDiscount ? (
            <>
              <Text v="caption" tone="textMuted" style={styles.strike}>{money(product.price)}</Text>
              <Text v="captionStrong" tone="limeText">-{product.discountPercent}%</Text>
            </>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  headerTitles: { flex: 1 },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },

  card: {
    width: CARD_WIDTH,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  image: { width: CARD_WIDTH, height: 110 },
  ribbon: { position: 'absolute', top: Spacing.xs, left: Spacing.xs },
  add: {
    position: 'absolute', bottom: Spacing.xs, right: Spacing.xs,
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },

  body: { padding: Spacing.sm, gap: 3 },
  businessRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 1 },
  businessName: { flex: 1 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  name: { minHeight: 34 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.xs, marginTop: 2 },
  priceStrong: { fontWeight: '700' },
  strike: { textDecorationLine: 'line-through' },
});
