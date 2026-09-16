import { memo, useCallback, useState, type ComponentType } from 'react';
import { View, Pressable, FlatList, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { CatalogBadge, Badge } from '../ui/Badge';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent } from '../../lib/business';
import { BusinessTile, formatDistance, type Business } from './BusinessCard';
import { money, minutes } from '../../lib/format';
import { tap } from '../../lib/haptics';
import {
  productImageUri, productImagePlaceholder, hasProductImage,
} from '../../lib/productImage';
import {
  contentIllustration, categoryIllustration, DefaultIllustration, type IllustrationProps,
} from '../illustrations';
import { CollectionHeader, type HeaderVariant } from './CollectionHeader';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import type { HomeSection, HomeSectionDisplayVariant, HomeSectionProduct } from '../../services/endpoints';

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
 * Qué "vestido" de encabezado (`CollectionHeader.tsx`) usa cada colección.
 * Cliente-only, presentación pura — no toca `section.displayVariant`
 * (ese es el sistema de tarjeta, un asunto totalmente aparte).
 */
const HEADER_VARIANT: Record<string, HeaderVariant> = {
  losMasPedidos: 'editorial',
  pideYRepite: 'trend',
  descuentosLocos: 'commercial',
  antojoDelDia: 'illustrated',
  paraCompartir: 'minimal',
  algoDulce: 'illustrated',
  paraEmpezarElDia: 'illustrated',
  paraLaNoche: 'illustrated',
  algoParaTomar: 'illustrated',
  buenoYBarato: 'minimal',
  listoParaPedir: 'minimal',
  recienLlegados: 'numbered',
  favoritosZipp: 'featured',
  estaEnTendencia: 'trend',
  favoritosCiudad: 'featured',
  cercaDeTi: 'minimal',
  combosQueValenLaPena: 'commercial',
  porMenosDe10000: 'commercial',
  dateUnGusto: 'featured',
};

/**
 * Subtítulo de respaldo cuando el backend no manda `section.subtitle`. Solo
 * tres claves (`losMasPedidos`, `pideYRepite`, `estaEnTendencia`) traen
 * subtítulo real del servidor hoy — el resto usa este mapa, o queda sin
 * subtítulo si tampoco aparece aquí.
 */
