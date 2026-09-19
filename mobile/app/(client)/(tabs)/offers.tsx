import { memo, useCallback, useMemo } from 'react';
import { View, ScrollView, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, SectionHeader, EmptyState, ErrorState, BusinessCardSkeleton, CatalogBadges,
} from '../../../components/ui';
import { BusinessRow } from '../../../components/domain/BusinessCard';
import { PromoCarousel } from '../../../components/domain/PromoCarousel';
import { CouponCard } from '../../../components/domain/CouponCard';
import { CouponSpotlight } from '../../../components/domain/CouponSpotlight';
import { LoyaltyProgressBanner } from '../../../components/domain/LoyaltyProgressBanner';
import { categoryIllustration } from '../../../components/illustrations';
import { useOffers, useDeliveryCoords } from '../../../hooks/useApi';
import type { OfferBusiness, ProductSearchHit } from '../../../services/endpoints';
import { productImageUri, productImagePlaceholder } from '../../../lib/productImage';
import { minutes } from '../../../lib/format';
import {
  pickSpotlightCoupon, isExpiringSoon, bigDiscountProducts, splitBusinessOffers,
} from '../../../lib/offers';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { BorderRadius, Spacing } from '../../../theme/tokens';

/**
 * Todo lo que está en oferta, en un solo scroll.
 *
 * Antes esto eran tres pestañas —Cupones, Productos, Negocios— y solo se
 * veía una a la vez. Después pasó a ser un feed seccionado plano: mismo
 * peso visual para un cupón que vence en una hora que para uno que vence
 * en un mes. Ahora la urgencia real —`validUntil`, cupo agotándose— decide
 * qué sube arriba: el mejor cupón se lleva un spotlight propio, y lo que
 * de verdad se acaba pronto se agrupa aparte, cupones y platos juntos, en
 * vez de obligar a mirar dos rieles distintos para enterarse.
 */
