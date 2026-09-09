import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { View, FlatList, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, SearchField, CategoryChip, EmptyState, ErrorState,
  BusinessCardSkeleton, Badge, Card,
} from '../../../components/ui';
import { BusinessRow, type Business } from '../../../components/domain/BusinessCard';
import { CategoryTile } from '../../../components/domain/CategoryTile';
import { categoryIllustration, ContentIcon } from '../../../components/illustrations';
import {
  SearchFiltersSheet, NO_FILTERS, countActiveFilters,
  type SearchFilters,
} from '../../../components/domain/SearchFiltersSheet';
import {
  useBusinesses, useSearch, useSearchSuggestions, usePopularSearches, useDeliveryCoords,
} from '../../../hooks/useApi';
import { searchApi, type ProductSearchHit, type SearchSuggestion } from '../../../services/endpoints';
import { productImageUri, productImagePlaceholder } from '../../../lib/productImage';
import { Image } from 'expo-image';
import { useHomeCategories, type DisplayCategory } from '../../../hooks/useHomeCategories';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { usePrefsStore } from '../../../stores/prefsStore';
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

/**
 * Cuántos resultados hacen falta para que la lista llene la pantalla.
 *
 * Por debajo de eso se pide otra página sola: los filtros se aplican en el
 * teléfono, así que una página entera puede quedarse en dos resultados y sin
 * altura suficiente `onEndReached` no llega a dispararse nunca.
 */
