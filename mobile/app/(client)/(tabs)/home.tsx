import { useMemo, memo } from 'react';
import {
  View, ScrollView, FlatList, Pressable, RefreshControl, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Icon, Card, SectionHeader, Badge } from '../../../components/ui';
import { PromoCarousel } from '../../../components/domain/PromoCarousel';
import { ProductCollectionRow } from '../../../components/domain/ProductCollectionRow';
import { CategoryMarquee, type MarqueeCategory } from '../../../components/domain/CategoryMarquee';
import { useAuthStore } from '../../../stores/authStore';
import { useAddresses, useDeliveryCoords, useHomeSections } from '../../../hooks/useApi';
import { useUsual, reorder, type UsualOrder } from '../../../hooks/useUsual';
import { useHomeCategories } from '../../../hooks/useHomeCategories';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { categoryIllustration } from '../../../components/illustrations';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { greeting, firstName, money } from '../../../lib/format';
import { tap } from '../../../lib/haptics';

export default function HomeScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);
  const user = useAuthStore((s) => s.user);

  // La distancia se mide desde la dirección de entrega, no desde el GPS.
  const { coords, ready: coordsReady } = useDeliveryCoords();

  const { data: addresses = [] } = useAddresses();
  const { usual } = useUsual();
  const { categories } = useHomeCategories();
  // Las colecciones dinámicas del inicio: "Los más pedidos", "Descuentos
  // locos"... una sola petición para las veinte, ya filtradas y con las
  // vacías escondidas por el propio servidor. Es lo único que hay debajo
  // de Categorías: reemplaza a Cupones, Destacados y las listas de
  // negocios que vivían ahí antes.
  const { data: homeSections = [], refetch, isRefetching } = useHomeSections(coords, coordsReady);

  const defaultAddress = useMemo(
    () => addresses.find((a: any) => a.isDefault) ?? addresses[0],
    [addresses]
  );

  // Cuadros del letrero de Categorías: las categorías del admin y, al final,
  // la salida de "no está en carta" — que no lleva a una lista de negocios
  // sino al flujo de mandados.
  const marqueeCategories = useMemo<MarqueeCategory[]>(() => [
    ...categories.map((cat) => ({
      key: cat.key,
      label: cat.label,
      imageUrl: cat.imageUrl,
      onPress: () =>
        router.push({
          pathname: '/(client)/(tabs)/search',
          params: { category: cat.key },
        }),
    })),
    {
      key: 'errand',
      label: 'No está en carta',
      onPress: () => router.push('/(client)/errand'),
    },
  ], [categories, router]);

  const repeatOrder = (item: UsualOrder) => {
    tap('medium');
    reorder(item);
    router.push('/(client)/cart');
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomSpace }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
        {/* ── Cabecera: saludo + dirección en una sola línea ── */}
        <View style={styles.header}>
          <Pressable
            onPress={() => { tap('light'); router.push('/(client)/addresses'); }}
            accessibilityRole="button"
            accessibilityLabel={
              defaultAddress
                ? `${greeting()}, ${firstName(user?.name) || 'qué más'}. Entregar en ${defaultAddress.label}, ${defaultAddress.address}. Toca para cambiar`
                : `${greeting()}, ${firstName(user?.name) || 'qué más'}. Toca para agregar una dirección de entrega`
            }
            style={styles.greetingRow}
          >
            <Icon name="ubicacion" size="sm" color={c.textMuted} />
            <Text v="bodyM" numberOfLines={1} style={styles.flex}>
              <Text v="bodyM" tone="textMuted">{greeting()}, </Text>
              <Text v="titleS">{firstName(user?.name) || 'qué más'}</Text>
              <Text v="bodyM" tone="textMuted"> · Entregar en </Text>
              <Text v="strongM">
                {defaultAddress ? defaultAddress.label : 'agrega tu dirección'}
              </Text>
            </Text>
            <Icon name="desplegar" size="sm" color={c.textMuted} />
          </Pressable>
        </View>

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
              removeClippedSubviews
              maxToRenderPerBatch={10}
              windowSize={9}
              initialNumToRender={6}
              renderItem={({ item }) => (
                <UsualCard item={item} onPress={() => repeatOrder(item)} />
              )}
            />
          </Animated.View>
        ) : null}

        {/* ── Promociones ── */}
        {/* Se dibuja solo si el servidor mandó banners vigentes; si no,
            Categorías sube y no queda ningún hueco. */}
        <PromoCarousel />

        {/* ── Categorías ── */}
        <View style={styles.section}>
          <SectionHeader title="Categorías" />
          <CategoryMarquee categories={marqueeCategories} />
        </View>

        {/* ── Colecciones dinámicas: mezclan productos de varios comercios ── */}
        {homeSections.map((section) => (
          <ProductCollectionRow key={section.key} section={section} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────

/** Tarjeta de "lo de siempre". Un toque rearma la bolsa completa. */
const UsualCard = memo(function UsualCard({ item, onPress }: { item: UsualOrder; onPress: () => void }) {
  const { c } = useTheme();
  const Illustration = categoryIllustration(item.businessCategory);

  return (
    <Card
      onPress={onPress}
      padded={false}
      style={styles.usual}
      accessibilityLabel={`Repetir pedido de ${item.businessName}: ${item.summary}. Total anterior ${money(item.total)}`}
      accessibilityHint="Agrega estos productos a tu bolsa"
    >
      <View style={styles.usualTop}>
        <View style={[styles.usualIcon, { backgroundColor: c.surfaceLight }]}>
          <Illustration size={30} />
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
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.md,
  },
  greetingRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  searchStub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    height: 54,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },

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
});
