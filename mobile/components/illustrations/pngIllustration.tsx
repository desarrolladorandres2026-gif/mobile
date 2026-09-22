import { memo, type ComponentType } from 'react';
import { View, type DimensionValue } from 'react-native';
import { Image } from 'expo-image';
import type { IllustrationProps } from './types';

/**
 * El emoji llena su lienzo; la ilustración SVG que reemplaza dejaba aire
 * alrededor. A esta escala el PNG pesa lo mismo que el dibujo anterior y
 * ningún layout se mueve.
 */
const LOGO_SCALE = 0.8;

/**
 * Convierte un logo PNG en un componente con el contrato de las
 * ilustraciones (`size`, `bleed`), para que los registros cambien de SVG a
 * PNG sin tocar a quienes los consumen. `bleed` no aplica: el PNG no trae
 * fondo que llevar a sangre.
 */
export function pngIllustration(source: number): ComponentType<IllustrationProps> {
  return memo(function PngIllustration({ size = 48 }: IllustrationProps) {
    const box = size as DimensionValue;
    const inner: DimensionValue = typeof size === 'number' ? size * LOGO_SCALE : `${LOGO_SCALE * 100}%`;
    return (
      <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>
        <Image
          source={source}
          style={{ width: inner, height: inner }}
          contentFit="contain"
          cachePolicy="memory-disk"
          accessible={false}
        />
      </View>
    );
  });
}
