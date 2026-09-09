import type { ComponentType } from 'react';
import { RestaurantIllustration } from './RestaurantIllustration';
import { FastFoodIllustration } from './FastFoodIllustration';
import { PharmacyIllustration } from './PharmacyIllustration';
import { CafeIllustration } from './CafeIllustration';
import { MarketIllustration } from './MarketIllustration';
import { CategoriesIllustration } from './CategoriesIllustration';

export { PackageIllustration } from './PackageIllustration';
export { CashIllustration } from './CashIllustration';
export { StoreIllustration } from './StoreIllustration';
export { DeliveryIllustration } from './DeliveryIllustration';
export { DashboardIllustration } from './DashboardIllustration';
export { PeopleIllustration } from './PeopleIllustration';
export { PricingIllustration } from './PricingIllustration';
export { CouponIllustration } from './CouponIllustration';
export { LocationIllustration } from './LocationIllustration';
export { BannerIllustration } from './BannerIllustration';
export { CategoriesIllustration } from './CategoriesIllustration';
export { MegaphoneIllustration } from './MegaphoneIllustration';
export { SecurityIllustration } from './SecurityIllustration';
export { EvidenceIllustration } from './EvidenceIllustration';
export { WalletIllustration } from './WalletIllustration';
export { LegalIllustration } from './LegalIllustration';
export { CalendarIllustration } from './CalendarIllustration';
export { PositionsIllustration } from './PositionsIllustration';
export { RolesIllustration } from './RolesIllustration';
export { RestaurantIllustration } from './RestaurantIllustration';
export { FastFoodIllustration } from './FastFoodIllustration';
export { PharmacyIllustration } from './PharmacyIllustration';
export { CafeIllustration } from './CafeIllustration';
export { MarketIllustration } from './MarketIllustration';

/**
 * Ilustración por clave de categoría de negocio. Espejo de
 * `mobile/components/illustrations/index.ts`: las mismas cinco categorías
 * canónicas de `BusinessCategory`, y cualquier clave desconocida cae en la
 * ilustración genérica de "categorías" en vez de un icono de librería.
 */
const CATEGORY_ILLUSTRATIONS: Record<string, ComponentType<{ size?: number }>> = {
  restaurant: RestaurantIllustration,
  fast_food: FastFoodIllustration,
  pharmacy: PharmacyIllustration,
  cafe: CafeIllustration,
  supermarket: MarketIllustration,
};

export const categoryIllustration = (key: string): ComponentType<{ size?: number }> =>
  CATEGORY_ILLUSTRATIONS[key] ?? CategoriesIllustration;
