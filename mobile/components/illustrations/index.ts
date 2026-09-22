import type { ComponentType } from 'react';
import { LOGOS } from '../../lib/logos';
import { pngIllustration } from './pngIllustration';
import { ContentIllustrationRegistry, DefaultIllustration } from './contentIllustrations';
import type { IllustrationProps } from './types';

export type { IllustrationProps };
export * from './contentIllustrations';
export * from './addressIllustrations';
export { ContentIcon } from './ContentIcon';

/**
 * Ilustración por clave de categoría de negocio. `errand` no es categoría:
 * es la salida de "no está en carta" (mandados). Cualquier `key` que el
 * backend mande y no esté aquí cae en `DefaultIllustration`.
 */
const IllustrationRegistry: Record<string, ComponentType<IllustrationProps>> = {
  restaurant: ContentIllustrationRegistry.restaurante,
  fast_food: pngIllustration(LOGOS.fast_food),
  pharmacy: pngIllustration(LOGOS.pharmacy),
  cafe: pngIllustration(LOGOS.cafe),
  supermarket: pngIllustration(LOGOS.supermarket),
  errand: ContentIllustrationRegistry.paquete,
};

export const categoryIllustration = (key: string): ComponentType<IllustrationProps> =>
  IllustrationRegistry[key] ?? DefaultIllustration;
