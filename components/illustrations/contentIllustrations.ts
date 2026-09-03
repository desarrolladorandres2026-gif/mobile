import type { ComponentType } from 'react';
import { TrophyIllustration } from './TrophyIllustration';
import { StreakIllustration } from './StreakIllustration';
import { CouponIllustration } from './CouponIllustration';
import { FavoriteIllustration } from './FavoriteIllustration';
import { PackageIllustration } from './PackageIllustration';
import { PaymentCardIllustration } from './PaymentCardIllustration';
import { CashIllustration } from './CashIllustration';
import { WalletIllustration } from './WalletIllustration';
import { DeliveryIllustration } from './DeliveryIllustration';
import { RatingIllustration } from './RatingIllustration';
import { SecurityIllustration } from './SecurityIllustration';
import { LocationIllustration } from './LocationIllustration';
import { NotificationIllustration } from './NotificationIllustration';
import { HelpIllustration } from './HelpIllustration';
import { GiftIllustration } from './GiftIllustration';
import { DocumentIllustration } from './DocumentIllustration';
import { DefaultIllustration } from './DefaultIllustration';
import type { IllustrationProps } from './types';

export {
  TrophyIllustration,
  StreakIllustration,
  CouponIllustration,
  FavoriteIllustration,
  PackageIllustration,
  PaymentCardIllustration,
  CashIllustration,
  WalletIllustration,
  DeliveryIllustration,
  RatingIllustration,
  SecurityIllustration,
  LocationIllustration,
  NotificationIllustration,
  HelpIllustration,
  GiftIllustration,
  DocumentIllustration,
};

/**
 * Ilustraciones de "contenido": conceptos recurrentes de la app (puntos,
 * racha, cupones, favoritos, pedidos, pagos, calificación, seguridad,
 * ubicación, notificaciones, ayuda, invitar amigos) que antes se resolvían
 * con un icono lucide genérico. Se usan en lugar de `<Icon />` para todo lo
 * que sea categoría, servicio, promoción, cupón, puntos, módulo principal o
 * elemento destacado — no para acciones funcionales (esas siguen en
 * `theme/icons.ts`).
 */
export const ContentIllustrationRegistry = {
  trofeo: TrophyIllustration,
  racha: StreakIllustration,
  cupon: CouponIllustration,
  favorito: FavoriteIllustration,
  paquete: PackageIllustration,
  tarjeta: PaymentCardIllustration,
  efectivo: CashIllustration,
  billetera: WalletIllustration,
  domiciliario: DeliveryIllustration,
  calificacion: RatingIllustration,
  seguridad: SecurityIllustration,
  ubicacion: LocationIllustration,
  notificaciones: NotificationIllustration,
  ayuda: HelpIllustration,
  soporte: HelpIllustration,
  regalo: GiftIllustration,
  documento: DocumentIllustration,
  negocio: DefaultIllustration,
} as const;

export type ContentIllustrationName = keyof typeof ContentIllustrationRegistry;

export const contentIllustration = (
  name: ContentIllustrationName,
): ComponentType<IllustrationProps> => ContentIllustrationRegistry[name];
