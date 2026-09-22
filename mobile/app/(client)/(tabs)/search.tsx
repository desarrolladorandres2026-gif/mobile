import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text, SearchField, DismissChip } from '../../../components/ui';
import { type Business } from '../../../components/domain/BusinessCard';
import { ExploreFeed } from '../../../components/domain/ExploreFeed';
import { SearchResults } from '../../../components/domain/SearchResults';
import {
  SearchFiltersSheet, NO_FILTERS, countActiveFilters, describeFilters,
  type SearchFilters,
} from '../../../components/domain/SearchFiltersSheet';
import {
  useBusinesses, useSearch, useSearchSuggestions, useDeliveryCoords,
} from '../../../hooks/useApi';
import {
  searchApi, type ProductSearchHit, type SearchSuggestion,
} from '../../../services/endpoints';
import { useHomeCategories } from '../../../hooks/useHomeCategories';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { usePrefsStore } from '../../../stores/prefsStore';
import { Spacing } from '../../../theme/tokens';
import { openState } from '../../../lib/business';
import { tap } from '../../../lib/haptics';

/**
 * Explorar.
 *
 * La pantalla hace dos trabajos distintos y hasta ahora los hacía con la
 * misma ropa. Con algo escrito —o una categoría puesta— esto es una lista
 * para **comparar**: filas compactas, tres columnas siempre a la misma
 * altura, el plato y el negocio con la misma silueta para que se puedan
 * medir entre sí (`SearchResults.tsx`). Sin nada escrito es un feed para
 * **descubrir**: el grid de antojos, las colecciones que arma el servidor
 * solas y la salida de mandados (`ExploreFeed.tsx`).
 *
 * Este archivo solo orquesta: guarda el estado de la búsqueda, decide en
 * qué modo está la pantalla y reparte los datos ya resueltos a los dos
 * componentes de arriba. El detalle de cada uno vive en su propio archivo
 * — ver `docs/EXPLORAR.md` §8.1 (A8) para el porqué del reparto.
 *
 * La obsidiana aparece una sola vez, arriba, igual que en Descuentos: es lo
 * que ancla la pantalla y el único fondo donde el oro de la marca contrasta.
 * El resto es papel.
 */

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

  const addRecentSearch = usePrefsStore((s) => s.addRecentSearch);

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
   * enseñar lo mismo que el Inicio ya enseña con sus colecciones. El feed
   * de descubrimiento (`ExploreFeed`) existía en el código pero solo
   * aparecía si esa lista volvía vacía, o sea casi nunca.
   *
   * `settling` es el hueco entre las dos: hay algo escrito pero el servidor
   * todavía no lo ha visto. Sin distinguirlo, los 320 ms del debounce
   * enseñaban el vacío de "nada con esa búsqueda" antes de haber buscado —
   * y llegando desde un banner con la búsqueda hecha, el feed de
   * descubrimiento aparecía y desaparecía solo.
   */
  const typing = query.trim().length >= 2;
  const browsing = typing || !!category || intent;
  const settling = typing && !hasTerm;

  const { coords, ready: coordsReady } = useDeliveryCoords();

  // Dos fuentes según lo que esté haciendo el usuario. Con término escrito
  // manda la búsqueda de catálogo, que también encuentra platos; navegando
  // por categorías manda el listado de negocios de siempre, que es el que
  // sabe filtrar por categoría.
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
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.background }}>
        <View style={styles.bandInner}>
          <Text v="titleL">Explorar</Text>

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

      {!browsing ? (
        <ExploreFeed
          coords={coords}
          coordsReady={coordsReady}
          categories={categories}
          categoriesLoading={categoriesLoading}
          bottomSpace={bottomSpace}
          onSelectCategory={(key) => { setCategory(key); }}
          onErrand={() => { tap('select'); router.push('/(client)/errand'); }}
        />
      ) : (
        <SearchResults
          showSuggestions={showSuggestions}
          typed={query.trim()}
          suggestions={suggestions.data ?? []}
          onPickSuggestion={pickSuggestion}
          onSearchTyped={() => selectTerm(query.trim())}
          isError={isError}
          onRetry={refetch}
          loading={settling || isLoading}
          results={results}
          products={products}
          suggestedTerm={suggestedTerm}
          term={term}
          categoryNames={categoryNames}
          onOpenBusiness={openBusiness}
          onLoadMore={loadMore}
          bottomSpace={bottomSpace}
          outOfCoverage={outOfCoverage}
          activeFilters={activeFilters}
          onClearFilters={() => { setQuery(''); setCategory(null); setFilters(NO_FILTERS); }}
          onChangeAddress={() => router.push('/(client)/addresses')}
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

const styles = StyleSheet.create({
  screen: { flex: 1 },

  /**
   * La banda de obsidiana.
   *
   * Color crudo de la paleta y no un token de tema, igual que la franja de
   * Descuentos: es una decisión de marca, no una superficie que deba seguir
   * al modo claro u oscuro.
   */
  bandInner: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    gap: Spacing.sm,
  },

  summary: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  summaryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
