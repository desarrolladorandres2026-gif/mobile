import { useState, useEffect, useMemo } from 'react';
import { View, FlatList, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  Text, Icon, SearchField, Chip, EmptyState, ErrorState,
  BusinessCardSkeleton, Badge,
} from '../../../components/ui';
import { BusinessRow, type Business } from '../../../components/domain/BusinessCard';
import { useBusinesses } from '../../../hooks/useApi';
import { useTheme } from '../../../hooks/useTheme';
import { BUSINESS_CATEGORIES } from '../../../constants/config';
import { categoryIcon } from '../../../theme/icons';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { openState } from '../../../lib/business';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 190;

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

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(params.category ?? null);
  const [openOnly, setOpenOnly] = useState(false);

  // Al llegar desde una categoría de Inicio, el filtro ya viene puesto y no
  // se abre el teclado: el usuario venía a mirar, no a escribir.
  useEffect(() => {
    if (params.category) setCategory(params.category);
  }, [params.category]);

  const debouncedQuery = useDebounced(query);

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
              onPress={() => setCategory(category === item.key ? null : item.key)}
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
                    : 'Revisa cómo lo escribiste o prueba con una categoría.'
                }
                actionLabel="Limpiar filtros"
                onAction={() => { setQuery(''); setCategory(null); setOpenOnly(false); }}
              />
            ) : (
              <Suggestions onPick={(key) => { tap('light'); setCategory(key); }} />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

/** Qué mostrar antes de que el usuario escriba nada. */
function Suggestions({ onPick }: { onPick: (key: string) => void }) {
  const { c } = useTheme();

  return (
    <View style={styles.suggestions}>
      <Text v="titleM">Empieza por aquí</Text>
      <View style={styles.suggestionGrid}>
        {BUSINESS_CATEGORIES.map((cat) => (
          <Pressable
            key={cat.key}
            onPress={() => onPick(cat.key)}
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

  suggestions: { gap: Spacing.lg, paddingTop: Spacing.xl },
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
