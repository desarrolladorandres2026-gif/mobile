import { useCallback } from 'react';
import {
  View, ScrollView, FlatList, Pressable, RefreshControl,
  StyleSheet, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, SectionHeader, Badge,
  EmptyState, BusinessCardSkeleton, ErrorState,
} from '../../../components/ui';
import {
  BusinessRow, BusinessFeatured, type Business,
} from '../../../components/domain/BusinessCard';
import { useAuthStore } from '../../../stores/authStore';
import { useBusinesses, usePublicCoupons, useAddresses } from '../../../hooks/useApi';
import { useUsual, reorder, type UsualOrder } from '../../../hooks/useUsual';
import { useTheme } from '../../../hooks/useTheme';
import { BUSINESS_CATEGORIES } from '../../../constants/config';
import { categoryIcon } from '../../../theme/icons';
import { BorderRadius, Shadow, Spacing } from '../../../theme/tokens';
import { greeting, firstName, money } from '../../../lib/format';
import { openState, businessAccent } from '../../../lib/business';
import { tap } from '../../../lib/haptics';

/** Deja aire suficiente para el dock y la barra de pestañas. */
const BOTTOM_SPACE = 190;

export default function HomeScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const user = useAuthStore((s) => s.user);

  const { data: businesses = [], isLoading, isError, refetch, isRefetching } =
    useBusinesses() as { data: Business[]; isLoading: boolean; isError: boolean; refetch: () => void; isRefetching: boolean };
  const { data: coupons = [] } = usePublicCoupons();
  const { data: addresses = [] } = useAddresses();
  const { usual } = useUsual();

  const defaultAddress = addresses.find((a: any) => a.isDefault) ?? addresses[0];

  const featured = businesses.filter((b) => b.isFeatured);
  const openNow = businesses.filter((b) => openState(b.schedule).open);
  const closed = businesses.filter((b) => !openState(b.schedule).open);

  const goToBusiness = useCallback(
    (id: string) => router.push(`/(client)/business/${id}`),
    [router]
  );

  const repeatOrder = (item: UsualOrder) => {
    tap('medium');
    reorder(item);
    router.push('/(client)/cart');
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
        {/* ── Cabecera ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text v="bodyS" tone="textMuted">{greeting()},</Text>
            <Text v="displayM" numberOfLines={1}>
              {firstName(user?.name) || 'qué más'}
            </Text>
          </View>

          <Pressable
            onPress={() => { tap('light'); router.push('/(client)/notifications'); }}
            accessibilityRole="button"
            accessibilityLabel="Avisos"
            hitSlop={8}
            style={[styles.bell, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <Icon name="notificaciones" size="md" color={c.text} />
          </Pressable>
        </View>

        {/* ── Dónde entregamos ── */}
        <Pressable
          onPress={() => { tap('light'); router.push('/(client)/addresses'); }}
          accessibilityRole="button"
          accessibilityLabel={
            defaultAddress
              ? `Entregar en ${defaultAddress.label}, ${defaultAddress.address}. Toca para cambiar`
              : 'Agregar una dirección de entrega'
          }
          style={[styles.address, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <View style={[styles.addressIcon, { backgroundColor: c.primarySoft }]}>
            <Icon name="ubicacion" size="sm" color={c.primaryText} />
          </View>
          <View style={styles.addressBody}>
            <Text v="caption" tone="textMuted">ENTREGAR EN</Text>
            <Text v="strongS" numberOfLines={1}>
              {defaultAddress
                ? `${defaultAddress.label} · ${defaultAddress.address}`
                : 'Agrega tu dirección'}
            </Text>
          </View>
          <Icon name="desplegar" size="sm" color={c.textMuted} />
        </Pressable>

        {/* ── Buscar ── */}
        <Pressable
          onPress={() => { tap('light'); router.push('/(client)/(tabs)/search'); }}
          accessibilityRole="search"
          accessibilityLabel="Buscar negocios y productos"
          style={[styles.searchStub, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <Icon name="explorar" size="md" color={c.textMuted} />
          <Text v="bodyM" tone="textMuted" style={styles.flex}>¿Qué se te antoja hoy?</Text>
        </Pressable>

        {/* ── Lo de siempre ── */}
        {usual.length > 0 ? (
          <Animated.View entering={FadeIn.duration(320)} style={styles.section}>
            <SectionHeader
              title="Lo de siempre"
              subtitle="Repite tu pedido en un toque"
            />
            <FlatList
              horizontal
              data={usual}
              keyExtractor={(item) => item.orderId}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.hList}
              renderItem={({ item }) => (
                <UsualCard item={item} onPress={() => repeatOrder(item)} />
              )}
            />
          </Animated.View>
        ) : null}

        {/* ── Categorías ── */}
        {/* ── Categorías ── */}
        <View style={styles.section}>
          <SectionHeader title="Categorías" />
          <View style={styles.categories}>
            {BUSINESS_CATEGORIES.map((cat) => (
              <Pressable
                key={cat.key}
                onPress={() => {
                  tap('light');
                  router.push({
                    pathname: '/(client)/(tabs)/search',
                    params: { category: cat.key },
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel={cat.label}
                style={styles.category}
              >
                <View
                  style={[
                    styles.categoryTile,
                    { backgroundColor: c.surface, borderColor: c.border },
                  ]}
                >
                  <Icon name={categoryIcon(cat.key)} size="lg" color={c.primaryText} />
                </View>
                <Text v="caption" tone="textSecondary" center numberOfLines={2}>
                  {cat.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* ── Cupones ── */}
        {coupons.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Cupones activos" subtitle="Aplícalos al confirmar tu pedido" />
            <FlatList
              horizontal
              data={coupons}
              keyExtractor={(item: any) => item._id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.hList}
              renderItem={({ item }) => <CouponCard coupon={item} />}
            />
          </View>
        ) : null}

        {/* ── Destacados ── */}
        {featured.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader
              title="Los que más piden"
              action="Ver todos"
              onAction={() => router.push('/(client)/(tabs)/search')}
            />
            <FlatList
              horizontal
              data={featured}
              keyExtractor={(item) => item._id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.hList}
              renderItem={({ item }) => (
                <BusinessFeatured
                  business={item}
                  width={Math.min(width * 0.58, 240)}
                  onPress={() => goToBusiness(item._id)}
                />
              )}
            />
          </View>
        ) : null}

        {/* ── Abiertos ahora ── */}
        <View style={styles.section}>
          <SectionHeader
            title="Abiertos ahora"
            subtitle={openNow.length ? `${openNow.length} locales disponibles en Garzón` : undefined}
          />

          {isError ? (
            <ErrorState onRetry={refetch} />
          ) : isLoading ? (
            <View style={styles.skeletons}>
              <BusinessCardSkeleton />
              <BusinessCardSkeleton />
              <BusinessCardSkeleton />
            </View>
          ) : openNow.length === 0 ? (
            <EmptyState
              icon="reloj"
              title="Todo cerrado por ahora"
              message="Los negocios de Garzón abren temprano. Vuelve en un rato y te esperamos con todo listo."
              actionLabel="Ver todos los negocios"
              onAction={() => router.push('/(client)/(tabs)/search')}
              compact
            />
          ) : (
            <View style={styles.list}>
              {openNow.map((business) => (
                <BusinessRow
                  key={business._id}
                  business={business}
                  onPress={() => goToBusiness(business._id)}
                />
              ))}
            </View>
          )}
        </View>

        {/* ── Cerrados ── */}
        {closed.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Abren más tarde" subtitle="Puedes ver sus menús y horarios" />
            <View style={styles.list}>
              {closed.map((business) => (
                <BusinessRow
                  key={business._id}
                  business={business}
                  onPress={() => goToBusiness(business._id)}
                />
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────

/** Tarjeta de "lo de siempre". Un toque rearma la bolsa completa. */
function UsualCard({ item, onPress }: { item: UsualOrder; onPress: () => void }) {
  const { c } = useTheme();
  const accent = businessAccent(item.businessId);

  return (
    <Card
      onPress={onPress}
      padded={false}
      style={styles.usual}
      accessibilityLabel={`Repetir pedido de ${item.businessName}: ${item.summary}. Total anterior ${money(item.total)}`}
      accessibilityHint="Agrega estos productos a tu bolsa"
    >
      <View style={styles.usualTop}>
        <View style={[styles.usualIcon, { backgroundColor: accent }]}>
          <Icon name={categoryIcon(item.businessCategory)} size="md" color="#FFFFFF" />
        </View>
        {item.timesOrdered > 1 ? (
          <Badge label={`${item.timesOrdered} veces`} tone="lime" icon="racha" />
        ) : null}
      </View>

      <View style={styles.usualBody}>
        <Text v="titleS" numberOfLines={1}>{item.businessName}</Text>
        <Text v="bodyS" tone="textSecondary" numberOfLines={2}>{item.summary}</Text>
      </View>

      <View style={[styles.usualCta, { backgroundColor: c.primarySoft }]}>
        <Icon name="repetir" size="sm" color={c.primaryText} />
        <Text v="strongS" tone="primaryText">Pedir otra vez</Text>
        <Text v="dataS" tone="textMuted" style={styles.usualPrice}>{money(item.total)}</Text>
      </View>
    </Card>
  );
}

/** Cupón vigente. El código se muestra grande porque hay que escribirlo. */
function CouponCard({ coupon }: { coupon: any }) {
  const { c } = useTheme();

  const benefit =
    coupon.type === 'free_delivery'
      ? 'Envío gratis'
      : coupon.type === 'percentage'
        ? coupon.maxDiscount > 0
          ? `${coupon.value}% hasta ${money(coupon.maxDiscount)}`
          : `${coupon.value}% de descuento`
        : `${money(coupon.value)} de descuento`;

  return (
    <View style={[styles.coupon, { backgroundColor: c.limeSoft, borderColor: c.limeSoftBorder }]}>
      <View style={styles.couponTop}>
        <Icon name="cupon" size="md" color={c.limeText} />
        <Text v="strongM" numberOfLines={1} style={styles.flex}>{benefit}</Text>
      </View>
      <Text v="bodyS" tone="textSecondary" numberOfLines={2}>{coupon.title}</Text>
      <View style={[styles.couponCode, { borderColor: c.limeSoftBorder }]}>
        <Text v="code" tone="limeText">{coupon.code}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  content: { paddingBottom: BOTTOM_SPACE },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.md,
  },
  headerLeft: { flex: 1, gap: 1 },
  bell: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },

  address: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  addressIcon: {
    width: 34, height: 34, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  addressBody: { flex: 1, gap: 1 },

  searchStub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    height: 54,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },
  list: { gap: Spacing.md },
  skeletons: { gap: Spacing.md },

  usual: { width: 236, gap: Spacing.md, padding: Spacing.md },
  usualTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  usualIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  usualBody: { gap: 2, minHeight: 52 },
  usualCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
    height: 42,
    borderRadius: BorderRadius.md,
  },
  usualPrice: { marginLeft: 'auto' },

  categories: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.sm },
  category: { flex: 1, alignItems: 'center', gap: Spacing.sm },
  categoryTile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    ...Shadow.sm,
  },

  coupon: {
    width: 232,
    gap: Spacing.sm,
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  couponTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  couponCode: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: Spacing.xs,
  },
});
