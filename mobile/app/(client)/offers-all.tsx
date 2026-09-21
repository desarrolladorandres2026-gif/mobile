import { useMemo, useState } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Screen, Header, EmptyState, ErrorState, Skeleton, CouponCardSkeleton, BusinessCardSkeleton,
} from '../../components/ui';
import { OfferBusinessRow } from '../../components/domain/OfferBusinessRow';
import { TicketCard } from '../../components/domain/TicketCard';
import { OfferTile } from '../../components/domain/OfferTile';
import { CouponSheet } from '../../components/domain/CouponSheet';
import { useOffers, useDeliveryCoords, useCouponEligibility, useProStatus } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { useAuthStore } from '../../stores/authStore';
import { useCouponStore } from '../../stores/couponStore';
import {
  couponStatus, indexEligibility, splitBusinessOffers, withoutRedundantFreeDelivery, type CouponStatus,
} from '../../lib/offers';
import { BorderRadius, Spacing } from '../../theme/tokens';
import type { OfferCoupon, ProductSearchHit } from '../../services/endpoints';

type Kind = 'coupons' | 'products' | 'businesses';

/** Lo máximo que `/offers` acepta (`MAX_LIMIT` en el controlador). */
const OFFERS_MAX = 50;

const TITLES: Record<Kind, string> = {
  coupons: 'Todos los cupones',
  products: 'Platos rebajados',
  businesses: 'Negocios en oferta',
};

/**
 * Una sección de Descuentos, entera y en vertical.
 *
 * La pestaña enseña rieles horizontales: caben seis u ocho tarjetas y el
 * resto solo existe si alguien sigue deslizando de lado, que casi nadie
 * hace. `SectionHeader` ya traía el gancho de "Ver todo" desde que se
 * escribió y ninguna sección lo usaba: el contenido visible era el que
 * cupiera, no el que hubiera.
 *
 * Pide la lista al tope que el servidor acepta, y eso es justo lo que la
 * distingue de deslizar el riel: la pestaña trae 30 y aquí caben 50. Más no
 * existe, así que tampoco hace falta scroll infinito.
 */
export default function OffersAllScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const listKind: Kind = kind === 'products' || kind === 'businesses' ? kind : 'coupons';

  const { coords, ready } = useDeliveryCoords();
  // El tope del servidor, no el del riel. Es lo que convierte "Ver todo" en
  // algo distinto de deslizar la tira de la pestaña.
  const { data, isLoading, isError, refetch } = useOffers(coords, ready, OFFERS_MAX);

  const isAuthenticated = useAuthStore((s) => !!s.user);
  const { data: eligibilityRows } = useCouponEligibility(isAuthenticated);
  const eligibility = useMemo(() => indexEligibility(eligibilityRows), [eligibilityRows]);
  const saveCoupon = useCouponStore((s) => s.save);

  const [sheetCoupon, setSheetCoupon] = useState<OfferCoupon | null>(null);

  const statusOf = (coupon: OfferCoupon): CouponStatus => couponStatus(coupon, eligibility);

  const useCoupon = (coupon: OfferCoupon) => {
    saveCoupon(coupon.code, coupon.businessId ?? null);
    setSheetCoupon(null);
    if (coupon.businessId) router.push(`/(client)/business/${coupon.businessId}`);
    else router.push('/(client)/(tabs)/search');
  };

  // Un socio Pro con envío gratis no ve cupones de envío gratis: no le ahorran nada.
  const { data: pro } = useProStatus(isAuthenticated);
  const proFreeDelivery = !!pro?.member && !!pro.plan.benefits.freeDelivery.enabled;
  const allCoupons = data?.coupons;
  const coupons = useMemo(
    () => withoutRedundantFreeDelivery(allCoupons ?? [], proFreeDelivery),
    [allCoupons, proFreeDelivery]
  );

  const businesses = useMemo(
    () => splitBusinessOffers(data?.businesses ?? []).discounted,
    [data]
  );

  const body = () => {
    if (isError) return <ErrorState onRetry={refetch} />;

    if (isLoading || !ready) {
      return (
        <View style={styles.list}>
          {/* Cada lista carga con la silueta de lo suyo: tiquete, baldosa o
              fila. Un fantasma prestado de otra pantalla hace que la lista
              salte al llegar los datos. */}
          {listKind === 'coupons' ? (
            <>
              <CouponCardSkeleton width="100%" />
              <CouponCardSkeleton width="100%" />
            </>
          ) : listKind === 'products' ? (
            <>
              <Skeleton width="100%" height={200} radius={BorderRadius.xl} />
              <Skeleton width="100%" height={200} radius={BorderRadius.xl} />
            </>
          ) : (
            <>
              <BusinessCardSkeleton />
              <BusinessCardSkeleton />
            </>
          )}
        </View>
      );
    }

    if (listKind === 'coupons') {
      if (!coupons.length) return (
        <EmptyState
          icon="cupon"
          title="Sin cupones por ahora"
          message="En cuanto haya promociones cerca de ti, aparecen aquí."
        />
      );

      return (
        <FlatList
          data={coupons}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <TicketCard
              coupon={item}
              width="100%"
              notchColor={c.background}
              status={statusOf(item)}
              onPress={() => setSheetCoupon(item)}
            />
          )}
        />
      );
    }

    if (listKind === 'products') {
      const products = data?.products ?? [];
      if (!products.length) return (
        <EmptyState
          icon="descuento"
          title="Sin platos rebajados"
          message="Ningún negocio cerca tiene descuentos en su carta ahora mismo."
        />
      );

      return (
        <FlatList
          data={products}
          keyExtractor={(item: ProductSearchHit) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <OfferTile
              product={item}
              width="100%"
              imageHeight={180}
              onPress={() =>
                router.push(`/(client)/business/${item.businessId}?productId=${item._id}`)}
            />
          )}
        />
      );
    }

    if (!businesses.length) {
      return (
        <EmptyState
          icon="descuento"
          title="Sin negocios en oferta"
          message="Vuelve más tarde: las promociones cambian durante el día."
        />
      );
    }

    return (
      <FlatList
        data={businesses}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <OfferBusinessRow
            business={item}
            onPress={(id) => router.push(`/(client)/business/${id}`)}
          />
        )}
      />
    );
  };

  return (
    <Screen>
      <Header title={TITLES[listKind]} />
      {body()}

      <CouponSheet
        coupon={sheetCoupon}
        status={sheetCoupon ? statusOf(sheetCoupon) : { kind: 'active' }}
        visible={!!sheetCoupon}
        onClose={() => setSheetCoupon(null)}
        onUse={useCoupon}
      />
    </Screen>
  );
}


const styles = StyleSheet.create({
  list: { gap: Spacing.md, padding: Spacing.xl },
});
