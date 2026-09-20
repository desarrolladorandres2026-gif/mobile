import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { View, FlatList, ScrollView, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, SearchField, CategoryChip, EmptyState, ErrorState,
  BusinessResultRowSkeleton, DiscoveryHubSkeleton, DismissChip, Card, Chip,
} from '../../../components/ui';
import { BusinessResultRow, type Business } from '../../../components/domain/BusinessCard';
import { CategoryTile } from '../../../components/domain/CategoryTile';
import { ExploreCollections } from '../../../components/domain/ExploreCollections';
import { categoryIllustration, ContentIcon } from '../../../components/illustrations';
import {
  SearchFiltersSheet, NO_FILTERS, countActiveFilters, describeFilters,
  type SearchFilters,
} from '../../../components/domain/SearchFiltersSheet';
import {
  useBusinesses, useSearch, useSearchSuggestions, usePopularSearches, useDeliveryCoords,
} from '../../../hooks/useApi';
import {
  searchApi, type ProductSearchHit, type SearchSuggestion, type PopularTerm,
} from '../../../services/endpoints';
import { productImageUri, productImagePlaceholder } from '../../../lib/productImage';
import { minutes } from '../../../lib/format';
import { Image } from 'expo-image';
import { useHomeCategories, type DisplayCategory } from '../../../hooks/useHomeCategories';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { usePrefsStore } from '../../../stores/prefsStore';
import { BorderRadius, Spacing, palette } from '../../../theme/tokens';
import { openState } from '../../../lib/business';
import { tap } from '../../../lib/haptics';

/**
 * Explorar.
 *
 * La pantalla hace dos trabajos distintos y hasta ahora los hacía con la
 * misma ropa. Con algo escrito —o una categoría puesta— esto es una lista
 * para **comparar**: filas compactas, tres columnas siempre a la misma
 * altura, el plato y el negocio con la misma silueta para que se puedan
 * medir entre sí. Sin nada escrito es una portada para **descubrir**:
 * recientes, el ranking de lo que busca la gente y las categorías a tamaño
 * de baldosa.
 *
 * Antes las dos usaban la tarjeta del Inicio, con portada de 140 px: dos
 * resultados por pantalla justo donde hay que comparar veinte. Y una
 * categoría se dibujaba de dos formas a la vez, chip arriba y fila abajo.
 * Ahora el chip filtra y la baldosa navega, y son las dos únicas formas que
 * tiene una categoría aquí.
 *
 * La obsidiana aparece una sola vez, arriba, igual que en Descuentos: es lo
 * que ancla la pantalla y el único fondo donde el oro de la marca contrasta.
 * El resto es papel.
 */

/**
 * Red de seguridad: el servidor ya devuelve el ranking real de búsquedas y,
 * mientras no haya volumen, las categorías del catálogo por su nombre. Si esa
 * consulta falla, una lista vacía dejaría la portada en blanco.
 *
 * Van con `count: 0` porque no son el conteo de nada: la pantalla solo
 * imprime el número cuando es real.
 */
const FALLBACK_SEARCHES: PopularTerm[] = [
  'Hamburguesas', 'Pizza', 'Salchipapas', 'Café',
  'Pollo Broaster', 'Droguería', 'Desayunos', 'Helados',
].map((term) => ({ term, count: 0 }));

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

/** Cuántos fantasmas de fila caben antes de que haya que deslizar. */
const SKELETON_ROWS = 7;

/**
 * Las intenciones de un toque.
 *
 * Los filtros viven dentro de una hoja, y nadie abre una hoja mientras
 * explora: se abre cuando ya se está buscando algo concreto. Esto los saca
 * al feed, que es donde sí se usan.
 *
 * Solo hay aquí lo que se puede filtrar de verdad con el dato que ya existe
 * en el catálogo. Un chip que no filtra nada es peor que no tener el chip:
 * el usuario lo pulsa, no pasa nada visible, y deja de confiar en la fila
 * entera. "Envío gratis" y "Menos de $X" necesitan que el listado los
 * entienda en el servidor, y llegan con ese trabajo, no antes.
 */
