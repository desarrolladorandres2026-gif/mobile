import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon, IconButton, EmptyState, Screen, Header } from '../../components/ui';
import { BusinessRow } from '../../components/domain/BusinessCard';
import { useFavorites, useFavoritesList } from '../../hooks/useFavorites';
import { productImageUri, productImagePlaceholder, hasProductImage } from '../../lib/productImage';
import { money } from '../../lib/format';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

type Tab = 'businesses' | 'products';

/**
 * Favoritos: negocios y platos.
 *
 * `favoritesApi` soporta `kind: 'product'` desde siempre —mismo endpoint,
 * mismo verbo que el corazón de negocio, ver `components/domain/business/
 * [id].tsx`— y esta pantalla solo pintaba `data.businesses`. Un plato
 * marcado favorito quedaba guardado en el servidor y en ningún sitio
 * visible.
 */
export default function FavoritesScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const [tab, setTab] = useState<Tab>('businesses');

  // Estable, para que el `memo` de `BusinessRow` no se anule en cada render.
  const openBusiness = useCallback(
    (id: string) => router.push(`/(client)/business/${id}`),
    [router]
  );

  // La lista viene del servidor: sobrevive a cambiar de teléfono.
  const { data, isLoading } = useFavoritesList();
  const { toggle: toggleFavorite } = useFavorites();

  const businesses = data?.businesses ?? [];
  const products = data?.products ?? [];
  const list = tab === 'businesses' ? businesses : products;

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Favoritos" fallback="/(client)/(tabs)/profile" />

      <View style={styles.top}>
        <View style={[styles.segments, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
          <Segment
            label="Negocios"
            count={businesses.length}
            active={tab === 'businesses'}
            onPress={() => setTab('businesses')}
          />
          <Segment
            label="Platos"
            count={products.length}
            active={tab === 'products'}
            onPress={() => setTab('products')}
          />
        </View>
      </View>

      {tab === 'businesses' ? (
        <FlatList
          key="businesses"
          data={businesses}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={8}
          ListHeaderComponent={
            businesses.length > 0 ? (
              <View
                style={[
                  styles.infoCard,
                  { backgroundColor: c.surface, borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)' },
                ]}
              >
                <Text v="bodyM" tone="textSecondary">
                  {businesses.length} {businesses.length === 1 ? 'negocio guardado' : 'negocios guardados'}.
                  Toca el corazón en cualquier negocio para agregarlo.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            // El corazón ya vive sobre la foto de la propia fila (ver
            // `BusinessRow`): envolverla otra vez en una tarjeta con borde
            // era duplicar el marco que la fila ya trae.
            <BusinessRow
              business={item}
              showStatus={false}
              onPress={openBusiness}
              favorite
              onToggleFavorite={(id) => { tap('light'); toggleFavorite(id); }}
            />
          )}
          ListEmptyComponent={
            isLoading ? null : (
              <View
                style={[
                  styles.emptyCard,
                  { backgroundColor: c.surface, borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)' },
                ]}
              >
                <EmptyState
                  icon="favorito"
                  title="Sin negocios favoritos todavía"
                  message="Guarda los negocios a los que más pides y tenlos siempre a la mano."
                  actionLabel="Explorar negocios"
                  onAction={() => router.push('/(client)/(tabs)/search')}
                />
              </View>
            )
          }
        />
      ) : (
        <FlatList
          key="products"
          data={products}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={8}
          ListHeaderComponent={
            products.length > 0 ? (
              <View
                style={[
                  styles.infoCard,
                  { backgroundColor: c.surface, borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)' },
                ]}
              >
                <Text v="bodyM" tone="textSecondary">
                  {products.length} {products.length === 1 ? 'plato guardado' : 'platos guardados'}.
                  Toca el corazón en cualquier plato para agregarlo.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ProductRow
              product={item}
              onPress={() => {
                // No hay ficha de producto suelta: el plato se pide desde
                // la carta del negocio, que es donde viven los extras y el
                // resto de la carta con la que se combina.
                const businessId =
                  typeof item.businessId === 'string' ? item.businessId : item.businessId?._id;
                if (businessId) openBusiness(businessId);
              }}
              onRemove={() => { tap('light'); toggleFavorite(item._id, 'product'); }}
            />
          )}
          ListEmptyComponent={
            isLoading ? null : (
              <View
                style={[
                  styles.emptyCard,
                  { backgroundColor: c.surface, borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)' },
                ]}
              >
                <EmptyState
                  icon="favorito"
                  title="Sin platos favoritos todavía"
                  message="Guarda los platos a los que más vuelves y encuéntralos rápido en cada carta."
                  actionLabel="Explorar negocios"
                  onAction={() => router.push('/(client)/(tabs)/search')}
                />
              </View>
            )
          }
        />
      )}
    </Screen>
  );
}

function Segment({
  label, count, active, onPress,
}: { label: string; count: number; active: boolean; onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'guardado' : 'guardados'}`}
      style={[styles.segment, active && { backgroundColor: c.surface }]}
    >
      <Text v="strongS" tone={active ? 'text' : 'textMuted'}>{label}</Text>
      {count > 0 ? (
        <Text v="dataXS" tone={active ? 'primaryText' : 'textMuted'}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

function ProductRow({
  product, onPress, onRemove,
}: { product: any; onPress: () => void; onRemove: () => void }) {
  const { c, isDark } = useTheme();
  const businessName =
    typeof product.businessId === 'object' ? product.businessId?.name : undefined;
  const businessRating: number | undefined =
    typeof product.businessId === 'object' ? product.businessId?.rating : undefined;

  return (
    <View
      style={[
        styles.rowCard,
        { backgroundColor: c.surface, borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)' },
      ]}
    >
      <Pressable
        onPress={onPress}
        style={styles.productRow}
        accessibilityRole="button"
        accessibilityLabel={`${product.name}${businessName ? `, de ${businessName}` : ''}. ${money(product.discountPrice ?? product.price)}`}
        accessibilityHint="Abre la carta del negocio"
      >
        <View style={[styles.productImage, { backgroundColor: c.surfaceLight }]}>
          {hasProductImage(product) ? (
            <Image
              source={{ uri: productImageUri(product, 'thumb')! }}
              placeholder={productImagePlaceholder(product)}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={product._id}
            />
          ) : (
            <Icon name="bolsa" size="md" color={c.textMuted} />
          )}
        </View>

        <View style={styles.flex}>
          <Text v="strongS" numberOfLines={1}>{product.name}</Text>
          {businessName ? (
            <View style={styles.businessRow}>
              <Text v="caption" tone="textMuted" numberOfLines={1}>{businessName}</Text>
              {businessRating ? (
                <View style={styles.rating}>
                  <Icon name="calificacion" size={11} color={c.warning} />
                  <Text v="caption" tone="textMuted">{businessRating.toFixed(1)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          <Text v="dataS" tone="primaryText">{money(product.discountPrice ?? product.price)}</Text>
        </View>
      </Pressable>

      <IconButton
        icon="favorito"
        label={`Quitar ${product.name} de favoritos`}
        tone="danger"
        filled
        onPress={onRemove}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  businessRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 3 },
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
  list: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.huge },
  infoCard: {
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: Spacing.xs,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: 22,
    borderWidth: 1,
    gap: Spacing.sm,
  },
  productRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  productImage: {
    width: 52,
    height: 52,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  emptyCard: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
