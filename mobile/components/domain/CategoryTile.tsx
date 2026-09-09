import { memo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

export interface CategoryTileProps {
  categoryKey: string;
  label: string;
  /** Imagen configurada por el admin. Si falta o falla, cae en la ilustración local. */
  imageUrl?: string;
  onPress?: () => void;
  selected?: boolean;
  /**
   * `tile` (por defecto): cuadro + etiqueta debajo, para el grid de
   * Categorías. `icon` dibuja solo el cuadro — para cuando el layout ya
   * pinta la etiqueta al lado, como la fila de "Explorar por categoría".
   */
  layout?: 'tile' | 'icon';
}

/**
 * Mini-ilustración de una categoría de negocio, con imagen remota opcional.
 *
 * Reemplaza el icono genérico de lucide en el grid de Categorías: si el
 * admin configuró `imageUrl` se usa esa imagen (con el mismo cache de
 * `expo-image` que el resto de la app); si no hay imagen, o falla al
 * cargar, se dibuja la ilustración SVG propia de esa categoría.
 */
export const CategoryTile = memo(function CategoryTile({
  categoryKey, label, imageUrl, onPress, selected, layout = 'tile',
}: CategoryTileProps) {
  const { c } = useTheme();
  const [broken, setBroken] = useState(false);

  const Illustration = categoryIllustration(categoryKey);
  const showImage = !!imageUrl && !broken;

  const box = (
    <View
      style={[
        styles.box,
        layout === 'icon' && styles.boxCompact,
        {
          backgroundColor: c.surface,
          borderColor: selected ? c.primary : c.border,
          borderWidth: selected ? 2 : 1,
        },
        layout === 'tile' && Shadow.sm,
      ]}
    >
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
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
  );

  return (
    <Pressable
      onPress={onPress ? () => { tap('light'); onPress(); } : undefined}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected !== undefined ? { selected } : undefined}
      style={layout === 'tile' ? styles.tileWrap : styles.iconWrap}
    >
      {box}
      {layout === 'tile' ? (
        <Text v="caption" tone="textSecondary" center numberOfLines={2}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tileWrap: { flex: 1, alignItems: 'center', gap: Spacing.sm },
  iconWrap: {},

  box: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  boxCompact: {
    width: 44,
    height: 44,
    aspectRatio: undefined,
  },
});
