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
import { useBusinesses } from '../../../hooks/useApi';
import { useTheme } from '../../../hooks/useTheme';
import { usePrefsStore } from '../../../stores/prefsStore';
import { BUSINESS_CATEGORIES } from '../../../constants/config';
import { categoryIcon } from '../../../theme/icons';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { openState } from '../../../lib/business';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 190;

const POPULAR_SEARCHES = [
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
  const params = useLocalSearchParams<{ category?: string }>();

  const recentSearches = usePrefsStore((s) => s.recentSearches || []);
  const addRecentSearch = usePrefsStore((s) => s.addRecentSearch);
  const removeRecentSearch = usePrefsStore((s) => s.removeRecentSearch);
  const clearRecentSearches = usePrefsStore((s) => s.clearRecentSearches);

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

  const { data = [], isLoading, isError, refetch } = useBusinesses({
    search: debouncedQuery.trim() || undefined,
    category: category || undefined,
  }) as { data: Business[]; isLoading: boolean; isError: boolean; refetch: () => void };

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
  const activeCategory = BUSINESS_CATEGORIES.find((cat) => cat.key === category);

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
          data={BUSINESS_CATEGORIES}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
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
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <BusinessRow
              business={item}
              onPress={() => router.push(`/(client)/business/${item._id}`)}
            />
          )}
          ListEmptyComponent={
            searching ? (
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
                recentSearches={recentSearches}
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

/** Descubrimiento inicial: Búsquedas recientes, Tendencias y Categorías */
function DiscoveryHub({
  recentSearches,
  onSelectSearch,
  onRemoveRecent,
  onClearRecents,
  onPickCategory,
}: {
  recentSearches: string[];
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
          <Text v="strongS">Lo más buscado en Garzón</Text>
        </View>
        <View style={styles.tagsWrap}>
          {POPULAR_SEARCHES.map((term) => (
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
          {BUSINESS_CATEGORIES.map((cat) => (
            <Pressable
              key={cat.key}
              onPress={() => onPickCategory(cat.key)}
              accessibilityRole="button"
              accessibilityLabel={cat.label}
              style={[styles.suggestion, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View style={[styles.suggestionIcon, { backgroundColor: c.primarySoft }]}>
                <Icon name={categoryIcon(cat.key)} size="md" color={c.primaryText} />
              </View>
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
    paddingBottom: BOTTOM_SPACE,
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
  suggestionIcon: {
    width: 38, height: 38, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
});

