import type { ComponentType } from 'react';
import { RestaurantIllustration } from './RestaurantIllustration';
import { FastFoodIllustration } from './FastFoodIllustration';
import { PharmacyIllustration } from './PharmacyIllustration';
import { CafeIllustration } from './CafeIllustration';
import { MarketIllustration } from './MarketIllustration';
import { PackageIllustration } from './PackageIllustration';
import { DefaultIllustration } from './DefaultIllustration';
import type { IllustrationProps } from './types';

export type { IllustrationProps };
export { DefaultIllustration };
export * from './contentIllustrations';
export * from './addressIllustrations';
export * from './navIllustrations';
export { ContentIcon } from './ContentIcon';

/**
 * Ilustración por clave de categoría de negocio.
 *
 * Análogo a `categoryIcon()` en `theme/icons.ts`, pero para el grid de
 * categorías de Home/Search: ahí ya no se usan iconos de librería, sino
 * mini-ilustraciones propias. Cualquier `key` que el backend mande y que no
 * esté aquí cae en `DefaultIllustration` (la resuelve `CategoryTile`).
 *
 * `errand` no es una categoría de negocio: es la salida de "no está en
 * ninguna carta" (mandados). Vive aquí para que el cuadro del Home use la
 * misma caja de cartón que el resto del set en vez del toldo genérico.
 */
export const IllustrationRegistry: Record<string, ComponentType<IllustrationProps>> = {
  restaurant: RestaurantIllustration,
  fast_food: FastFoodIllustration,
  pharmacy: PharmacyIllustration,
  cafe: CafeIllustration,
  supermarket: MarketIllustration,
  errand: PackageIllustration,
};

export const categoryIllustration = (key: string): ComponentType<IllustrationProps> =>
  IllustrationRegistry[key] ?? DefaultIllustration;
