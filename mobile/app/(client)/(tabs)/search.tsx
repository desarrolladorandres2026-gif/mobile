import { useState, useEffect, useMemo } from 'react';
import { View, FlatList, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, SearchField, Chip, EmptyState, ErrorState,
  BusinessCardSkeleton, Badge, Card,
} from '../../../components/ui';
import { BusinessRow, type Business } from '../../../components/domain/BusinessCard';
import { CategoryTile } from '../../../components/domain/CategoryTile';
import { useBusinesses, useSearch, usePopularSearches, useDeliveryCoords } from '../../../hooks/useApi';
import type { ProductSearchHit } from '../../../services/endpoints';
import { productImageUri } from '../../../lib/productImage';
import { Image } from 'expo-image';
import { useHomeCategories, type DisplayCategory } from '../../../hooks/useHomeCategories';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { usePrefsStore } from '../../../stores/prefsStore';
import { categoryIcon } from '../../../theme/icons';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { openState } from '../../../lib/business';
import { tap } from '../../../lib/haptics';


// Red de seguridad: el servidor ya devuelve las categorías reales del
// catálogo en `/search/popular`, pero si esa consulta falla, una lista vacía
// dejaría la pantalla de descubrimiento en blanco.
const FALLBACK_SEARCHES = [
  'Hamburguesas', 'Pizza', 'Salchipapas', 'Café',
  'Pollo Broaster', 'Droguería', 'Desayunos', 'Helados',
];

