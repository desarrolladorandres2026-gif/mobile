import { useMemo, memo } from 'react';
import {
  View, FlatList, Pressable, RefreshControl, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, {
  FadeIn, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue,
} from 'react-native-reanimated';
import { Text, Icon, SectionHeader, Badge } from '../../../components/ui';
import { PromoCarousel } from '../../../components/domain/PromoCarousel';
import { ProductCollectionRow } from '../../../components/domain/ProductCollectionRow';
import { ProductBannerBlock } from '../../../components/domain/ProductBannerBlock';
import { BusinessBannerBlock } from '../../../components/domain/BusinessBannerBlock';
import { BusinessCollectionRow } from '../../../components/domain/BusinessCollectionRow';
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
import { useProgressiveLimit } from '../../../hooks/useProgressiveLimit';

/** Colecciones del Inicio que se montan con la pantalla (ver `useProgressiveLimit`). */
const INITIAL_HOME_SECTIONS = 3;

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
  // Las primeras colecciones con la pantalla; el resto (hasta veinte, con
  // sus fotos) un instante después, en vez de todas en el mismo fotograma.
  const sectionLimit = useProgressiveLimit(INITIAL_HOME_SECTIONS);

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
      color: cat.color,
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

  // El encabezado (saludo + dirección + buscador) queda fijo fuera del
  // scroll; solo se sombrea cuando el contenido de abajo ya se movió, para
  // que se note que quedó pegado arriba.
  //
  // El scroll de este Home convive con carruseles con su propia animación
  // (letrero de categorías, banners) — leer la posición con `onScroll` de
  // React Native dispara un evento por el puente a JS y un re-render de
  // `HomeScreen` en cada frame de scroll, compitiendo por el mismo hilo JS
  // que esos carruseles. `useAnimatedScrollHandler` lee la posición en el
  // hilo de UI, así que el borde/sombra se anima sin tocar React en absoluto.
  const scrollY = useSharedValue(0);
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const headerShadowStyle = useAnimatedStyle(() => {
    const active = scrollY.value > 4;
    return {
      borderBottomColor: active ? c.border : 'transparent',
      shadowOpacity: active ? 0.08 : 0,
      elevation: active ? 4 : 0,
    };
  });

  // El letrero de Categorías se mueve solo; fuera de la vista no tiene por
  // qué hacer trabajar al teléfono. En teléfonos pequeños arranca incluso por
  // debajo del pliegue, detrás de "Lo de siempre" y las promociones.
  const viewportH = useSharedValue(0);
  const categoriesTop = useSharedValue(0);
  const categoriesBottom = useSharedValue(0);
  const categoriesOffscreen = useDerivedValue(() =>
    viewportH.value > 0 &&
    (scrollY.value > categoriesBottom.value ||
      scrollY.value + viewportH.value < categoriesTop.value)
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <Animated.View
        style={[
          styles.fixedHeader,
          { backgroundColor: c.background },
          styles.fixedHeaderShadow,
          headerShadowStyle,
        ]}
      >
        {/* ── Cabecera: saludo y dirección a la izquierda, logo a la derecha ── */}
        <View style={styles.header}>
          <Pressable
            onPress={() => { tap('light'); router.push('/(client)/addresses'); }}
            accessibilityRole="button"
            accessibilityLabel={
              defaultAddress
                ? `${greeting()}, ${firstName(user?.name) || 'qué más'}. Entregar en ${defaultAddress.label}, ${defaultAddress.address}. Toca para cambiar`
                : `${greeting()}, ${firstName(user?.name) || 'qué más'}. Toca para agregar una dirección de entrega`
            }
            style={styles.headerText}
          >
            <Text v="titleM" numberOfLines={1}>
              {greeting()}, {firstName(user?.name) || 'qué más'}
            </Text>
            <View style={styles.addressRow}>
              <Icon name="ubicacion" size="sm" color={c.textMuted} />
              <Text v="strongS" numberOfLines={1} style={styles.addressText}>
                {defaultAddress ? defaultAddress.label : 'agrega tu dirección'}
                {defaultAddress ? (
                  <Text v="strongS" tone="textMuted"> · {defaultAddress.address}</Text>
                ) : null}
              </Text>
              <Icon name="desplegar" size="sm" color={c.textMuted} />
            </View>
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
      </Animated.View>

      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomSpace }}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        onLayout={(e) => { viewportH.value = e.nativeEvent.layout.height; }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        }
      >
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
        {/* `onLayout` da la posición dentro del contenido del scroll (es
            hijo directo) y se vuelve a disparar si lo de arriba cambia de alto. */}
        <View
          style={styles.section}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            categoriesTop.value = y;
            categoriesBottom.value = y + height;
          }}
        >
          <SectionHeader title="Categorías" />
          <CategoryMarquee categories={marqueeCategories} offscreen={categoriesOffscreen} />
        </View>

        {/* ── Secuencia del inicio: colecciones automáticas + bloques
            curados por un admin (spotlights, colecciones de negocios) +
            banners promocionales anclados a una posición — todo ya viene
            fusionado y ordenado desde `/home-sections`. ── */}
        {homeSections.slice(0, sectionLimit).map((entry) => {
          switch (entry.kind) {
            case 'collection':
              return <ProductCollectionRow key={entry.key} section={entry} largeNames />;
            case 'productBanner':
              return <ProductBannerBlock key={`productBanner-${entry.order}`} entry={entry} />;
            case 'businessBanner':
              return <BusinessBannerBlock key={`businessBanner-${entry.order}`} entry={entry} />;
            case 'businessCollection':
              return <BusinessCollectionRow key={`businessCollection-${entry.order}`} entry={entry} />;
            case 'promo':
              return <PromoCarousel key={`promo-${entry.order}`} banners={entry.banners} />;
            default:
              return null;
          }
        })}
      </Animated.ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────

/** Tarjeta de "lo de siempre". Un toque rearma la bolsa completa. */
const UsualCard = memo(function UsualCard({ item, onPress }: { item: UsualOrder; onPress: () => void }) {
  const { c } = useTheme();
  const Illustration = categoryIllustration(item.businessCategory);

  return (
    <Pressable
      onPress={() => { tap('light'); onPress(); }}
      accessibilityRole="button"
      style={styles.usual}
      accessibilityLabel={`Repetir pedido de ${item.businessName}: ${item.summary}. Total anterior ${money(item.total)}`}
      accessibilityHint="Agrega estos productos a tu bolsa"
    >
      <View style={styles.usualTop}>
        <Illustration size={30} />
        {item.timesOrdered > 1 ? (
          <Badge label={`${item.timesOrdered} veces`} tone="lime" icon="racha" />
        ) : null}
      </View>

      <View style={styles.usualBody}>
        <Text v="titleS" numberOfLines={1}>{item.businessName}</Text>
        <Text v="bodyS" tone="textSecondary" numberOfLines={2}>{item.summary}</Text>
      </View>

      <View style={styles.usualCta}>
        <Icon name="repetir" size="sm" color={c.primaryText} />
        <Text v="strongS" tone="primaryText">Pedir otra vez</Text>
        <Text v="dataS" tone="textMuted" style={styles.usualPrice}>{money(item.total)}</Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },

  fixedHeader: {
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },
  fixedHeaderShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    gap: Spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  addressText: {
    flexShrink: 1,
  },
  searchStub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    height: 44,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },

  usual: { width: 236, gap: Spacing.md },
  usualTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  usualBody: { gap: 2, minHeight: 52 },
  usualCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
  },
  usualPrice: { marginLeft: 'auto' },
});
