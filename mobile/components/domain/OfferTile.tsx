import { memo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Spacing, Shadow, palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { productImageUri, productImagePlaceholder } from '../../lib/productImage';
import { money } from '../../lib/format';
import type { ProductSearchHit } from '../../services/endpoints';

/**
 * Un plato rebajado, con la etiqueta de precio pegada encima.
 *
 * La etiqueta sobresale de la foto a propósito. Dentro de la tarjeta sería
 * un dato más entre el nombre y el negocio; montada sobre el borde se lee
 * como lo que es: algo que alguien pegó encima del producto. Ese solape es
 * todo el truco, y es lo que diferencia esta baldosa del tiquete de cupón
 * sin recurrir a otro color.
 *
 * El radio es generoso —lo contrario que el tiquete, que es papel impreso—
 * porque aquí lo que se vende es comida y la forma blanda ayuda.
 */
export const OfferTile = memo(function OfferTile({
  product, width = 176, imageHeight = 116, onPress,
}: {
  product: ProductSearchHit;
  width?: number | `${number}%`;
  /**
   * En el riel la baldosa es estrecha y la foto baja; a ancho completo, en
   * la lista de "Ver todo", esa misma altura deja la imagen aplastada.
   */
  imageHeight?: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const uri = productImageUri(product as never, 'catalog');
  const Illustration = categoryIllustration(product.businessCategory ?? '');

  const price = product.discountPrice ?? product.price;
  const percent = product.discountPercent ?? 0;

  return (
    <Pressable
      onPress={() => { tap('light'); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={
        `${product.name} en ${product.businessName}. ` +
        `Antes ${money(product.price)}, ahora ${money(price)}`
      }
      accessibilityHint="Abre el plato"
      style={[styles.tile, { width, backgroundColor: c.surface }, Shadow.sm]}
    >
      <View style={styles.frame}>
        {uri ? (
          <Image
            source={{ uri }}
            style={[styles.image, { height: imageHeight }]}
            contentFit="cover"
            transition={150}
            // El backend ya mandaba esta miniatura borrosa en cada producto
            // y nadie la usaba: es la diferencia entre un hueco gris y algo
            // que ya se parece al plato mientras carga.
            placeholder={productImagePlaceholder(product as never)}
            cachePolicy="memory-disk"
            recyclingKey={product._id}
          />
        ) : (
          <View
            style={[styles.image, styles.fallback, { height: imageHeight, backgroundColor: c.surfaceLight }]}
          >
            <Illustration size={52} />
          </View>
        )}

        {percent > 0 ? (
          <View style={[styles.tag, Shadow.md, { backgroundColor: palette.gold400 }]}>
            <Text v="dataL" color={palette.ink900}>−{percent}%</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text v="strongM" numberOfLines={1}>{product.name}</Text>
        <Text v="caption" tone="textMuted" numberOfLines={1}>{product.businessName}</Text>

        <View style={styles.prices}>
          <Text v="dataL" tone="text">{money(price)}</Text>
          <Text v="dataS" tone="textMuted" style={styles.strike}>{money(product.price)}</Text>
        </View>
      </View>
    </Pressable>
  );
});

/** Cuánto baja la etiqueta por debajo del borde de la foto. */
const TAG_DROP = 14;

const styles = StyleSheet.create({
  tile: {
    borderRadius: BorderRadius.xl,
    overflow: 'visible',
  },
  frame: {
    // La foto lleva el radio de la baldosa arriba y recto abajo: así el
    // cuerpo blanco parece una banda de papel bajo la imagen, no otra caja.
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    overflow: 'visible',
  },
  image: {
    width: '100%',
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
  },
  fallback: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },

  tag: {
    position: 'absolute',
    right: Spacing.md,
    bottom: -TAG_DROP,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
  },

  body: { padding: Spacing.md, paddingTop: TAG_DROP + Spacing.xs, gap: 1 },
  prices: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm, marginTop: Spacing.xs },
  strike: { textDecorationLine: 'line-through' },
});
