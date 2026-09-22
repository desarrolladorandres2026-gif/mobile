import { memo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui';
import { categoryIllustration } from '../illustrations';
import { categoryLogo } from '../../lib/logos';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

export interface CategoryTileProps {
  categoryKey: string;
  label: string;
  /** Imagen configurada por el admin. Si falta o falla, cae en la ilustración local. */
  imageUrl?: string;
  /**
   * Color de respaldo configurado en el panel.
   *
   * Solo se ve cuando no hay imagen: la app trae arte propio para las cinco
   * categorías de siempre, y cualquier clave nueva cae en
   * `DefaultIllustration`. El color es lo que evita que esa categoría nueva
   * se vea como un cuadro apagado al lado de las que sí tienen dibujo.
   */
  color?: string;
  onPress?: () => void;
  selected?: boolean;
}

/**
 * Mini-ilustración de una categoría de negocio, con imagen remota opcional.
 *
 * Reemplaza el icono genérico de lucide en el grid de Categorías: si el
 * admin configuró `imageUrl` se usa esa imagen (con el mismo cache de
 * `expo-image` que el resto de la app); si no hay imagen, o falla al
 * cargar, se dibuja el logo de esa categoría.
 *
 * Una sola forma a propósito: el cuadro con la etiqueta debajo. Hubo una
 * variante `layout="icon"` de 44 px para pintar categorías como filas de
 * lista en Explorar, y era justo el problema — la misma categoría se dibujaba
 * de dos maneras en la misma pantalla. En Explorar la baldosa navega y el
 * chip filtra; para eso está `CategoryChip`.
 */
export const CategoryTile = memo(function CategoryTile({
  categoryKey, label, imageUrl, color, onPress, selected,
}: CategoryTileProps) {
  const [broken, setBroken] = useState(false);

  const Illustration = categoryIllustration(categoryKey);
  const logo = categoryLogo(categoryKey);
  const source = imageUrl ? { uri: imageUrl } : logo;
  const showImage = !!source && !broken;

  return (
    <Pressable
      onPress={onPress ? () => { tap('light'); onPress(); } : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected !== undefined ? { selected } : undefined}
      style={styles.tileWrap}
    >
      <View style={[styles.box, showImage && !imageUrl ? styles.logoBox : null, !showImage && color ? { backgroundColor: color } : null]}>
        {showImage ? (
          <Image
            source={source}
            style={imageUrl ? StyleSheet.absoluteFill : styles.logoImage}
            contentFit={imageUrl ? 'cover' : 'contain'}
            cachePolicy="memory-disk"
            recyclingKey={`cat-${categoryKey}`}
            onError={() => setBroken(true)}
            accessible={false}
          />
        ) : (
          // `size="100%"` + `bleed`: el SVG llena el cuadro de borde a borde
          // (fondo a sangre, sin blob circular) y el `overflow: hidden` del
          // cuadro redondea las esquinas.
          <Illustration size="100%" bleed />
        )}
      </View>

      <Text v="caption" tone="textSecondary" center numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tileWrap: { flex: 1, alignItems: 'center', gap: Spacing.sm },

  box: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // El logo (emoji-style, fondo transparente) no llena el cuadro como una
  // foto: se centra con aire alrededor sobre un fondo neutro.
  logoBox: { backgroundColor: 'rgba(148, 138, 111, 0.12)' },
  logoImage: { width: '58%', height: '58%' },
});
