import { memo } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Icon, Card, DiscoveryHubSkeleton } from '../ui';
import { ContentIcon } from '../illustrations';
import { CategoryTile } from './CategoryTile';
import { ExploreCollections } from './ExploreCollections';
import { useTheme } from '../../hooks/useTheme';
import type { DisplayCategory } from '../../hooks/useHomeCategories';
import { BorderRadius, Spacing } from '../../theme/tokens';

/** Cuántas baldosas caben en el grid de antojos: 4 columnas × 2 filas. */
const CRAVINGS_COUNT = 8;

/**
 * El feed de descubrimiento de Explorar, sin nada escrito ni categoría
 * puesta.
 *
 * Se lee en tres bandas, y ese orden no es decorativo: arriba el índice
 * visual de antojos —donde muere la lista vertical con chevrons que había
 * antes—, en medio las colecciones que arma el servidor solas y rotan por
 * día y franja horaria, y abajo la salida para lo que no está en ninguna
 * carta.
 *
 * `docs/EXPLORAR.md` §4 documenta las trece bandas completas; esto cubre
 * las que ya tienen datos reales del lado del cliente (Fase 3 parcial, ver
 * §13 del documento).
 */
export const ExploreFeed = memo(function ExploreFeed({
  coords,
  coordsReady,
  categories,
  categoriesLoading,
  bottomSpace,
  onSelectCategory,
  onErrand,
}: {
  coords?: { lat: number; lng: number } | null;
  coordsReady: boolean;
  categories: DisplayCategory[];
  categoriesLoading: boolean;
  bottomSpace: number;
  onSelectCategory: (key: string) => void;
  onErrand: () => void;
}) {
  const { c } = useTheme();

  return (
    <ScrollView
      contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="on-drag"
    >
      {categoriesLoading ? (
        <DiscoveryHubSkeleton tiles={CRAVINGS_COUNT} />
      ) : (
        <Animated.View entering={FadeIn.duration(250)} style={styles.discovery}>
          {/* ── Antojos ──
              El índice visual: se escanea y se elige, no se desliza. Mezcla
              a propósito categorías de negocio (Droguería, Mercado) con las
              de comida que ya existen como categoría — para el usuario son
              lo mismo, un antojo resuelto en un toque. */}
          <CravingsGrid categories={categories} onSelect={onSelectCategory} />

          {/* ── Las colecciones ──
              Aquí deja de ser un índice y pasa a ser un feed: hasta arriba
              todo servía a quien ya sabe qué quiere; esto es lo único que
              responde a quien entró sin saberlo. */}
          <ExploreCollections coords={coords} ready={coordsReady} />

          {/* ── Mandados ── */}
          {/* Cierra la lista a propósito: si ninguna categoría es lo que
              buscas, esto es la salida. Una categoría lleva a una lista de
              negocios; esto no lleva a ninguna, es para lo que no está en
              ninguna carta. */}
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
      )}
    </ScrollView>
  );
});

/**
 * Grid 4×2 de antojos.
 *
 * Sin novena baldosa "Ver todo": no hay todavía una pantalla de "todas las
 * categorías" a la que llevar (`docs/EXPLORAR.md` B7, pendiente). Un botón
 * que no lleva a ningún lado es peor que no tenerlo.
 *
 * Fuente de datos: categorías de negocio (`useHomeCategories`), las mismas
 * que ya usa el grid de Inicio. Los tags de comida por producto
 * (`hamburguesa`, `pizza`, `pollo`…) que describe el documento existen en
 * el backend (`Product.tags`) pero no hay todavía un endpoint que los
 * exponga al móvil — cuando lo haya, este grid es el sitio donde se
 * mezclan con las categorías de negocio, no antes.
 */
const CravingsGrid = memo(function CravingsGrid({
  categories, onSelect,
}: { categories: DisplayCategory[]; onSelect: (key: string) => void }) {
  const tiles = categories.slice(0, CRAVINGS_COUNT);
  if (tiles.length === 0) return null;

  const rows = [tiles.slice(0, 4), tiles.slice(4, 8)].filter((row) => row.length > 0);

  return (
    <View style={styles.cravings}>
      <Text v="titleM">¿Qué se te antoja?</Text>
      <View style={styles.cravingsRows}>
        {rows.map((row, i) => (
          <View key={i} style={styles.cravingsRow}>
            {row.map((cat) => (
              <CategoryTile
                key={cat.key}
                categoryKey={cat.key}
                label={cat.label}
                imageUrl={cat.imageUrl}
                color={cat.color}
                onPress={() => onSelect(cat.key)}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.md,
  },
  discovery: { gap: Spacing.xxl },

  cravings: { paddingHorizontal: Spacing.xl, gap: Spacing.md },
  cravingsRows: { gap: Spacing.md },
  cravingsRow: { flexDirection: 'row', gap: Spacing.sm },

  errand: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  errandIcon: {
    width: 44, height: 44, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  errandCopy: { flex: 1, gap: 2 },
});