export default function OffersScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);

  // La distancia se mide desde la dirección de entrega, no desde el GPS,
  // igual que en el inicio: es donde el pedido va a llegar.
  const { coords, ready: coordsReady } = useDeliveryCoords();
  const { data, isLoading: loadingOffers, isError, refetch, isRefetching } = useOffers(coords, coordsReady);
  // Mientras llegan las direcciones la consulta espera: eso también es "cargando".
  const isLoading = loadingOffers || !coordsReady;

  const coupons = data?.coupons ?? [];
  const products = data?.products ?? [];
  const businesses = data?.businesses ?? [];
  const isEmpty = !coupons.length && !products.length && !businesses.length;

  // `useCallback` para que el `memo` de las tarjetas sirva de algo: sin
  // esto la funcion se recreaba en cada render y todas las filas se
  // volvian a renderizar.
  const openBusiness = useCallback(
    (id: string) => router.push(`/(client)/business/${id}`),
    [router]
  );

  // El cupón del spotlight no vuelve a aparecer en el riel de cupones de
  // abajo — repetirlo ahí se sentiría como un error, no como énfasis.
  const spotlightCoupon = useMemo(() => pickSpotlightCoupon(coupons), [coupons]);

  const expiringCoupons = useMemo(
    () => coupons.filter((cp) => cp._id !== spotlightCoupon?._id && isExpiringSoon(cp)),
    [coupons, spotlightCoupon]
  );
  const remainingCoupons = useMemo(
    () => coupons.filter(
      (cp) => cp._id !== spotlightCoupon?._id && !expiringCoupons.some((e) => e._id === cp._id)
    ),
    [coupons, spotlightCoupon, expiringCoupons]
  );

  // Mismo criterio con los platos: los de mayor rebaja se adelantan a "Se
  // acaban hoy" y no se repiten después en "Platos rebajados".
  const urgentProducts = useMemo(() => bigDiscountProducts(products), [products]);
  const urgentProductIds = useMemo(
    () => new Set(urgentProducts.map((p) => p._id)),
    [urgentProducts]
  );
  const remainingProducts = useMemo(
    () => products.filter((p) => !urgentProductIds.has(p._id)),
    [products, urgentProductIds]
  );

  const urgentItems = useMemo(
    () => [
      ...expiringCoupons.map((item) => ({ kind: 'coupon' as const, item })),
      ...urgentProducts.map((item) => ({ kind: 'product' as const, item })),
    ],
    [expiringCoupons, urgentProducts]
  );

  // Envío gratis y descuento en la carta son promesas distintas: juntarlas
  // bajo un solo título obligaba a leer cada tarjeta para saber cuál era.
  const { freeDelivery, discounted } = useMemo(
    () => splitBusinessOffers(businesses),
    [businesses]
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomSpace }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} colors={[c.primary]} />
        }
      >
        <View style={styles.top}>
          <Text v="displayM">Descuentos</Text>
        </View>

        {spotlightCoupon ? (
          <CouponSpotlight coupon={spotlightCoupon} onExpire={refetch} />
        ) : null}

        {/* Se dibuja solo si el servidor mandó banners vigentes para esta
            pantalla; si no, la sección siguiente sube y no queda hueco. */}
        <PromoCarousel placement="offers" />

        {isError ? (
          <View style={styles.section}>
            <ErrorState onRetry={refetch} />
          </View>
        ) : isLoading ? (
          <View style={[styles.section, styles.list]}>
            <BusinessCardSkeleton />
            <BusinessCardSkeleton />
            <BusinessCardSkeleton />
          </View>
        ) : (
          <>
            {isEmpty ? (
              <View style={styles.section}>
                <EmptyState
                  icon="descuento"
                  title="Sin descuentos por ahora"
                  message="Cuando haya cupones, platos rebajados o negocios en oferta cerca de ti, van a aparecer aquí."
                />
              </View>
            ) : (
              <>
                {urgentItems.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader title="Se acaban hoy" subtitle="Corre antes de que se agoten" />
                    <FlatList
                      horizontal
                      data={urgentItems}
                      keyExtractor={(row) => `${row.kind}-${row.item._id}`}
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.hList}
                      removeClippedSubviews
                      renderItem={({ item: row }) =>
                        row.kind === 'coupon' ? (
                          <CouponCard coupon={row.item} onExpire={refetch} />
                        ) : (
                          <OfferProductCard
                            product={row.item}
                            onPress={() => openBusiness(row.item.businessId)}
                          />
                        )
                      }
                    />
                  </View>
                ) : null}

                {remainingCoupons.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader title="Cupones" subtitle="Aplícalos al confirmar tu pedido" />
                    <FlatList
                      horizontal
                      data={remainingCoupons}
                      keyExtractor={(item) => item._id}
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.hList}
                      removeClippedSubviews
                      renderItem={({ item }) => <CouponCard coupon={item} />}
                    />
                  </View>
                ) : null}

                {remainingProducts.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader title="Platos rebajados" subtitle="Del mejor descuento al más pequeño" />
                    <FlatList
                      horizontal
                      data={remainingProducts}
                      keyExtractor={(item: ProductSearchHit) => item._id}
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.hList}
                      removeClippedSubviews
                      renderItem={({ item }) => (
                        <OfferProductCard product={item} onPress={() => openBusiness(item.businessId)} />
                      )}
                    />
                  </View>
                ) : null}

                {freeDelivery.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader title="Envío gratis cerca de ti" />
                    <View style={styles.list}>
                      {freeDelivery.map((item: OfferBusiness) => (
                        <Animated.View key={item._id} entering={FadeIn.duration(240)}>
                          <BusinessRow business={item} onPress={openBusiness} />
                        </Animated.View>
                      ))}
                    </View>
                  </View>
                ) : null}

                {discounted.length > 0 ? (
                  <View style={styles.section}>
                    <SectionHeader title="Negocios en oferta" subtitle="Descuentos activos en la carta" />
                    <View style={styles.list}>
                      {discounted.map((item: OfferBusiness) => (
                        <Animated.View key={item._id} entering={FadeIn.duration(240)}>
                          <BusinessRow business={item} onPress={openBusiness} />
                        </Animated.View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            )}

            {/* Fuera del vacío a propósito: aunque no haya ni un descuento
                cerca, los puntos siguen siendo un camino a algo, no un
                callejón sin salida. */}
            <View style={styles.section}>
              <SectionHeader title="Tus puntos ZIPP" subtitle="Cada pedido entregado suma" />
              <LoyaltyProgressBanner />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Un plato rebajado, en formato de riel. El precio tachado es el dato que
 * importa: es lo que convierte "$15.400" en una oferta y no en un precio
 * cualquiera.
 */
const OfferProductCard = memo(function OfferProductCard({
  product, onPress,
}: { product: ProductSearchHit; onPress: () => void }) {
  const { c } = useTheme();
  const uri = productImageUri(product as never, 'catalog');
  const Illustration = categoryIllustration(product.businessCategory ?? '');

  return (
    <Card
      onPress={onPress}
      padded={false}
      accessibilityLabel={`${product.name} en ${product.businessName}. Antes $${product.price.toLocaleString('es-CO')}, ahora $${(product.discountPrice ?? product.price).toLocaleString('es-CO')}`}
      accessibilityHint="Abre el negocio"
      style={styles.productCard}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.productImage}
          contentFit="cover"
          transition={150}
          // El backend ya mandaba esta miniatura borrosa en cada producto y
          // nadie la usaba: es la diferencia entre un hueco gris y algo que
          // ya se parece al plato mientras carga.
          placeholder={productImagePlaceholder(product as never)}
          cachePolicy="memory-disk"
          recyclingKey={product._id}
        />
      ) : (
        <View style={[styles.productImage, styles.productFallback, { backgroundColor: c.surfaceLight }]}>
          <Illustration size={46} />
        </View>
      )}

      <View style={styles.productBody}>
        <CatalogBadges product={product} />
        <Text v="strongS" numberOfLines={1}>{product.name}</Text>
        <View style={styles.businessRow}>
          <Text v="caption" tone="text" numberOfLines={1} style={styles.flex}>{product.businessName}</Text>
          <View style={styles.rating}>
            <Icon name="calificacion" size={11} color={c.warning} />
            <Text v="caption" tone="text">{(product.businessRating ?? 0).toFixed(1)}</Text>
          </View>
          {product.businessDeliveryTime ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={11} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(product.businessDeliveryTime)}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.priceRow}>
          <View style={[styles.pricePill, { backgroundColor: c.gold }]}>
            <Text v="dataM" color={c.black}>
              ${(product.discountPrice ?? product.price).toLocaleString('es-CO')}
            </Text>
          </View>
          <Text v="dataS" tone="text" style={styles.strike}>
            ${product.price.toLocaleString('es-CO')}
          </Text>
        </View>
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl },

  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },
  list: { gap: Spacing.md },

  productCard: { width: 168, padding: Spacing.md, gap: Spacing.sm },
  productImage: { width: '100%', height: 112, borderRadius: BorderRadius.sm },
  productFallback: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  productBody: { gap: 2 },
  businessRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  flex: { flex: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  strike: { textDecorationLine: 'line-through' },
  pricePill: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
});
