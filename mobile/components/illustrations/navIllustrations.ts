import type { ComponentType } from 'react';
import { HomeIllustration } from './HomeIllustration';
import { ExploreIllustration } from './ExploreIllustration';
import { ShiftIllustration } from './ShiftIllustration';
import { ProfileIllustration } from './ProfileIllustration';
import { PackageIllustration } from './PackageIllustration';
import { CouponIllustration } from './CouponIllustration';
import { WalletIllustration } from './WalletIllustration';
import type { IllustrationProps } from './types';

export {
  HomeIllustration,
  ExploreIllustration,
  ShiftIllustration,
  ProfileIllustration,
};

/**
 * Ilustración por pestaña de la barra de navegación inferior (cliente y
 * domiciliario comparten esta tabla — ver `components/nav/TabBar.tsx`).
 *
 * Tres entradas reutilizan ilustraciones de `ContentIllustrationRegistry`
 * (pedidos, descuentos, billetera) porque el concepto ya tenía mini-imagen
 * propia; las otras cuatro (inicio, explorar, turno, perfil) son nuevas.
 */
export const NavIllustrationRegistry: Record<string, ComponentType<IllustrationProps>> = {
  home: HomeIllustration,
  search: ExploreIllustration,
  dashboard: ShiftIllustration,
  orders: PackageIllustration,
  offers: CouponIllustration,
  earnings: WalletIllustration,
  profile: ProfileIllustration,
};

export const navIllustration = (routeName: string): ComponentType<IllustrationProps> | undefined =>
  NavIllustrationRegistry[routeName];
