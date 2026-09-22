import { useEffect, useRef, useState } from 'react';
import {
  Modal, View, StyleSheet, Pressable, useWindowDimensions, FlatList,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, Icon } from '../ui';
import type { ProductImages } from '../../lib/productImage';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Visor de fotos a pantalla completa.
 *
 * Existe porque una foto de 300 pt de alto dentro de una hoja no permite
 * decidir si una hamburguesa trae el pan que uno espera. Aquí la foto ocupa
 * la pantalla y se desliza entre las que haya.
 *
 * Fondo negro sólido y no un velo translúcido: la foto es lo único que
 * importa mientras esto está abierto, y cualquier cosa que se transparente
 * detrás compite con ella. Es la única pantalla de la app que ignora el
 * tema del sistema, y lo hace a conciencia.
 */

export function Lightbox({
  images,
  initialIndex = 0,
  visible,
  onClose,
}: {
  images: ProductImages[];
  initialIndex?: number;
  visible: boolean;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ProductImages>>(null);
  const [index, setIndex] = useState(initialIndex);

  // Abrir siempre por la foto que se tocó. Si el visor recordara la última
  // que se miró, tocar la portada abriría otra distinta.
  useEffect(() => {
    if (visible) setIndex(initialIndex);
  }, [visible, initialIndex]);

  if (images.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.screen}>
        <FlatList
          ref={listRef}
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={initialIndex}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item, i) => `${item.large}-${i}`}
          // Todas las páginas miden lo mismo, así que la lista no necesita
          // medirlas: sin esto, `initialScrollIndex` puede abrir en blanco.
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => {
            setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
          }}
          renderItem={({ item, index: page }) => (
            <View style={{ width, height }}>
              <Image
                source={{ uri: item.large }}
                // La principal abre con la de la ficha, que ya está en el
                // teléfono: nítida al instante y afina al llegar la grande.
                // Las demás nunca se vieron en ese tamaño —pedirlo sería
                // otra descarga por foto—, así que abren con la borrosa.
                placeholder={
                  page === 0 ? { uri: item.detail } : item.placeholder ? { uri: item.placeholder } : undefined
                }
                placeholderContentFit={page === 0 ? 'contain' : undefined}
                style={StyleSheet.absoluteFill}
                // `contain` y no `cover`: recortar la foto en el visor es
                // exactamente lo que el cliente vino a evitar.
                contentFit="contain"
                transition={160}
              />
            </View>
          )}
        />

        <Pressable
          onPress={() => {
            tap('light');
            onClose();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Cerrar la foto"
          style={[styles.close, { top: insets.top + Spacing.md }]}
        >
          <Icon name="cerrar" size="md" color="#FFFFFF" />
        </Pressable>

        {images.length > 1 ? (
          <View style={[styles.counter, { bottom: insets.bottom + Spacing.xl }]}>
            <Text v="caption" style={styles.counterText}>
              {index + 1} / {images.length}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000' },
  close: {
    position: 'absolute',
    right: Spacing.lg,
    padding: Spacing.sm,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  counterText: { color: '#FFFFFF' },
});
