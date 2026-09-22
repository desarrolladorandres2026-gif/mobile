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
  contentIllustration, contentIllustrationByName, categoryIllustration, DefaultIllustration,
  type IllustrationProps,
} from '../illustrations';
import { CollectionHeader, type HeaderVariant } from './CollectionHeader';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import type { HomeSection, HomeSectionDisplayVariant, HomeSectionProduct } from '../../services/endpoints';

/**
 * Icono de cada colección: logo PNG Twemoji, el mismo sistema que Categorías
 * y los estados vacíos — nunca un glifo de Lucide suelto. Las de categoría de
 * negocio (`categoryIllustration`) encajan mejor en las secciones de comida
 * por franja (antojo, desayuno, noche); el resto sale del registro de
 * "contenido".
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
  nuevosEnZipp: contentIllustration('nuevo'),
  descubreAlgoNuevo: contentIllustration('explorar'),
  nuncaHasProbado: contentIllustration('estrella'),
  vuelveAPedir: contentIllustration('repetir'),
  deTusFavoritos: contentIllustration('favorito'),
  deLaDrogueria: categoryIllustration('pharmacy'),
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
 *
 * `allowGrid` solo lo enciende Explorar: la misma colección llega a los dos
 * feeds, y en Inicio —que es pasear, no comparar— una cuadrícula de doce
 * ocuparía la pantalla entera. Ahí `grid` cae al carrusel de `price_focus`,
 * que es lo que esas colecciones eran antes.
 */