/** Espera a que el usuario deje de escribir antes de consultar al servidor. */
function useDebounced<T>(value: T, delay = 320): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export default function SearchScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);
  const params = useLocalSearchParams<{ category?: string }>();

  const recentSearches = usePrefsStore((s) => s.recentSearches || []);
  const addRecentSearch = usePrefsStore((s) => s.addRecentSearch);
  const removeRecentSearch = usePrefsStore((s) => s.removeRecentSearch);
  const clearRecentSearches = usePrefsStore((s) => s.clearRecentSearches);

  const { categories } = useHomeCategories();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(params.category ?? null);
  const [openOnly, setOpenOnly] = useState(false);

  // Al llegar desde una categoría de Inicio, el filtro ya viene puesto y no
  // se abre el teclado: el usuario venía a mirar, no a escribir.
  useEffect(() => {
    if (params.category) setCategory(params.category);
  }, [params.category]);

  const debouncedQuery = useDebounced(query);

  // Guardar en recientes cuando haya un término de búsqueda válido
  useEffect(() => {
    const clean = debouncedQuery.trim();
    if (clean.length >= 3) {
      addRecentSearch(clean);
    }
  }, [debouncedQuery, addRecentSearch]);

  const term = debouncedQuery.trim();
  const hasTerm = term.length >= 2;

  // Dos fuentes según lo que esté haciendo el usuario. Con término escrito
  // manda la búsqueda de catálogo, que también encuentra platos; navegando
  // por categorías manda el listado de negocios de siempre, que es el que
  // sabe filtrar por categoría.
  // Las tendencias salen de las categorías reales del catálogo. Antes era
  // una lista escrita a mano que podía anunciar cosas que nadie vende.
  const { data: serverPopular } = usePopularSearches();
  const popularTerms = serverPopular?.length ? serverPopular : FALLBACK_SEARCHES;

  const catalog = useSearch(term);
  const coords = useDeliveryCoords();
  const listing = useBusinesses({
    category: category || undefined,
    ...(coords ?? {}),
  }) as { data: Business[]; isLoading: boolean; isError: boolean; refetch: () => void };

  const data: Business[] = hasTerm
    ? ((catalog.data?.businesses ?? []) as Business[])
    : listing.data;
  const products: ProductSearchHit[] = hasTerm ? catalog.data?.products ?? [] : [];
  const isLoading = hasTerm ? catalog.isLoading : listing.isLoading;
  const isError = hasTerm ? catalog.isError : listing.isError;
  const refetch = hasTerm ? catalog.refetch : listing.refetch;

  const results = useMemo(() => {
    const list = openOnly ? data.filter((b) => openState(b.schedule).open) : data;
    // Los abiertos primero: pedirle a alguien que descubra un local cerrado
    // solo genera un viaje en falso.
    return [...list].sort((a, b) => {
      const aOpen = openState(a.schedule).open ? 1 : 0;
      const bOpen = openState(b.schedule).open ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return b.rating - a.rating;
    });
  }, [data, openOnly]);

  const searching = query.trim().length > 0 || !!category;
  const activeCategory = categories.find((cat) => cat.key === category);

  const handleSelectTag = (term: string) => {
    tap('select');
    setQuery(term);
    addRecentSearch(term);
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.top}>
        <Text v="displayM">Explorar</Text>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Hamburguesa, droguería, café…"
          onFilters={() => { tap('select'); setOpenOnly((v) => !v); }}
          filtersActive={openOnly}
        />

        <FlatList
          horizontal
          data={categories}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={6}
          renderItem={({ item }) => (
            <Chip
              label={item.label}
              icon={categoryIcon(item.key)}
              active={category === item.key}
              onPress={() => {
                tap('select');
                setCategory(category === item.key ? null : item.key);
              }}
            />
          )}
        />

        {/* Resumen de lo que está filtrado, con salida rápida. */}
        {(openOnly || category) && !isLoading ? (
          <View style={styles.summary}>
            <Text v="bodyS" tone="textMuted">
              {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
              {activeCategory ? ` en ${activeCategory.label.toLowerCase()}` : ''}
            </Text>
            {openOnly ? (
              <Pressable
                onPress={() => { tap('light'); setOpenOnly(false); }}
                accessibilityRole="button"
                accessibilityLabel="Quitar el filtro de abiertos ahora"
              >
                <Badge label="Solo abiertos" tone="primary" icon="cerrar" />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      {isError ? (
        <ErrorState onRetry={refetch} />
      ) : isLoading ? (
        <View style={styles.skeletons}>
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item._id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={8}
          renderItem={({ item }) => (
            <BusinessRow
              business={item}
              onPress={() => router.push(`/(client)/business/${item._id}`)}
            />
          )}
          ListHeaderComponent={
            products.length ? (
              <View style={styles.productsBlock}>
                <View style={styles.sectionTitleRow}>
                  <Icon name="bolsa" size="sm" color={c.primary} />
                  <Text v="strongS">Platos y productos</Text>
                </View>

                {products.map((product) => (
                  <ProductHit
                    key={product._id}
                    product={product}
                    onPress={() => {
                      tap('select');
                      // Se navega al negocio, no a una ficha suelta: para
                      // pedir un plato hay que entrar en su carta de todas
                      // formas, y saltarse ese paso deja el carrito sin
                      // saber a qué local pertenece.
                      router.push(`/(client)/business/${product.businessId}`);
                    }}
                  />
                ))}

                {data.length ? (
                  <View style={styles.sectionTitleRow}>
                    <Icon name="negocio" size="sm" color={c.primary} />
                    <Text v="strongS">Negocios</Text>
                  </View>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            products.length ? null : searching ? (
              <EmptyState
                icon="explorar"
                title="Nada con esa búsqueda"
                message={
                  openOnly
                    ? 'Prueba quitando el filtro de "solo abiertos" o busca otra cosa.'
                    : 'Revisa cómo lo escribiste o explora alguna de las categorías disponibles.'
                }
                actionLabel="Limpiar filtros"
                onAction={() => { setQuery(''); setCategory(null); setOpenOnly(false); }}
              />
            ) : (
              <DiscoveryHub
                popularTerms={popularTerms}
                recentSearches={recentSearches}
                categories={categories}
                onSelectSearch={handleSelectTag}
                onRemoveRecent={(term) => { tap('light'); removeRecentSearch(term); }}
                onClearRecents={() => { tap('light'); clearRecentSearches(); }}
                onPickCategory={(key) => { tap('select'); setCategory(key); }}
              />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

/**
 * Un producto en los resultados.
 *
 * Lleva el nombre del negocio debajo porque, sin él, encontrar "hamburguesa
 * doble" no dice dónde pedirla: el plato solo es útil junto al sitio que lo
 * hace.
 */
function ProductHit({
  product,
  onPress,
}: {
  product: ProductSearchHit;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const uri = productImageUri(product as never, 'thumb');
  const price = product.discountPrice ?? product.price;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.hit, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityRole="button"
      accessibilityLabel={`${product.name} en ${product.businessName}`}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.hitImage} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.hitImage, { backgroundColor: c.background }]} />
      )}

      <View style={styles.hitBody}>
        <Text v="strongS" numberOfLines={1}>{product.name}</Text>
        <Text v="caption" tone="textMuted" numberOfLines={1}>{product.businessName}</Text>
      </View>

      <Text v="dataM" color={c.primary}>
        ${price.toLocaleString('es-CO')}
      </Text>
    </Pressable>
  );
}

/** Descubrimiento inicial: Búsquedas recientes, Tendencias y Categorías */
function DiscoveryHub({
  popularTerms,
  recentSearches,
  categories,
  onSelectSearch,
  onRemoveRecent,
  onClearRecents,
  onPickCategory,
}: {
  popularTerms: string[];
  recentSearches: string[];
  categories: DisplayCategory[];
  onSelectSearch: (term: string) => void;
  onRemoveRecent: (term: string) => void;
  onClearRecents: () => void;
  onPickCategory: (key: string) => void;
}) {
  const { c } = useTheme();

  return (
    <Animated.View entering={FadeIn.duration(250)} style={styles.discovery}>
      {/* ── Recientes ── */}
      {recentSearches.length > 0 ? (
        <View style={styles.discoverySection}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="reintentar" size="sm" color={c.textMuted} />
              <Text v="strongS">Búsquedas recientes</Text>
            </View>
            <Pressable onPress={onClearRecents} hitSlop={8}>
              <Text v="caption" tone="primaryText">Borrar todo</Text>
            </Pressable>
          </View>
          <View style={styles.tagsWrap}>
            {recentSearches.map((term) => (
              <Pressable
                key={term}
                onPress={() => onSelectSearch(term)}
                style={[styles.recentTag, { backgroundColor: c.surface, borderColor: c.border }]}
              >
                <Text v="bodyS">{term}</Text>
                <Pressable
                  onPress={() => onRemoveRecent(term)}
                  hitSlop={6}
                  style={styles.tagClose}
                >
                  <Icon name="cerrar" size={12} color={c.textMuted} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* ── Populares / Tendencias ── */}
      <View style={styles.discoverySection}>
        <View style={styles.sectionTitleRow}>
          <Icon name="racha" size="sm" color={c.primary} />
          <Text v="strongS">Lo más buscado</Text>
        </View>
        <View style={styles.tagsWrap}>
          {popularTerms.map((term) => (
            <Pressable
              key={term}
              onPress={() => onSelectSearch(term)}
              style={[styles.popularTag, { backgroundColor: c.primarySoft, borderColor: 'transparent' }]}
            >
              <Text v="bodyS" color={c.primaryText}>{term}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Categorías principales ── */}
      <View style={styles.discoverySection}>
        <Text v="titleM">Explorar por categoría</Text>
        <View style={styles.suggestionGrid}>
          {categories.map((cat) => (
            <Pressable
              key={cat.key}
              onPress={() => onPickCategory(cat.key)}
              accessibilityRole="button"
              accessibilityLabel={cat.label}
              style={[styles.suggestion, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <CategoryTile
                categoryKey={cat.key}
                label={cat.label}
                imageUrl={cat.imageUrl}
                layout="icon"
              />
              <Text v="strongS" style={styles.flex}>{cat.label}</Text>
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Pressable>
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  productsBlock: { gap: Spacing.sm, marginBottom: Spacing.md },
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  hitImage: { width: 52, height: 52, borderRadius: BorderRadius.md },
  hitBody: { flex: 1, gap: 2 },

  screen: { flex: 1 },
  flex: { flex: 1 },
  top: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: Spacing.lg },
  chips: { gap: Spacing.sm, paddingRight: Spacing.xl },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  list: {
    padding: Spacing.xl,
    paddingTop: Spacing.lg,
    gap: Spacing.md,
  },
  skeletons: { padding: Spacing.xl, gap: Spacing.md },

  discovery: { gap: Spacing.xxl, paddingTop: Spacing.md },
  discoverySection: { gap: Spacing.md },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  tagsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  recentTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },
  tagClose: {
    padding: 2,
    marginLeft: 2,
  },
  popularTag: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },

  suggestionGrid: { gap: Spacing.sm },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
});