const MIN_VISIBLE = 6;
/** Ver el comentario del efecto de relleno automático. */
const MAX_AUTO_PAGES = 3;

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
  const params = useLocalSearchParams<{ category?: string; q?: string }>();

  const recentSearches = usePrefsStore((s) => s.recentSearches || []);
  const addRecentSearch = usePrefsStore((s) => s.addRecentSearch);
  const removeRecentSearch = usePrefsStore((s) => s.removeRecentSearch);
  const clearRecentSearches = usePrefsStore((s) => s.clearRecentSearches);

  const { categories } = useHomeCategories();

  const [query, setQuery] = useState(params.q ?? '');
  const [category, setCategory] = useState<string | null>(params.category ?? null);
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);

  // Al llegar desde una categoría de Inicio, el filtro ya viene puesto y no
  // se abre el teclado: el usuario venía a mirar, no a escribir.
  useEffect(() => {
    if (params.category) setCategory(params.category);
  }, [params.category]);

  // Un banner puede abrir la pantalla con la búsqueda ya hecha.
  useEffect(() => {
    if (params.q) setQuery(params.q);
  }, [params.q]);

  // Dos esperas distintas: las sugerencias son baratas y tienen que ir
  // pegadas al dedo; los resultados cuestan más y pueden respirar.
  const debouncedQuery = useDebounced(query, 320);
  const suggestTerm = useDebounced(query, 150);

  const term = debouncedQuery.trim();
  const hasTerm = term.length >= 2;

  const { coords, ready: coordsReady } = useDeliveryCoords();

  // Dos fuentes según lo que esté haciendo el usuario. Con término escrito
  // manda la búsqueda de catálogo, que también encuentra platos; navegando
  // por categorías manda el listado de negocios de siempre, que es el que
  // sabe filtrar por categoría.
  // Las tendencias salen de las búsquedas reales de la gente y, mientras no
  // haya volumen, de las categorías del catálogo. Antes era una lista
  // escrita a mano que podía anunciar cosas que nadie vende.
  const { data: serverPopular } = usePopularSearches();
  const popularTerms = serverPopular?.length ? serverPopular : FALLBACK_SEARCHES;

  const catalog = useSearch(term, { lat: coords?.lat, lng: coords?.lng, sort: filters.sort });
  const suggestions = useSearchSuggestions(suggestOpen ? suggestTerm : '');

  const listing = useBusinesses(
    {
      category: category || undefined,
      ...(coords ?? {}),
    },
    // Igual que en Inicio: sin esperar a las direcciones, la lista se
    // descargaba una vez sin coordenadas y otra con ellas.
    coordsReady
  ) as { data: Business[]; isLoading: boolean; isError: boolean; refetch: () => void };

  const pages = catalog.data?.pages ?? [];
  const found = useMemo(() => pages.flatMap((p) => p.businesses as Business[]), [pages]);
  // Los platos y la corrección solo viven en la primera página: son la
  // cabecera de los resultados, no la lista que se sigue deslizando.
  const products: ProductSearchHit[] = hasTerm ? pages[0]?.products ?? [] : [];
  const suggestedTerm = hasTerm ? pages[0]?.suggestedTerm : undefined;

  const data: Business[] = hasTerm ? found : listing.data;
  const isLoading = hasTerm ? catalog.isLoading : listing.isLoading;
  const isError = hasTerm ? catalog.isError : listing.isError;
  const refetch = hasTerm ? catalog.refetch : listing.refetch;

  const results = useMemo(() => {
    let list = data ?? [];

    // Filtrar en el teléfono es seguro con paginación: solo quita filas,
    // nunca las reordena, así que la página 2 no puede colarse por encima
    // de la 1.
    if (filters.openOnly) list = list.filter((b) => openState(b.schedule).open);
    if (filters.minRating > 0) list = list.filter((b) => (b.rating ?? 0) >= filters.minRating);
    if (filters.maxDeliveryTime > 0) {
      list = list.filter((b) => (b.deliveryTime ?? Infinity) <= filters.maxDeliveryTime);
    }

    // Con término escrito el orden ya lo decidió el servidor, y respetarlo
    // es lo que mantiene estable la lista al cargar más páginas.
    if (hasTerm) return list;

    // Navegando por categorías no hay paginación, así que aquí sí se puede
    // ordenar. Los abiertos primero: pedirle a alguien que descubra un local
    // cerrado solo genera un viaje en falso.
    const byOpen = (a: Business, b: Business) =>
      (openState(b.schedule).open ? 1 : 0) - (openState(a.schedule).open ? 1 : 0);

    return [...list].sort((a, b) => {
      const open = byOpen(a, b);
      if (open !== 0) return open;

      switch (filters.sort) {
        case 'distance':
          return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
        case 'deliveryTime':
          return (a.deliveryTime ?? Infinity) - (b.deliveryTime ?? Infinity);
        default:
          return (b.rating ?? 0) - (a.rating ?? 0);
      }
    });
  }, [data, filters, hasTerm]);

  // ── Búsqueda confirmada ──────────────────────────────────────────
  //
  // Una búsqueda solo cuenta cuando el usuario la confirma: pulsa buscar,
  // elige una sugerencia o abre un resultado. Antes se guardaba todo lo que
  // pasara de tres letras y sobreviviera a la espera, así que las recientes
  // se llenaban de "ham", "hambur", "hamburgu".

  /** Término confirmado que aún no se ha registrado en el servidor. */
  const pendingLog = useRef<string | null>(null);

  const commitSearch = useCallback((raw: string) => {
    const clean = raw.trim();
    if (clean.length < 2) return;
    addRecentSearch(clean);
    pendingLog.current = clean;
  }, [addRecentSearch]);

  // Se registra cuando los resultados de ese término exacto ya se asentaron.
  // Hacerlo en el momento de confirmar guardaría `resultCount: 0` en cuanto
  // la consulta fuera un poco lenta, y eso envenenaría justo el informe que
  // más vale: el de lo que se busca y no existe.
  useEffect(() => {
    const pending = pendingLog.current;
    if (!pending || pending !== term) return;
    if (catalog.isLoading || catalog.isFetching) return;

    pendingLog.current = null;
    searchApi.log({
      term: pending,
      resultCount: found.length + products.length,
      suggestedTerm,
    });
  }, [term, catalog.isLoading, catalog.isFetching, found.length, products.length, suggestedTerm]);

  const searching = query.trim().length > 0 || !!category;
  const activeCategory = categories.find((cat) => cat.key === category);
  const activeFilters = countActiveFilters(filters);

  const selectTerm = useCallback((next: string) => {
    tap('select');
    setQuery(next);
    setSuggestOpen(false);
    commitSearch(next);
  }, [commitSearch]);

  const openBusiness = useCallback((id: string) => {
    tap('select');
    setSuggestOpen(false);
    // Abrir un resultado confirma la búsqueda que llevó hasta él.
    commitSearch(query);
    router.push(`/(client)/business/${id}`);
  }, [commitSearch, query, router]);

  const pickSuggestion = useCallback((item: SearchSuggestion) => {
    if (item.type === 'term') { selectTerm(item.label); return; }
    if (item.id) openBusiness(item.id);
  }, [selectTerm, openBusiness]);

  // Los filtros se aplican en el teléfono, así que una página puede quedar
  // en dos resultados y no dar altura para que `onEndReached` se dispare.
  //
  // Se depende de las tres primitivas y no del objeto de la consulta: ese
  // cambia de identidad en cada render, y el efecto de abajo acabaría
  // ejecutándose siempre en vez de cuando cambia algo de verdad.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = catalog;

  const loadMore = useCallback(() => {
    if (!hasTerm || !hasNextPage || isFetchingNextPage) return;
    fetchNextPage();
  }, [hasTerm, hasNextPage, isFetchingNextPage, fetchNextPage]);

  /**
   * Tope de páginas que el relleno automático puede pedir por búsqueda.
   *
   * Sin él, un filtro estricto convierte esto en una lectura completa del
   * catálogo: `minRating: 4.5` descarta casi todo, la página queda por
   * debajo del mínimo, el efecto pide la siguiente, y así **hasta agotar
   * `hasNextPage`**. Con tres páginas ya hay material de sobra para juzgar
   * si el filtro es demasiado duro; a partir de ahí, seguir deslizando es
   * decisión del usuario y no del efecto.
   */
  const autoPagesRef = useRef(0);

  useEffect(() => {
    // Cada búsqueda nueva empieza con el contador a cero: el tope es por
    // término, no por sesión.
    autoPagesRef.current = 0;
  }, [term, filters.sort, filters.minRating, filters.maxDeliveryTime, filters.openOnly]);

  useEffect(() => {
    if (results.length >= MIN_VISIBLE) return;
    if (autoPagesRef.current >= MAX_AUTO_PAGES) return;
    autoPagesRef.current += 1;
    loadMore();
  }, [results.length, loadMore]);

  // Basta con que la consulta haya respondido, aunque venga vacía: la fila
  // "Buscar «lo escrito»" siempre da salida. Se espera a que llegue algo
  // para no cambiar la pantalla por una lista en blanco en las primeras
  // pulsaciones, cuando todavía no hay nada que ofrecer.
  const showSuggestions =
    suggestOpen && suggestTerm.trim().length >= 2 && suggestions.data !== undefined;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.top}>
        <Text v="displayM">Explorar</Text>

        <SearchField
          value={query}
          onChange={(next) => { setQuery(next); setSuggestOpen(true); }}
          placeholder="Hamburguesa, droguería, café…"
          onSubmit={() => { setSuggestOpen(false); commitSearch(query); }}
          onFocus={() => setSuggestOpen(true)}
          onFilters={() => { tap('select'); setFiltersOpen(true); }}
          filtersActive={activeFilters > 0}
          filterCount={activeFilters}
        />

        {!showSuggestions ? (
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
              <CategoryChip
                label={item.label}
                categoryKey={item.key}
                active={category === item.key}
                onPress={() => {
                  tap('select');
                  setCategory(category === item.key ? null : item.key);
                }}
              />
            )}
          />
        ) : null}

        {/* Resumen de lo que está filtrado, con salida rápida. */}
        {(activeFilters > 0 || category) && !isLoading && !showSuggestions ? (
          <View style={styles.summary}>
            <Text v="bodyS" tone="textMuted">
              {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
              {activeCategory ? ` en ${activeCategory.label.toLowerCase()}` : ''}
            </Text>
            {activeFilters > 0 ? (
              <Pressable
                onPress={() => { tap('light'); setFilters(NO_FILTERS); }}
                accessibilityRole="button"
                accessibilityLabel="Quitar todos los filtros"
              >
                <Badge
                  label={activeFilters === 1 ? '1 filtro' : `${activeFilters} filtros`}
                  tone="primary"
                  icon="cerrar"
                />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      {showSuggestions ? (
        <SuggestionList
          typed={query.trim()}
          items={suggestions.data ?? []}
          onPick={pickSuggestion}
          onSearchTyped={() => selectTerm(query.trim())}
          bottomSpace={bottomSpace}
        />
      ) : isError ? (
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
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <BusinessRow business={item} onPress={openBusiness} />
          )}
          ListHeaderComponent={
            <View style={styles.header}>
              {suggestedTerm ? (
                <CorrectionNotice used={suggestedTerm} typed={term} />
              ) : null}

              {products.length ? (
                <View style={styles.productsBlock}>
                  <View style={styles.sectionTitleRow}>
                    <Icon name="bolsa" size="sm" color={c.primary} />
                    <Text v="strongS">Platos y productos</Text>
                  </View>

                  {products.map((product) => (
                    <ProductHit
                      key={product._id}
                      product={product}
                      // Se navega al negocio, no a una ficha suelta: para
                      // pedir un plato hay que entrar en su carta de todas
                      // formas, y saltarse ese paso deja el carrito sin
                      // saber a qué local pertenece.
                      onPress={() => openBusiness(product.businessId)}
                    />
                  ))}

                  {results.length ? (
                    <View style={styles.sectionTitleRow}>
                      <Icon name="negocio" size="sm" color={c.primary} />
                      <Text v="strongS">Negocios</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            products.length ? null : searching ? (
              <EmptyState
                icon="explorar"
                title="Nada con esa búsqueda"
                message={
                  activeFilters > 0
                    ? 'Prueba quitando algún filtro o busca otra cosa.'
                    : 'Revisa cómo lo escribiste o explora alguna de las categorías disponibles.'
                }
                actionLabel="Limpiar filtros"
                onAction={() => { setQuery(''); setCategory(null); setFilters(NO_FILTERS); }}
              />
            ) : (
              <DiscoveryHub
                popularTerms={popularTerms}
                recentSearches={recentSearches}
                categories={categories}
                onSelectSearch={selectTerm}
                onRemoveRecent={(value) => { tap('light'); removeRecentSearch(value); }}
                onClearRecents={() => { tap('light'); clearRecentSearches(); }}
                onPickCategory={(key) => { tap('select'); setCategory(key); }}
                onErrand={() => { tap('select'); router.push('/(client)/errand'); }}
              />
            )
          }
        />
      )}

      <SearchFiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onChange={setFilters}
        resultCount={results.length}
        hasAddress={!!coords}
        onNeedAddress={() => {
          setFiltersOpen(false);
          router.push('/(client)/addresses');
        }}
      />
    </SafeAreaView>
  );
}

/**
 * "Buscamos otra cosa, y esto es lo que salió."
 *
 * Informativo y sin enlace a propósito. La tentación era ofrecer "buscar lo
 * que escribí en su lugar", pero la corrección solo se dispara cuando el
 * término literal ya devolvió cero resultados: ese enlace llevaría siempre
 * a una pantalla vacía. Decir qué pasó es honesto; ofrecer una puerta que
 * no lleva a ninguna parte, no.
 */
function CorrectionNotice({ used, typed }: { used: string; typed: string }) {
  const { c } = useTheme();

  return (
    <Card style={styles.correction}>
      <Icon name="info" size="sm" color={c.primary} />
      <View style={styles.flex}>
        <Text v="bodyS">
          No encontramos «{typed}». Te mostramos <Text v="strongS">{used}</Text>.
        </Text>
      </View>
    </Card>
  );
}

/** Sugerencias mientras se escribe. */
function SuggestionList({
  typed, items, onPick, onSearchTyped, bottomSpace,
}: {
  typed: string;
  items: SearchSuggestion[];
  onPick: (item: SearchSuggestion) => void;
  onSearchTyped: () => void;
  bottomSpace: number;
}) {
  const { c } = useTheme();

  const icon = (type: SearchSuggestion['type']) =>
    type === 'business' ? 'negocio' : type === 'product' ? 'bolsa' : 'explorar';

  return (
    <FlatList
      data={items}
      keyExtractor={(item, index) => `${item.type}-${item.id ?? item.label}-${index}`}
      contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
      // Sin esto, el primer toque solo cierra el teclado y hay que tocar dos
      // veces la misma sugerencia.
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        // La salida para quien no quiere ninguna de las sugerencias. Sin
        // esta fila, escribir y no tocar nada deja al usuario mirando una
        // lista de propuestas sin manera evidente de buscar lo suyo.
        <Pressable
          onPress={onSearchTyped}
          accessibilityRole="button"
          accessibilityLabel={`Buscar ${typed}`}
          style={[styles.suggestionRow, { borderColor: c.border }]}
        >
          <Icon name="explorar" size="sm" color={c.primary} />
          <Text v="bodyM" style={styles.flex} numberOfLines={1}>
            Buscar «<Text v="strongS">{typed}</Text>»
          </Text>
          <Icon name="siguiente" size="sm" color={c.textMuted} />
        </Pressable>
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onPick(item)}
          accessibilityRole="button"
          accessibilityLabel={item.sublabel ? `${item.label}, ${item.sublabel}` : item.label}
          style={[styles.suggestionRow, { borderColor: c.border }]}
        >
          <Icon name={icon(item.type)} size="sm" color={c.textMuted} />
          <View style={styles.flex}>
            <Text v="bodyM" numberOfLines={1}>{item.label}</Text>
            {item.sublabel ? (
              <Text v="caption" tone="textMuted" numberOfLines={1}>{item.sublabel}</Text>
            ) : null}
          </View>
          <Icon name="siguiente" size="sm" color={c.textMuted} />
        </Pressable>
      )}
    />
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
  const Illustration = categoryIllustration(product.businessCategory ?? '');

  return (
    <Pressable
      onPress={onPress}
      style={[styles.hit, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityRole="button"
      accessibilityLabel={`${product.name} en ${product.businessName}`}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.hitImage}
          contentFit="cover"
          transition={150}
          placeholder={productImagePlaceholder(product as never)}
          cachePolicy="memory-disk"
          recyclingKey={product._id}
        />
      ) : (
        <View style={[styles.hitImage, styles.hitFallback, { backgroundColor: c.surfaceLight }]}>
          <Illustration size={34} />
        </View>
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
  onErrand,
}: {
  popularTerms: string[];
  recentSearches: string[];
  categories: DisplayCategory[];
  onSelectSearch: (term: string) => void;
  onRemoveRecent: (term: string) => void;
  onClearRecents: () => void;
  onPickCategory: (key: string) => void;
  onErrand: () => void;
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
            <Pressable
              onPress={onClearRecents}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Borrar todas las búsquedas recientes"
            >
              <Text v="caption" tone="primaryText">Borrar todo</Text>
            </Pressable>
          </View>
          <View style={styles.tagsWrap}>
            {recentSearches.map((term) => (
              <Pressable
                key={term}
                onPress={() => onSelectSearch(term)}
                accessibilityRole="button"
                accessibilityLabel={`Buscar "${term}" otra vez`}
                style={[styles.recentTag, { backgroundColor: c.surface, borderColor: c.border }]}
              >
                <Text v="bodyS">{term}</Text>
                <Pressable
                  onPress={() => onRemoveRecent(term)}
                  // El icono mide 12px; sin hitSlop real el area tocable
                  // quedaba por debajo del minimo de 44pt del propio token
                  // del proyecto, anidada ademas dentro de otro Pressable
                  // -- el peor caso para acertar con el dedo.
                  hitSlop={16}
                  accessibilityRole="button"
                  accessibilityLabel={`Quitar "${term}" de recientes`}
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
              accessibilityRole="button"
              accessibilityLabel={`Buscar "${term}"`}
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

      {/* ── Mandados ── */}
      {/* Cierra la lista a propósito: si ninguna categoría es lo que buscas,
          esto es la salida. Una categoría lleva a una lista de negocios;
          esto no lleva a ninguna, es para lo que no está en ninguna carta. */}
      <Card
        tone="outline"
        style={styles.errand}
        onPress={onErrand}
        accessibilityLabel="Pedir un mandado"
        accessibilityHint="Encargar algo que no está en ninguna carta"
      >
        <View style={[styles.errandIcon, { backgroundColor: c.surfaceLight }]}>
          <ContentIcon name="paquete" size={30} />
        </View>
        <View style={styles.errandCopy}>
          <Text v="titleS">¿No está en ninguna carta?</Text>
          <Text v="bodyM" tone="textSecondary">
            Pide un mandado y te lo recogemos donde sea.
          </Text>
        </View>
        <Icon name="siguiente" size="md" color={c.textMuted} />
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: { gap: Spacing.md },
  correction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
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
  hitFallback: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hitBody: { flex: 1, gap: 2 },

  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },

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

  errand: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  errandIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  errandCopy: { flex: 1, gap: 2 },
});
