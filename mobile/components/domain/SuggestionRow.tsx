import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text, Icon } from '../ui';
import { CatalogBadge } from '../ui/Badge';
import { categoryIllustration } from '../illustrations';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money } from '../../lib/format';
import { discountPercent, type BadgeableProduct } from '../../lib/catalog';
import {
  productImageUri, productImagePlaceholder, hasProductImage, type WithProductImage,
} from '../../lib/productImage';

export interface SuggestedProduct extends BadgeableProduct, WithProductImage {
  _id: string;
  name: string;
}

/**
 * La tira de acompañamientos.
 *
 * Vive fuera de las pantallas porque se ofrece en dos momentos distintos del
 * mismo pedido —al abrir un plato y al revisar la bolsa— y tiene que verse y
 * comportarse igual en los dos. Qué se sugiere lo decide `pickSuggestions`
 * (`lib/catalog.ts`); qué pasa al tocar "+" lo decide quien la monta, porque
 * agregar desde la carta y agregar desde la bolsa no terminan igual.
 */
export function SuggestionRow<T extends SuggestedProduct>({
  products, accent, category, justAddedId, onAdd, title = 'Para acompañar', bleed = 0,
}: {
  products: T[];
  /** Color de marca del negocio, de fondo cuando el plato tiene foto. */
  accent: string;
  /** Categoría del negocio, para la ilustración de respaldo sin foto. */
  category: string;
  /** Producto con el check de "agregado" puesto ahora mismo. */
  justAddedId: string | null;
  onAdd: (product: T) => void;
  title?: string;
  /** Padding horizontal de la pantalla, para que las tarjetas lleguen al borde. */
  bleed?: number;
}) {
  const { c } = useTheme();
  const Illustration = categoryIllustration(category);

  if (products.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text v="label" tone="textMuted">{title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={bleed ? { marginHorizontal: -bleed } : undefined}
        contentContainerStyle={[styles.row, bleed ? { paddingHorizontal: bleed } : null]}
      >
        {products.map((item) => {
          const added = justAddedId === item._id;
          const itemPrice = item.discountPrice ?? item.price;
          const itemPct = discountPercent(item);

          return (
            <View
              key={item._id}
              style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View
                style={[
                  styles.image,
                  { backgroundColor: hasProductImage(item) ? accent : c.surfaceLight },
                ]}
              >
                {hasProductImage(item) ? (
                  <Image
                    source={{ uri: productImageUri(item, 'thumb')! }}
                    placeholder={productImagePlaceholder(item)}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    accessible={false}
                  />
                ) : (
                  <Illustration size={26} />
                )}
                {itemPct ? (
                  <View style={styles.ribbon}>
                    <CatalogBadge kind="descuento" label={`-${itemPct}%`} />
                  </View>
                ) : null}
              </View>

              <Text v="bodyS" numberOfLines={1}>{item.name}</Text>

              <View style={styles.footer}>
                <Text v="dataS" tone="primaryText">{money(itemPrice)}</Text>
                <Pressable
                  onPress={() => onAdd(item)}
                  disabled={added}
                  accessibilityRole="button"
                  accessibilityLabel={
                    added
                      ? `${item.name} agregado`
                      : `Agregar ${item.name}, ${money(itemPrice)} adicional`
                  }
                  style={[styles.addBtn, { backgroundColor: added ? c.lime : c.primary }]}
                >
                  <Icon name={added ? 'check' : 'mas'} size="sm" color={c.textOnPrimary} strong />
                </Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.sm },
  row: { gap: Spacing.md, paddingRight: Spacing.md },
  card: {
    width: 128,
    padding: Spacing.sm + 2,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    gap: Spacing.xs + 1,
  },
  image: {
    width: '100%', height: 64, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  ribbon: { position: 'absolute', top: 4, left: 4 },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  addBtn: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },
});
