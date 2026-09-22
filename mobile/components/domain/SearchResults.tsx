import { memo } from 'react';
import { View, Pressable, FlatList, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text, Icon, EmptyState, ErrorState, BusinessResultRowSkeleton, Card } from '../ui';
import { BusinessResultRow, type Business } from './BusinessCard';
import { categoryIllustration } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { productImageUri, productImagePlaceholder } from '../../lib/productImage';
import { minutes } from '../../lib/format';
import { BorderRadius, Spacing } from '../../theme/tokens';
import type { ProductSearchHit, SearchSuggestion } from '../../services/endpoints';

/** Cuántos fantasmas de fila caben antes de que haya que deslizar. */
const SKELETON_ROWS = 7;

export interface SearchResultsProps {
  /** Sugerencias mientras se escribe: máxima prioridad, por encima de error o resultados. */
  showSuggestions: boolean;
  typed: string;
  suggestions: SearchSuggestion[];
  onPickSuggestion: (item: SearchSuggestion) => void;
  onSearchTyped: () => void;

  isError: boolean;
  onRetry: () => void;

  /** Buscando o esperando a que el término se asiente tras el debounce. */
  loading: boolean;

  results: Business[];
  products: ProductSearchHit[];
  suggestedTerm?: string;
  term: string;
  /** El nombre que administración le puso a cada categoría, para las filas. */
  categoryNames: Record<string, string>;
  onOpenBusiness: (id: string) => void;
  onLoadMore: () => void;

  bottomSpace: number;
  outOfCoverage: boolean;
  activeFilters: number;
  onClearFilters: () => void;
  onChangeAddress: () => void;
}

/**
 * El modo "comparar" de Explorar: con un término escrito o una categoría
 * puesta, esto es una lista para medir opciones entre sí — filas compactas,
 * la misma silueta para un plato y para un negocio.
 *
 * Encapsula las cinco cosas que puede estar pasando mientras se busca:
 * sugerencias, error, esperando resultados, la lista, o la lista vacía. El
 * orden de las comprobaciones es el orden de prioridad real — sugerencias
 * primero porque van pegadas al dedo, error antes que "cargando" porque un
 * error no es un estado transitorio.
 */
export const SearchResults = memo(function SearchResults({
  showSuggestions, typed, suggestions, onPickSuggestion, onSearchTyped,
  isError, onRetry,
  loading,
  results, products, suggestedTerm, term, categoryNames, onOpenBusiness, onLoadMore,
  bottomSpace, outOfCoverage, activeFilters, onClearFilters, onChangeAddress,
}: SearchResultsProps) {
  if (showSuggestions) {
    return (
      <SuggestionList
        typed={typed}
        items={suggestions}
        onPick={onPickSuggestion}
        onSearchTyped={onSearchTyped}
        bottomSpace={bottomSpace}
      />
    );
  }

  if (isError) {
    return <ErrorState onRetry={onRetry} />;
  }

  if (loading) {
    return (
      <View style={styles.skeletons}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <BusinessResultRowSkeleton key={i} />
        ))}
      </View>
    );
  }

  return (
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
      onEndReached={onLoadMore}
      onEndReachedThreshold={0.5}
      renderItem={({ item }) => (
        <BusinessResultRow
          business={item}
          onPress={onOpenBusiness}
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
                    onPress={() => onOpenBusiness(product.businessId)}
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
            onAction={onChangeAddress}
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
            onAction={onClearFilters}
          />
        )
      }
    />
  );
});

// ── Piezas propias de los resultados ──

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

const styles = StyleSheet.create({
  flex: { flex: 1 },

  list: {
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.md,
  },
  skeletons: {
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.md,
  },

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

  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
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
});