const INTENTS: { key: string; label: string; icon: string; patch: Partial<SearchFilters> }[] = [
  { key: 'open', label: 'Abierto ahora', icon: 'minutos', patch: { openOnly: true } },
  { key: 'fast', label: 'Llega en 20 min', icon: 'destello', patch: { maxDeliveryTime: 20 } },
  { key: 'top', label: 'Mejor calificados', icon: 'calificacion', patch: { minRating: 4.5 } },
  { key: 'near', label: 'Más cerca', icon: 'navegar', patch: { sort: 'distance' } },
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
  const params = useLocalSearchParams<{ category?: string; q?: string }>();

  const recentSearches = usePrefsStore((s) => s.recentSearches || []);
  const addRecentSearch = usePrefsStore((s) => s.addRecentSearch);
  const removeRecentSearch = usePrefsStore((s) => s.removeRecentSearch);
  const clearRecentSearches = usePrefsStore((s) => s.clearRecentSearches);

  const { categories, isLoading: categoriesLoading } = useHomeCategories();

  const [query, setQuery] = useState(params.q ?? '');
  const [category, setCategory] = useState<string | null>(params.category ?? null);
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  /**
   * Una intención activa pasa al modo listado sin categoría ni término.
   *
   * Sin esto, pulsar "Abierto ahora" cambiaría los filtros y no pasaría nada
   * visible: el modo listado solo se enciende con una categoría o con algo
   * escrito, y un chip que no hace nada visible es peor que no estar.
   */
  const [intent, setIntent] = useState(false);

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

  /**
   * Los dos modos de la pantalla.
   *
   * `browsing` es "hay algo que comparar": un término escrito o una categoría
   * puesta. Sin ninguna de las dos no se pide ninguna lista — antes sí, y era
   * el catálogo entero del pueblo en cada apertura de la pestaña, para
   * enseñar lo mismo que el Inicio ya enseña con sus colecciones. La portada
   * de descubrimiento existía en el código pero solo aparecía si esa lista
   * volvía vacía, o sea casi nunca.
   *
   * `settling` es el hueco entre las dos: hay algo escrito pero el servidor
   * todavía no lo ha visto. Sin distinguirlo, los 320 ms del debounce
   * enseñaban el vacío de "nada con esa búsqueda" antes de haber buscado —
   * y llegando desde un banner con la búsqueda hecha, la portada de
   * descubrimiento aparecía y desaparecía sola.
   */
  const typing = query.trim().length >= 2;
  const browsing = typing || !!category || intent;
  const settling = typing && !hasTerm;

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
    // descargaba una vez sin coordenadas y otra con ellas. Y solo cuando hay
    // categoría: sin ella esta consulta era el catálogo completo, y nadie lo
    // miraba.
    coordsReady && (!!category || intent)
  ) as { data?: Business[]; isLoading: boolean; isError: boolean; refetch: () => void };

  const pages = catalog.data?.pages ?? [];
  const found = useMemo(() => pages.flatMap((p) => p.businesses as Business[]), [pages]);
  // Los platos y la corrección solo viven en la primera página: son la
  // cabecera de los resultados, no la lista que se sigue deslizando.
  // La búsqueda de catálogo no filtra por categoría en el servidor: si se
  // llegó con una categoría activa (desde Inicio o desde el propio chip) y
  // encima se escribió un término, sin este filtro el resumen dice "en
  // <categoría>" mientras la lista real mezcla todo el catálogo.
  const products: ProductSearchHit[] = hasTerm
    ? (pages[0]?.products ?? []).filter((p) => !category || p.businessCategory === category)
    : [];
  const suggestedTerm = hasTerm ? pages[0]?.suggestedTerm : undefined;

  const data: Business[] = hasTerm ? found : (listing.data ?? []);
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
    // Misma razón que el filtro de `products` de arriba: el buscador por
    // término no acota por categoría en el servidor, así que hay que
    // hacerlo aquí para que el chip activo no mienta sobre lo que se ve.
    if (category) list = list.filter((b) => b.category === category);

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
  }, [data, filters, hasTerm, category]);

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

  const activeCategory = categories.find((cat) => cat.key === category);
  const activeFilters = countActiveFilters(filters);
  const filterChips = useMemo(() => describeFilters(filters), [filters]);

  /** El nombre que administración le puso a cada categoría, para las filas. */
  const categoryNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cat of categories) map[cat.key] = cat.label;
    return map;
  }, [categories]);

  /**
   * Nada que buscar porque nadie reparte ahí.
   *
   * Con la dirección de entrega fuera de cobertura las dos fuentes —la
   * búsqueda de catálogo y el listado por categoría— devuelven cero, porque
   * ambas van geocercadas por `$geoNear`. Decirle entonces "revisa cómo lo
   * escribiste" manda al usuario a corregir un término que está bien.
   *
   * La señal no puede ser `data`: un término que no existe o una categoría
   * sin locales también lo dejan vacío. Se pregunta si hay **algún**
   * negocio en el radio, sin categoría ni término — con `limit: 1`, porque
   * para saber si la lista está vacía basta con un elemento.
   */
  const whole = useBusinesses(coords ? { ...coords, limit: 1 } : undefined, coordsReady) as { data?: Business[] };
  const outOfCoverage = !!coords && whole.data !== undefined && whole.data.length === 0;

  /**
   * Aplica —o retira— una intención.
   *
   * Vuelve a tocarla y se quita, como el chip de categoría: sin eso, la
   * única forma de deshacer "Llega en 20 min" sería abrir la hoja de
   * filtros, que es justo lo que estos chips existen para evitar.
   */
  const applyIntent = useCallback((patch: Partial<SearchFilters>) => {
    tap('select');
    setFilters((current) => {
      const already = Object.entries(patch).every(
        ([field, value]) => (current as never as Record<string, unknown>)[field] === value
      );
      const undo = Object.fromEntries(
        Object.keys(patch).map((field) => [field, (NO_FILTERS as never as Record<string, unknown>)[field]])
      );
      return { ...current, ...(already ? undo : patch) } as SearchFilters;
    });
    setIntent(true);
  }, []);

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
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      {/* ── La banda: título y buscador sobre obsidiana ──
          El área segura va dentro de la banda y no fuera, para que el color
          suba hasta la barra de estado. Que la hora se pinte en claro lo
          decide `DARK_HEADER_ROUTES` en el layout raíz: dentro de la
          pestaña no serviría, porque `freezeOnBlur` la congela al perder el
          foco y podría quedarse sin devolver el estilo. */}
      <SafeAreaView edges={['top']} style={styles.band}>
        <View style={styles.bandInner}>
          <Text v="displayM" color={palette.paper0}>Explorar</Text>

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
        </View>
      </SafeAreaView>

      {/* Los chips quedan sobre el papel, justo debajo del borde de la banda:
          así el chip activo es lo único dorado de esta mitad de la pantalla. */}
      {!showSuggestions ? (
        <FlatList
          horizontal
          data={categories}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsRow}
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

      {/* Lo que está filtrado, con una salida por filtro en vez de una sola
          que lo borra todo a ciegas. */}
      {browsing && (filterChips.length > 0 || category) && !isLoading && !settling && !showSuggestions ? (
        <View style={styles.summary}>
          <Text v="bodyS" tone="textMuted">
            {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
            {activeCategory ? ` en ${activeCategory.label.toLowerCase()}` : ''}
          </Text>
          {filterChips.length > 0 ? (
            <View style={styles.summaryChips}>
              {filterChips.map((chip) => (
                <DismissChip
                  key={chip.key}
                  label={chip.label}
                  onDismiss={() => setFilters({ ...filters, ...chip.patch })}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

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
      ) : !browsing ? (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
        >
          {categoriesLoading ? (
            <DiscoveryHubSkeleton />
          ) : (
            <DiscoveryHub
              popularTerms={popularTerms}
              recentSearches={recentSearches}
              categories={categories}
              coords={coords}
              coordsReady={coordsReady}
              filters={filters}
              onSelectSearch={selectTerm}
              onRemoveRecent={(value) => { tap('light'); removeRecentSearch(value); }}
              onClearRecents={() => { tap('light'); clearRecentSearches(); }}
              onPickCategory={(key) => { tap('select'); setCategory(key); }}
              onIntent={applyIntent}
              onErrand={() => { tap('select'); router.push('/(client)/errand'); }}
            />
          )}
        </ScrollView>
      ) : settling || isLoading ? (
        <View style={styles.skeletons}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <BusinessResultRowSkeleton key={i} />
          ))}
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
            <BusinessResultRow
              business={item}
              onPress={openBusiness}
              categoryName={categoryNames[item.category]}
            />
          )}
          ListHeaderComponent={
            suggestedTerm || products.length ? (
              <View style={styles.header}>
                {suggestedTerm ? (
                  <CorrectionNotice used={suggestedTerm} typed={term} />
                ) : null}

                {products.length ? (
                  <View style={styles.productsBlock}>
                    <SectionTitle icon="bolsa" title="Platos y productos" />

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
                      <SectionTitle icon="negocio" title="Negocios" />
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            products.length ? null : outOfCoverage ? (
              <EmptyState
                icon="ubicacion"
                title="Todavía no llegamos a tu dirección"
                message="Ningún negocio reparte en esa zona, así que ninguna búsqueda va a encontrar nada. Prueba con otra dirección de entrega."
                actionLabel="Cambiar dirección"
                onAction={() => router.push('/(client)/addresses')}
              />
            ) : (
              <EmptyState
                icon="explorar"
                title="Nada con esa búsqueda"
                message={
                  activeFilters > 0
                    ? 'Prueba quitando algún filtro o busca otra cosa.'
                    : 'Revisa cómo lo escribiste o explora alguna de las categorías disponibles.'
                }
                actionLabel={activeFilters > 0 ? 'Limpiar filtros' : 'Volver a explorar'}
                onAction={() => { setQuery(''); setCategory(null); setFilters(NO_FILTERS); }}
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
    </View>
  );
}

// ── Piezas de la propia pantalla ──

/**
 * El encabezado de una sección, uno solo para toda la pantalla.
 *
 * Había tres tratamientos conviviendo —icono apagado + `strongS`, icono
 * dorado + `strongS`, y un `titleM` a secas— para decir lo mismo. A la
 * derecha va solo lo que de verdad se puede hacer ahí.
 */
function SectionTitle({
  icon, title, action, onAction,
}: {
  icon?: 'bolsa' | 'negocio' | 'racha' | 'reintentar';
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  const { c } = useTheme();

  return (
    <View style={styles.sectionTitle}>
      <View style={styles.sectionTitleRow}>
        {icon ? <Icon name={icon} size="sm" color={c.textMuted} /> : null}
        <Text v="titleM">{title}</Text>
      </View>
      {action && onAction ? (
        <Pressable
          onPress={onAction}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={action}
        >
          <Text v="strongS" tone="primaryText">{action}</Text>
        </Pressable>
      ) : null}
    </View>
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
 *
 * Misma silueta que `BusinessResultRow` —distintivo de 64 px, dos líneas de
 * texto, columna de datos a la derecha— y a propósito: en esta lista
 * conviven platos y negocios, y con dos siluetas distintas parecían dos
 * listas pegadas en vez de resultados comparables entre sí. Lo que sí es
 * suyo y de nadie más es la píldora dorada del precio.
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
  const hasDiscount = product.discountPrice != null && product.discountPrice < product.price;
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
          <Illustration size={40} />
        </View>
      )}

      <View style={styles.hitBody}>
        <Text v="titleM" numberOfLines={1}>{product.name}</Text>
        <Text v="bodyS" tone="textMuted" numberOfLines={1}>{product.businessName}</Text>

        <View style={styles.hitPriceRow}>
          <View style={[styles.pricePill, { backgroundColor: c.gold }]}>
            <Text v="dataM" color={c.black}>
              ${price.toLocaleString('es-CO')}
            </Text>
          </View>
          {hasDiscount ? (
            <Text v="caption" tone="textMuted" style={styles.strike}>
              ${product.price.toLocaleString('es-CO')}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.hitData}>
        <View style={styles.rating}>
          <Icon name="calificacion" size={13} color={c.warning} fill={c.warning} />
          <Text v="dataM">{(product.businessRating ?? 0).toFixed(1)}</Text>
        </View>
        {product.businessDeliveryTime ? (
          <Text v="dataS" tone="textMuted">{minutes(product.businessDeliveryTime)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Descubrimiento inicial.
 *
 * Se lee en tres bandas, y ese orden no es decorativo: arriba el control
 * —lo que ya buscaste, qué te provoca, qué tipo de negocio—, que resuelve a
 * quien entró sabiendo qué quiere; en medio las colecciones, que son lo
 * único que responde a quien entró sin saberlo; y abajo la salida, para lo
 * que no está en ninguna carta.
 */
function DiscoveryHub({
  popularTerms,
  recentSearches,
  categories,
  coords,
  coordsReady,
  filters,
  onSelectSearch,
  onRemoveRecent,
  onClearRecents,
  onPickCategory,
  onIntent,
  onErrand,
}: {
  popularTerms: PopularTerm[];
  recentSearches: string[];
  categories: DisplayCategory[];
  coords?: { lat: number; lng: number } | null;
  coordsReady: boolean;
  filters: SearchFilters;
  onSelectSearch: (term: string) => void;
  onRemoveRecent: (term: string) => void;
  onClearRecents: () => void;
  onPickCategory: (key: string) => void;
  onIntent: (patch: Partial<SearchFilters>) => void;
  onErrand: () => void;
}) {
  const { c } = useTheme();

  return (
    <Animated.View entering={FadeIn.duration(250)} style={styles.discovery}>
      {/* ── Recientes ──
          Filas y no píldoras: esto es historial, una lista de cosas que ya
          pasaron. Como píldoras se mezclaba con el ranking y con los chips
          de categoría —tres nubes de etiquetas idénticas diciendo tres cosas
          distintas— y además metía la X dentro de otra área tocable, que es
          el peor caso para acertar con el dedo. */}
      {recentSearches.length > 0 ? (
        <View style={styles.discoverySection}>
          <SectionTitle
            icon="reintentar"
            title="Búsquedas recientes"
            action="Borrar todo"
            onAction={onClearRecents}
          />
          <View style={styles.rows}>
            {recentSearches.map((term) => (
              <View key={term} style={[styles.recentRow, { borderColor: c.border }]}>
                <Pressable
                  onPress={() => onSelectSearch(term)}
                  accessibilityRole="button"
                  accessibilityLabel={`Buscar "${term}" otra vez`}
                  style={styles.recentMain}
                >
                  <Icon name="reintentar" size="sm" color={c.textMuted} />
                  <Text v="bodyM" numberOfLines={1} style={styles.flex}>{term}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onRemoveRecent(term)}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel={`Quitar "${term}" de recientes`}
                  style={styles.recentClose}
                >
                  <Icon name="cerrar" size={15} color={c.textMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* ── El ranking ──
          Con número de puesto, que es lo que convierte una nube de etiquetas
          en un dato. El conteo solo se imprime cuando viene de búsquedas
          reales: el respaldo por categorías cuenta negocios, no búsquedas. */}
      <View style={styles.discoverySection}>
        <SectionTitle icon="racha" title="Lo más buscado" />
        <View style={styles.rows}>
          {popularTerms.map((row, index) => (
            <Pressable
              key={row.term}
              onPress={() => onSelectSearch(row.term)}
              accessibilityRole="button"
              accessibilityLabel={`Buscar "${row.term}"`}
              style={styles.rankRow}
            >
              <Text v="dataM" color={c.primaryText} style={styles.rankNumber}>
                {index + 1}
              </Text>
              <Text v="bodyM" numberOfLines={1} style={styles.flex}>{row.term}</Text>
              {row.count > 0 ? (
                <Text v="caption" tone="textMuted">
                  {row.count} {row.count === 1 ? 'búsqueda' : 'búsquedas'}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Intenciones ──
          Entre el historial y las categorías a propósito: lo de arriba es
          "lo que ya buscaste", lo de abajo "qué tipo de negocio", y esto es
          la tercera pregunta que la gente se hace de verdad — cuánto tarda,
          cuánto cuesta, si está abierto. */}
      <View style={styles.discoverySection}>
        <SectionTitle title="¿Qué te provoca?" />
        <View style={styles.intentRow}>
          {INTENTS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              icon={option.icon as never}
              active={Object.entries(option.patch).every(
                ([field, value]) => (filters as never as Record<string, unknown>)[field] === value
              )}
              onPress={() => onIntent(option.patch)}
            />
          ))}
        </View>
      </View>

      {/* ── Categorías ──
          La misma baldosa del Inicio, a su tamaño real. Antes eran filas
          anchas con la ilustración reducida a un icono de 44 px, así que la
          misma categoría se dibujaba de dos formas en esta misma pantalla:
          chip arriba, fila abajo. Aquí la baldosa navega y el chip filtra. */}
      <View style={styles.discoverySection}>
        <SectionTitle title="Explorar por categoría" />
        <View style={styles.tileGrid}>
          {categories.map((cat) => (
            <View key={cat.key} style={styles.tileCell}>
              <CategoryTile
                categoryKey={cat.key}
                label={cat.label}
                imageUrl={cat.imageUrl}
                color={cat.color}
                onPress={() => onPickCategory(cat.key)}
              />
            </View>
          ))}
        </View>
      </View>

      {/* ── Las colecciones ──
          Aquí deja de ser un índice y pasa a ser un feed: hasta arriba todo
          servía a quien ya sabe qué quiere; esto es lo único que responde a
          quien entró sin saberlo. */}
      <ExploreCollections coords={coords} ready={coordsReady} />

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
  intentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  screen: { flex: 1 },
  flex: { flex: 1 },

  /**
   * La banda de obsidiana.
   *
   * Color crudo de la paleta y no un token de tema, igual que la franja de
   * Descuentos: es una decisión de marca, no una superficie que deba seguir
   * al modo claro u oscuro.
   */
  band: { backgroundColor: palette.ink900 },
  bandInner: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.lg,
  },

  // `flexGrow: 0` porque una `FlatList` horizontal dentro de una columna se
  // estira y se come el alto de la lista de abajo.
  chipsRow: { marginTop: Spacing.lg, flexGrow: 0 },
  chips: { gap: Spacing.sm, paddingHorizontal: Spacing.xl },

  summary: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  summaryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },

  header: { gap: Spacing.md },
  correction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  productsBlock: { gap: Spacing.sm, marginBottom: Spacing.md },

  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
  },

  // Misma caja que `BusinessResultRow`: un plato y un negocio tienen que
  // medir lo mismo para poder compararse en la misma lista.
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  hitImage: { width: 64, height: 64, borderRadius: BorderRadius.md },
  hitFallback: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hitBody: { flex: 1, gap: 2 },
  hitPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.xs, marginTop: 2 },
  hitData: { alignItems: 'flex-end', gap: 2 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  strike: { textDecorationLine: 'line-through' },
  pricePill: {
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },

  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },

  list: {
    padding: Spacing.xl,
    paddingTop: Spacing.lg,
    gap: Spacing.md,
  },
  skeletons: { padding: Spacing.xl, paddingTop: Spacing.lg, gap: Spacing.md },

  discovery: { gap: Spacing.xxl },
  discoverySection: { gap: Spacing.md },
  rows: { gap: Spacing.xs },

  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // El área de "buscar otra vez" ocupa toda la fila menos la X, y la X es
  // hermana suya y no su hija: anidadas, el primer toque casi siempre
  // acertaba con la de fuera.
  recentMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  recentClose: { padding: Spacing.sm },

  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  // Ancho fijo: así los números del uno al ocho no desalinean los términos.
  rankNumber: { width: 18, textAlign: 'center' },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  // Tres columnas contando los dos huecos del `gap`.
  tileCell: { width: '30%' },

  errand: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  errandIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  errandCopy: { flex: 1, gap: 2 },
});