export const ProductCollectionRow = memo(function ProductCollectionRow({
  section,
  allowGrid = false,
}: { section: HomeSection; allowGrid?: boolean }) {
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
  // `section.illustration` es un nombre del registro de contenido, no una
  // clave de sección: es lo que da ícono a una colección creada desde el
  // panel, que no puede estar en un mapa escrito antes de que existiera.
  const Illustration =
    SECTION_ILLUSTRATION[section.key] ??
    contentIllustrationByName(section.illustration) ??
    DefaultIllustration;
  const CardComponent = CARD_BY_VARIANT[variant] ?? CompactCard;
  const headerVariant = HEADER_VARIANT[section.key] ?? 'minimal';
  const subtitle = section.subtitle ?? FALLBACK_SUBTITLE[section.key];

  const list = variant === 'grid' && allowGrid ? (
    <ProductGrid products={section.products} onPress={goToProduct} />
  ) : (
    <FlatList
      horizontal
      data={section.products}
      keyExtractor={(item) => item._id}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.hList}
      removeClippedSubviews
      maxToRenderPerBatch={10}
      windowSize={9}
      // En pantalla caben dos tarjetas y media: montar seis por fila, con
      // veinte filas, eran 120 tarjetas con foto al abrir el Inicio.
      initialNumToRender={3}
      renderItem={({ item, index }) => (
        <CardComponent
          product={item}
          onPress={() => goToProduct(item)}
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

      {list}
    </View>
  );
});

// ──────────────────────────────────────────────────────────────
// Bloque compartido: identidad del comercio (aro + nombre + toque propio)
// ──────────────────────────────────────────────────────────────

type CardProps = { product: HomeSectionProduct; onPress: () => void; rank?: number };

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
 * El precio: solo se pinta de dorado cuando hay algo que celebrar —
 * descuento o que el producto solo ya alcanza el domicilio gratis del
 * comercio. Sin eso, es texto plano: el dorado se reserva para cuando
 * comunica una ventaja real, nunca como fondo decorativo.
 */
function PriceTag({
  product, size, alone,
}: { product: HomeSectionProduct; size: 'dataS' | 'dataM' | 'dataL'; alone?: boolean }) {
  const highlighted = product.discountPercent > 0 || hasFreeDelivery(product);

  return (
    <Text
      v={size}
      tone={highlighted ? 'primaryText' : 'text'}
      style={[styles.priceStrong, alone ? styles.pricePillAlone : null]}
    >
      {money(product.effectivePrice)}
    </Text>
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
      style={[styles.card, { width: CARD_WIDTH }]}
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
          <Text v="caption" tone="text" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="bodyS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={11} color={c.warning} />
              <Text v="caption" tone="text">{product.businessRating.toFixed(1)}</Text>
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
              <Text v="caption" tone="text" style={styles.strike}>{money(product.price)}</Text>
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
      style={[styles.card, { width: LARGE_WIDTH }]}
    >
      <ProductPhoto product={product} height={195}>
        {rank ? (
          <View style={styles.rankBadge}>
            <Text v="titleS" tone="primaryText" style={styles.rankText}>#{rank}</Text>
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
          <Text v="bodyM" tone="text" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="titleS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={13} color={c.warning} />
              <Text v="caption" tone="text">{product.businessRating.toFixed(1)}</Text>
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
              <Text v="caption" tone="text" style={styles.strike}>{money(product.price)}</Text>
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
      style={[styles.hCard, { width: HORIZONTAL_WIDTH }]}
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
          <Text v="caption" tone="text" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="bodyS" numberOfLines={2} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={12} color={c.warning} />
              <Text v="caption" tone="text">{product.businessRating.toFixed(1)}</Text>
            </View>
          {product.businessDeliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={12} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
          {distance ? (
            <View style={styles.rating}>
              <Icon name="ubicacion" size={12} color={c.text} />
              <Text v="caption" tone="text">{distance}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.priceRow}>
          <PriceTag product={product} size="dataS" />
          {hasDiscount ? (
            <Text v="caption" tone="text" style={styles.strike}>{money(product.price)}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const FEATURED_WIDTH = 215;

/**
 * `featured`: la foto es la protagonista casi absoluta, mínimo texto
 * secundario. "ZIPP recomienda" (favoritosZipp) ya se siente curada por su
 * encabezado propio (`headerVariant: 'featured'`); la primera tarjeta no
 * necesita además un borde y halo dorados para destacar.
 */
const FeaturedCard = memo(function FeaturedCard({ product, onPress }: CardProps) {
  const { c } = useTheme();
  const { business, goToBusiness } = useBusinessNav(product);
  const hasDiscount = product.discountPercent > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={[styles.card, { width: FEATURED_WIDTH }]}
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
          <Text v="caption" tone="text" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="bodyM" numberOfLines={1} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={11} color={c.warning} />
              <Text v="caption" tone="text">{product.businessRating.toFixed(1)}</Text>
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
      style={[styles.card, { width: PRICE_FOCUS_WIDTH }]}
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
          <Text v="caption" tone="text" numberOfLines={1} style={styles.businessName}>
            {product.businessName}
          </Text>
        </Pressable>

        <Text v="caption" numberOfLines={1} style={styles.name}>{product.name}</Text>

        <View style={styles.hMetaRow}>
                      <View style={styles.rating}>
              <Icon name="calificacion" size={10} color={c.warning} />
              <Text v="caption" tone="text">{product.businessRating.toFixed(1)}</Text>
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
            <Text v="caption" tone="text" style={styles.strike}>{money(product.price)}</Text>
            <Text v="captionStrong" tone="limeText">-{product.discountPercent}%</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

/** `banner`: misma tarjeta que `large`, sin panel propio alrededor del carrusel. */
const BannerCard = LargeCard;

// ──────────────────────────────────────────────────────────────
// `grid`: 3 columnas × 4 filas, la única variante que no es un carrusel
// ──────────────────────────────────────────────────────────────

const GRID_COLUMNS = 3;
const GRID_ROWS = 4;
/**
 * Tope duro de la cuadrícula. El servidor ya pide exactamente esto
 * (`targetSize: 12` en `discoverySeeds.ts`); el recorte de aquí es para una
 * colección editada a mano que mande más. Lo que sobre no entra por un
 * scroll interno: un `ScrollView` vertical dentro del de Explorar atrapa el
 * dedo en Android y la pantalla deja de bajar.
 */
const GRID_MAX = GRID_COLUMNS * GRID_ROWS;
/**
 * Con ~110 dp de ancho por tarjeta, 88 de foto + nombre + precio dejan cada
 * fila en ~135 dp: las cuatro caben en una pantalla con el encabezado de la
 * sección, que es lo que hace que se lea como una cuadrícula y no como una
 * lista larga.
 */
const GRID_IMAGE_HEIGHT = 88;

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * Tarjeta de cuadrícula: foto, nombre y precio — nada más. Aquí se escanea
 * por precio, y a este ancho el comercio y la calificación solo empujaban
 * la cuarta fila fuera de la pantalla. El comercio sigue en la etiqueta de
 * accesibilidad y en la ficha a la que lleva el toque.
 */
const GridCard = memo(function GridCard({ product, onPress }: CardProps) {
  const hasDiscount = product.discountPercent > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
      accessibilityHint="Abre este producto en su negocio"
      style={styles.gridCard}
    >
      {/* El redondeo va en la foto y no en la tarjeta: sin fondo detrás del
          texto, recortar la tarjeta dejaba la foto con las esquinas de abajo
          en ángulo recto. */}
      <View style={styles.gridPhoto}>
        <ProductPhoto product={product} height={GRID_IMAGE_HEIGHT}>
          {hasDiscount ? (
            <View style={styles.ribbon}>
              <CatalogBadge kind="descuento" label={`-${product.discountPercent}%`} />
            </View>
          ) : null}
        </ProductPhoto>
      </View>

      <View style={styles.gridBody}>
        <Text v="caption" numberOfLines={1}>{product.name}</Text>
        <PriceTag product={product} size="dataS" />
      </View>
    </Pressable>
  );
});

/** 3×4 fijo; nunca más de `GRID_MAX` tarjetas. */
const ProductGrid = memo(function ProductGrid({
  products, onPress,
}: { products: HomeSectionProduct[]; onPress: (product: HomeSectionProduct) => void }) {
  const rows = chunk(products.slice(0, GRID_MAX), GRID_COLUMNS);

  return (
    <View style={styles.gridRows}>
      {rows.map((row, i) => (
        <View key={i} style={styles.gridRow}>
          {row.map((product) => (
            <GridCard key={product._id} product={product} onPress={() => onPress(product)} />
          ))}
          {row.length < GRID_COLUMNS
            ? Array.from({ length: GRID_COLUMNS - row.length }).map((_, j) => (
                <View key={`filler-${j}`} style={styles.gridFiller} />
              ))
            : null}
        </View>
      ))}
    </View>
  );
});

/**
 * Las variantes que pintan **productos**.
 *
 * Parcial a propósito: `business_row` y `spotlight` devuelven negocios, no
 * productos, y los pintan `BusinessCollectionRow` y `SpotlightCarousel`. Una
 * colección con esa variante que llegara aquí cae a `compact`, que es feo
 * pero se ve — mejor que una pantalla en blanco porque un admin eligió una
 * variante que no corresponde.
 *
 * `grid` está aquí solo para cuando no se pinta como cuadrícula (Inicio):
 * entonces es un carrusel de `price_focus`.
 */
const CARD_BY_VARIANT: Partial<Record<HomeSectionDisplayVariant, ComponentType<CardProps>>> = {
  compact: CompactCard,
  large: LargeCard,
  horizontal: HorizontalCard,
  featured: FeaturedCard,
  price_focus: PriceFocusCard,
  banner: BannerCard,
  grid: PriceFocusCard,
};

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },

  card: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  image: { width: '100%' },
  ribbon: { position: 'absolute', top: Spacing.xs, left: Spacing.xs },
  rankBadge: { position: 'absolute', top: Spacing.xs, left: Spacing.sm },
  // Sin fondo: solo la sombra de texto para que el número se lea sobre
  // cualquier foto, sin simular una pastilla.
  rankText: {
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
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
  name: {},
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: 2 },
  priceStrong: { fontWeight: '700' },
  strike: { textDecorationLine: 'line-through' },
  pricePillAlone: { alignSelf: 'flex-start', marginTop: 2 },

  // horizontal
  hCard: {
    flexDirection: 'row',
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  hBody: { flex: 1, padding: Spacing.sm, gap: 3, justifyContent: 'center' },
  hMetaRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: 1 },

  // price_focus
  priceFocusBody: { padding: Spacing.xs + 2, gap: 2 },
  priceFocusDiscountRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.xs },

  // grid
  gridRows: { gap: Spacing.sm },
  gridRow: { flexDirection: 'row', gap: Spacing.sm },
  gridCard: { flex: 1 },
  gridPhoto: { borderRadius: BorderRadius.md, overflow: 'hidden' },
  gridFiller: { flex: 1 },
  gridBody: { paddingTop: Spacing.xs + 2, paddingHorizontal: 2, gap: 1 },
});
