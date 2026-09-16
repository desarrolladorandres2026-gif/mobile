import { memo, useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { CatalogBadge } from '../ui/Badge';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent } from '../../lib/business';
import { productImageUri, productImagePlaceholder, hasProductImage } from '../../lib/productImage';
import { contentIllustration } from '../illustrations';
import { CollectionHeader } from './CollectionHeader';
import { SpotlightCarousel, type SpotlightRenderOpts } from './SpotlightCarousel';
import { money } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';
import type { ProductBannerEntry, CuratedHomeProduct } from '../../services/endpoints';

/**
 * `productBanner`: spotlight curado a mano por un admin — exactamente tres
 * productos, no un ranking calculado. Mismo carrusel apilado que
 * `PromoCarousel` (protagonista al centro, laterales asomando, arrastre y
 * avance automático), pero con la tarjeta partida en foto arriba + cuerpo
 * con precio abajo, en vez de imagen de fondo con degradado.
 */
export const ProductBannerBlock = memo(function ProductBannerBlock({
  entry,
}: { entry: ProductBannerEntry }) {
  const router = useRouter();

  const goToProduct = useCallback((product: CuratedHomeProduct) => {
    tap('medium');
    router.push({
      pathname: '/(client)/business/[id]',
      params: { id: product.businessId, productId: product._id },
    });
  }, [router]);

  if (entry.products.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <CollectionHeader
          variant="featured"
          title={entry.title}
          subtitle={entry.subtitle}
          Illustration={contentIllustration('corona')}
        />
      </View>
      <SpotlightCarousel
        items={entry.products}
        keyExtractor={(product) => product._id}
        accessibilityLabel={(product) => `${product.name}, ${product.businessName}, ${money(product.effectivePrice)}`}
        onPressActive={goToProduct}
        aspect={0.92}
        sizeScale={0.7}
        renderCard={(product, opts) => <ProductCardContent product={product} opts={opts} />}
      />
    </View>
  );
});

function ProductCardContent({
  product, opts,
}: { product: CuratedHomeProduct; opts: SpotlightRenderOpts }) {
  const { c } = useTheme();
  const [broken, setBroken] = useState(false);
  const accent = businessAccent(product.businessId);
  const hasDiscount = product.discountPercent > 0;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.surface }]}>
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
        ) : null}
        <View style={[styles.add, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="sm" color={c.textOnPrimary} />
        </View>
      </View>

      <View style={styles.body}>
        <Text v="caption" tone="textMuted" numberOfLines={1}>{product.businessName}</Text>
        <Text v="bodyS" numberOfLines={1} style={styles.name}>{product.name}</Text>
        <View style={styles.priceRow}>
          <Text v="dataS" tone="primaryText" style={styles.priceStrong}>{money(product.effectivePrice)}</Text>
          {hasDiscount ? (
            <Text v="caption" tone="textMuted" style={styles.strike}>{money(product.price)}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl },
  // El título respeta el mismo margen que el resto de secciones del inicio
  // (`Spacing.xl`); el carrusel de abajo se queda a sangre para poder
  // mostrar los laterales asomando fuera del borde, como `PromoCarousel`.
  header: { paddingHorizontal: Spacing.xl },
  image: { flex: 1 },
  ribbon: { position: 'absolute', top: Spacing.xs, left: Spacing.xs },
  add: {
    position: 'absolute', bottom: Spacing.xs, right: Spacing.xs,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  body: { padding: Spacing.md, gap: 3 },
  name: {},
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' },
  priceStrong: { fontWeight: '700' },
  strike: { textDecorationLine: 'line-through' },
});
