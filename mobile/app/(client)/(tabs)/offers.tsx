import { useState, memo } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Card, EmptyState, ErrorState, BusinessCardSkeleton, CatalogBadges,
} from '../../../components/ui';
import { BusinessRow } from '../../../components/domain/BusinessCard';
import { PromoCarousel } from '../../../components/domain/PromoCarousel';
import { CouponCard } from '../../../components/domain/CouponCard';
import { useOffers, useDeliveryCoords } from '../../../hooks/useApi';
import type { OfferBusiness, ProductSearchHit } from '../../../services/endpoints';
import { productImageUri } from '../../../lib/productImage';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { tap } from '../../../lib/haptics';

type Segment = 'coupons' | 'products' | 'businesses';

/**
 * Todo lo que está en oferta, en un solo lugar.
 *
 * Antes de esto, un descuento solo se descubría entrando al negocio
 * correcto o si le tocaba salir en el carrusel del inicio. Los tres
 * segmentos no compiten entre sí: un cupón, un plato rebajado y un negocio
 * con envío gratis son tres formas distintas de la misma promesa —"esto te
 * cuesta menos"— y cada una necesita su propia tarjeta.
 */
export default function OffersScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);
  const [segment, setSegment] = useState<Segment>('coupons');

  // La distancia se mide desde la dirección de entrega, no desde el GPS,
  // igual que en el inicio: es donde el pedido va a llegar.
  const coords = useDeliveryCoords();
  const { data, isLoading, isError, refetch, isRefetching } = useOffers(coords);

  const coupons = data?.coupons ?? [];
  const products = data?.products ?? [];
  const businesses = data?.businesses ?? [];

  const openBusiness = (id: string) => router.push(`/(client)/business/${id}`);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.top}>
        <Text v="displayM">Descuentos</Text>

        <View style={[styles.segments, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
          <SegmentTab
            label="Cupones"
            count={coupons.length}
            active={segment === 'coupons'}
            onPress={() => setSegment('coupons')}
          />
          <SegmentTab
            label="Productos"
            count={products.length}
            active={segment === 'products'}
            onPress={() => setSegment('products')}
          />
          <SegmentTab
            label="Negocios"
            count={businesses.length}
            active={segment === 'businesses'}
            onPress={() => setSegment('businesses')}
          />
        </View>
      </View>

      {/* Se dibuja solo si el servidor mandó banners vigentes para esta
          pestaña; si no, la lista sube sola y no queda ningún hueco. */}
      <PromoCarousel placement="offers" />

      {isError ? (
        <ErrorState onRetry={refetch} />
      ) : isLoading ? (
        <View style={styles.skeletons}>
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
        </View>
      ) : segment === 'coupons' ? (
        <FlatList
          data={coupons}
          keyExtractor={(item: any) => item._id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} colors={[c.primary]} />
          }
          renderItem={({ item }) => (
            <Animated.View entering={FadeIn.duration(240)}>
              <CouponCard coupon={item} width="100%" />
            </Animated.View>
          )}
          ListEmptyComponent={
            <EmptyState
              icon="cupon"
              title="Sin cupones activos"
              message="Cuando haya promociones nuevas te avisaremos de inmediato."
            />
          }
        />
      ) : segment === 'products' ? (
        <FlatList
          data={products}
          keyExtractor={(item: ProductSearchHit) => item._id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} colors={[c.primary]} />
          }
          renderItem={({ item }) => (
            <OfferProductCard product={item} onPress={() => openBusiness(item.businessId)} />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="descuento"
              title="Sin platos rebajados por ahora"
              message="Cuando algún negocio baje un precio, va a aparecer aquí."
            />
          }
        />
      ) : (
        <FlatList
          data={businesses}
          keyExtractor={(item: OfferBusiness) => item._id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} colors={[c.primary]} />
          }
          renderItem={({ item }) => (
            <BusinessRow business={item} onPress={() => openBusiness(item._id)} />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="negocio"
              title="Sin negocios en oferta cerca"
              message="Los negocios con envío gratis o descuentos activos van a salir aquí."
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function SegmentTab({
  label, count, active, onPress,
}: { label: string; count: number; active: boolean; onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'resultado' : 'resultados'}`}
      style={[styles.segment, active && { backgroundColor: c.surface }]}
    >
      <Text v="strongS" tone={active ? 'text' : 'textMuted'}>{label}</Text>
      {count > 0 ? (
        <Text v="dataXS" tone={active ? 'primaryText' : 'textMuted'}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Un producto rebajado. A diferencia de la ficha de búsqueda, aquí el
 * precio tachado es el dato que importa: es lo que convierte "$15.400" en
 * una oferta y no en un precio cualquiera.
 */
const OfferProductCard = memo(function OfferProductCard({
  product, onPress,
}: { product: ProductSearchHit; onPress: () => void }) {
  const { c } = useTheme();
  const uri = productImageUri(product as never, 'catalog');

  return (
    <Card
      onPress={onPress}
      padded={false}
      accessibilityLabel={`${product.name} en ${product.businessName}. Antes $${product.price.toLocaleString('es-CO')}, ahora $${(product.discountPrice ?? product.price).toLocaleString('es-CO')}`}
      accessibilityHint="Abre el negocio"
      style={styles.productCard}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.productImage} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.productImage, { backgroundColor: c.surfaceLight }]} />
      )}

      <View style={styles.productBody}>
        <CatalogBadges product={product} />
        <Text v="strongS" numberOfLines={1}>{product.name}</Text>
        <Text v="caption" tone="textMuted" numberOfLines={1}>{product.businessName}</Text>
        <View style={styles.priceRow}>
          <Text v="dataM" color={c.primary}>
            ${(product.discountPrice ?? product.price).toLocaleString('es-CO')}
          </Text>
          <Text v="dataS" tone="textMuted" style={styles.strike}>
            ${product.price.toLocaleString('es-CO')}
          </Text>
        </View>
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: Spacing.lg },
  segments: {
    flexDirection: 'row',
    gap: Spacing.xs,
    padding: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs + 2,
    height: 42,
    borderRadius: BorderRadius.full,
  },

  list: { padding: Spacing.xl, gap: Spacing.md },
  skeletons: { padding: Spacing.xl, gap: Spacing.md },

  productCard: { flexDirection: 'row', padding: Spacing.md, gap: Spacing.md },
  productImage: { width: 72, height: 72, borderRadius: BorderRadius.sm },
  productBody: { flex: 1, gap: 2, justifyContent: 'center' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm },
  strike: { textDecorationLine: 'line-through' },
});