const FALLBACK_SUBTITLE: Record<string, string> = {
  descuentosLocos: 'Precios que vuelan',
  antojoDelDia: 'Para el antojo de ahora',
  paraCompartir: 'Porque uno nunca pide solo',
  algoDulce: 'Para matar el antojo',
  paraEmpezarElDia: 'Arranca bien el día',
  paraLaNoche: 'Para cuando cae la noche',
  algoParaTomar: 'Algo fresco para acompañar',
  recienLlegados: 'Descubre lo nuevo en ZIPP',
  favoritosZipp: 'Nuestra selección',
  favoritosCiudad: 'Los mejor calificados',
  combosQueValenLaPena: 'Más por tu plata',
  dateUnGusto: 'Algo bueno para hoy',
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
 *
 * El servidor decide con qué tarjeta se pinta cada colección
 * (`section.displayVariant`) — este componente solo elige el renderer.
 */
export const ProductCollectionRow = memo(function ProductCollectionRow({
  section,
}: { section: HomeSection }) {
  const router = useRouter();
  const { c } = useTheme();

  const goToProduct = useCallback((product: HomeSectionProduct) => {
    tap('medium');
    router.push({
      pathname: '/(client)/business/[id]',
      params: { id: product.businessId, productId: product._id },
    });
  }, [router]);

  if (section.products.length === 0) return null;

  const variant = section.displayVariant ?? 'compact';
  const Illustration = SECTION_ILLUSTRATION[section.key] ?? DefaultIllustration;
  const CardComponent = CARD_BY_VARIANT[variant];
  const headerVariant = HEADER_VARIANT[section.key] ?? 'minimal';
  const subtitle = section.subtitle ?? FALLBACK_SUBTITLE[section.key];

  const list = (
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
      renderItem={({ item, index }) => (
        <CardComponent
          product={item}
          onPress={() => goToProduct(item)}
          emphasized={variant === 'featured' && section.key === 'favoritosZipp' && index === 0}
          rank={section.key === 'losMasPedidos' && index < 3 ? index + 1 : undefined}
        />
      )}
    />
  );

  return (
    <View style={styles.section}>
      <CollectionHeader
        variant={headerVariant}
        title={section.title}
        subtitle={subtitle}
        Illustration={Illustration}
      />

      {variant === 'banner' ? (
        <View style={[styles.bannerPanel, { backgroundColor: c.primarySoft, borderColor: c.primarySoftBorder }, Shadow.goldGlow]}>
          {list}
        </View>
      ) : list}
    </View>
  );
});

// ──────────────────────────────────────────────────────────────
// Bloque compartido: identidad del comercio (aro + nombre + toque propio)
// ──────────────────────────────────────────────────────────────

type CardProps = { product: HomeSectionProduct; onPress: () => void; emphasized?: boolean; rank?: number };

/** El producto solo, sin nada más en el carrito, ya alcanza el domicilio gratis del comercio. */
function hasFreeDelivery(product: HomeSectionProduct): boolean {
  return product.businessFreeDeliveryThreshold > 0 && product.effectivePrice >= product.businessFreeDeliveryThreshold;
}

function useBusinessNav(product: HomeSectionProduct) {
  const router = useRouter();
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
  return { business, goToBusiness };
}

/** Imagen del producto con el mismo patrón de carga/fallback en todas las variantes. */
function ProductPhoto({
  product, height, width, children,
}: { product: HomeSectionProduct; height: number; width?: number; children?: React.ReactNode }) {
  const { c } = useTheme();
  const [broken, setBroken] = useState(false);
  const accent = businessAccent(product.businessId);

  return (
    <View style={[styles.image, { height, width: width ?? '100%', backgroundColor: c.surfaceLight }]}>
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
      {children}
    </View>
  );
}

/**
 * El precio: solo lleva el fondo dorado cuando hay algo que celebrar —
 * descuento o que el producto solo ya alcanza el domicilio gratis del
 * comercio. Sin eso, es texto plano: el dorado se reserva para cuando
 * comunica una ventaja real, no como decoración de cada tarjeta.
 */
function PriceTag({
  product, size, alone,
}: { product: HomeSectionProduct; size: 'dataS' | 'dataM' | 'dataL'; alone?: boolean }) {
  const { c } = useTheme();
  const highlighted = product.discountPercent > 0 || hasFreeDelivery(product);

  if (!highlighted) {
    return (
      <Text v={size} tone="primaryText" style={[styles.priceStrong, alone ? styles.pricePillAlone : null]}>
        {money(product.effectivePrice)}
      </Text>
    );
  }

  return (
    <View style={[styles.pricePill, alone ? styles.pricePillAlone : null, { backgroundColor: c.gold }]}>
      <Text v={size} color={c.black} style={styles.priceStrong}>
        {money(product.effectivePrice)}
      </Text>
    </View>
  );
}

const CARD_WIDTH = 195;

/**
 * `compact`: la tarjeta original — descubrimiento barato, la que usan la
 * mayoría de las secciones.
 */
const CompactCard = memo(function CompactCard({ product, onPress }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;
  const distance = formatDistance(product.distanceMeters);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.card, { width: CARD_WIDTH, backgroundColor: c.surface, borderColor: c.border }]}
    >
      <ProductPhoto product={product} height={138}>
        {hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : distance ? (
          <View style={styles.ribbon}>
            <Badge label={distance} tone="neutral" icon="ubicacion" style={{ backgroundColor: c.surface }} />
          </View>
        ) : null}
        <View style={[styles.add, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="sm" color={c.textOnPrimary} />
        </View>
      </ProductPhoto>

      <View style={styles.body}>
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
        </Pressable>

        <Text v="bodyS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={11} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={11} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.priceRow}>
          <PriceTag product={product} size="dataS" />
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

const LARGE_WIDTH = 260;

/**
 * `large`: tarjeta hero para "Los más pedidos" — foto y datos más grandes.
 * Las tres primeras llevan un número de puesto (`rank`): es la colección con
 * más peso del inicio y el ranking lo deja claro de un vistazo, no solo el
 * tamaño de la tarjeta.
 */
const LargeCard = memo(function LargeCard({ product, onPress, rank }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;
  const distance = formatDistance(product.distanceMeters);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.card, { width: LARGE_WIDTH, backgroundColor: c.surface, borderColor: c.border }]}
    >
      <ProductPhoto product={product} height={195}>
        {rank ? (
          <View style={[styles.rankBadge, { backgroundColor: c.gold }, Shadow.goldGlow]}>
            <Text v="captionStrong" color={c.black}>#{rank}</Text>
          </View>
        ) : hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : distance ? (
          <View style={styles.ribbon}>
            <Badge label={distance} tone="neutral" icon="ubicacion" style={{ backgroundColor: c.surface }} />
          </View>
        ) : null}
        <View style={[styles.add, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="sm" color={c.textOnPrimary} />
        </View>
      </ProductPhoto>

      <View style={styles.body}>
        <Pressable
          onPress={goToBusiness}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Ver el perfil de ${product.businessName}`}
          style={styles.businessRow}
        >
          <BusinessTile business={business} size={24} radius={12} />
          <Text v="bodyM" tone="textMuted" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="titleS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={13} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={13} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.priceRow}>
          <PriceTag product={product} size="dataL" />
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

const HORIZONTAL_WIDTH = 400;

/** `horizontal`: la tarjeta se acuesta — foto cuadrada a la izquierda, datos a la derecha. */
const HorizontalCard = memo(function HorizontalCard({ product, onPress }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;
  const distance = formatDistance(product.distanceMeters);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.hCard, { width: HORIZONTAL_WIDTH, backgroundColor: c.surface, borderColor: c.border }]}
    >
      <ProductPhoto product={product} height={130} width={130}>
        {hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : null}
      </ProductPhoto>

      <View style={styles.hBody}>
        <Pressable
          onPress={goToBusiness}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Ver el perfil de ${product.businessName}`}
          style={styles.businessRow}
        >
          <BusinessTile business={business} size={18} radius={9} />
          <Text v="caption" tone="textMuted" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="bodyS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={12} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={12} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
          {distance ? (
            <View style={styles.rating}>
              <Icon name="ubicacion" size={12} color={c.textMuted} />
              <Text v="caption" tone="textMuted">{distance}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.priceRow}>
          <PriceTag product={product} size="dataS" />
          {hasDiscount ? (
            <Text v="caption" tone="textMuted" style={styles.strike}>{money(product.price)}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const FEATURED_WIDTH = 215;

/**
 * `featured`: la foto es la protagonista casi absoluta, mínimo texto
 * secundario. "ZIPP recomienda" (favoritosZipp) pide que se sienta curada:
 * la primera tarjeta lleva borde y halo dorados, sin volverse un banner.
 */
const FeaturedCard = memo(function FeaturedCard({ product, onPress, emphasized }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[
        styles.card,
        { width: FEATURED_WIDTH, backgroundColor: c.surface, borderColor: emphasized ? c.gold : c.border },
        emphasized ? { borderWidth: 1.5, ...Shadow.goldGlow } : null,
      ]}
    >
      <ProductPhoto product={product} height={205}>
        {hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : null}
      </ProductPhoto>

      <View style={styles.body}>
        <Pressable
          onPress={goToBusiness}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Ver el perfil de ${product.businessName}`}
          style={styles.businessRow}
        >
          <BusinessTile business={business} size={18} radius={9} />
          <Text v="caption" tone="textMuted" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="bodyM" numberOfLines={1} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={11} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={11} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
        </View>

        <PriceTag product={product} size="dataS" alone />
      </View>
    </Pressable>
  );
});

const PRICE_FOCUS_WIDTH = 165;

/**
 * `price_focus`: el precio manda — más grande y en negrita, con el
 * descuento justo debajo. Foto chica, tarjeta angosta para que quepan más
 * de un vistazo. "Descuentos locos" trae de por sí productos con más
 * descuento, así que el badge ya se ve más grande sin distinguir por clave.
 */
const PriceFocusCard = memo(function PriceFocusCard({ product, onPress }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.card, { width: PRICE_FOCUS_WIDTH, backgroundColor: c.surface, borderColor: c.border }]}
    >
      <ProductPhoto product={product} height={104}>
        {hasDiscount ? (
          <View style={styles.ribbon}>
            <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
          </View>
        ) : null}
      </ProductPhoto>

      <View style={styles.priceFocusBody}>
        <Pressable
          onPress={goToBusiness}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Ver el perfil de ${product.businessName}`}
          style={styles.businessRow}
        >
          <BusinessTile business={business} size={14} radius={7} />
          <Text v="caption" tone="textMuted" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="caption" numberOfLines={1} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={10} color={c.warning} />
              <Text v="caption" tone="textMuted">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={10} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
        </View>

        <PriceTag product={product} size="dataM" alone />
        {hasDiscount ? (
          <View style={styles.priceFocusDiscountRow}>
            <Text v="caption" tone="textMuted" style={styles.strike}>{money(product.price)}</Text>
            <Text v="captionStrong" tone="limeText">-{product.discountPercent}%</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

/**
 * `banner`: la única sección permitida a sentirse un bloque distinto — el
 * panel dorado suave lo envuelve `ProductCollectionRow`; la tarjeta de
 * adentro reutiliza el tamaño de `large`.
 */
const BannerCard = LargeCard;

const CARD_BY_VARIANT: Record<HomeSectionDisplayVariant, ComponentType<CardProps>> = {
  compact: CompactCard,
  large: LargeCard,
  horizontal: HorizontalCard,
  featured: FeaturedCard,
  price_focus: PriceFocusCard,
  banner: BannerCard,
};

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },
  bannerPanel: {
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    paddingVertical: Spacing.md,
    paddingLeft: Spacing.md,
  },

  card: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  image: { width: '100%' },
  ribbon: { position: 'absolute', top: Spacing.xs, left: Spacing.xs },
  rankBadge: {
    position: 'absolute', top: Spacing.xs, left: Spacing.xs,
    minWidth: 28, height: 24, borderRadius: 12, paddingHorizontal: 7,
    alignItems: 'center', justifyContent: 'center',
  },
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
  name: { minHeight: 40 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: 2 },
  priceStrong: { fontWeight: '700' },
  strike: { textDecorationLine: 'line-through' },
  pricePill: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  pricePillAlone: { alignSelf: 'flex-start', marginTop: 2 },

  // horizontal
  hCard: {
    flexDirection: 'row',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  hBody: { flex: 1, padding: Spacing.sm, gap: 3, justifyContent: 'center' },
  hMetaRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: 1 },

  // price_focus
  priceFocusBody: { padding: Spacing.xs + 2, gap: 2 },
  priceFocusDiscountRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.xs },
});
