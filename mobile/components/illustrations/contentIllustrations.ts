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
import { SweetIllustration } from './SweetIllustration';
import { DrinkIllustration } from './DrinkIllustration';
import { PriceTagIllustration } from './PriceTagIllustration';
import { CrownIllustration } from './CrownIllustration';
import { TrendingIllustration } from './TrendingIllustration';
import { IceCubeIllustration } from './IceCubeIllustration';
import { ExploreIllustration } from './ExploreIllustration';
import type { IllustrationProps } from './types';
import type { IconName } from '../../theme/icons';

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
  SweetIllustration,
  DrinkIllustration,
  PriceTagIllustration,
  CrownIllustration,
  TrendingIllustration,
  IceCubeIllustration,
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
  // Sumadas para las colecciones dinámicas del inicio: conceptos sin
  // equivalente entre los anteriores (dulce, bebida, precio bajo, premium,
  // tendencia, frío), mismo patrón visual que el resto del set.
  dulce: SweetIllustration,
  bebida: DrinkIllustration,
  etiqueta: PriceTagIllustration,
  corona: CrownIllustration,
  tendencia: TrendingIllustration,
  hielo: IceCubeIllustration,
  // La brújula ya existía dibujada para la barra de pestañas, que volvió a
  // iconos: entra aquí porque "buscar" también es un vacío de la app, y el
  // de Explorar era el único que seguía mostrando un glifo dentro de un
  // cuadro gris.
  explorar: ExploreIllustration,
} as const;

export type ContentIllustrationName = keyof typeof ContentIllustrationRegistry;

export const contentIllustration = (
  name: ContentIllustrationName,
): ComponentType<IllustrationProps> => ContentIllustrationRegistry[name];

/**
 * Puente icono → ilustración.
 *
 * Los estados vacíos se escribieron pidiendo un icono lucide, pero buena parte
 * de esos conceptos ya tiene ilustración propia y el vocabulario de ambos
 * registros coincide. Este mapa deja que `EmptyState` la use sin tocar los
 * dieciséis sitios que lo invocan: si el icono está aquí se pinta la
 * ilustración, y si no se conserva el glifo dentro del cuadro.
 *
 * Solo entra lo que representa el mismo concepto. Un icono sin equivalente
 * exacto se queda fuera a propósito: es mejor un glifo honesto que una
 * ilustración que habla de otra cosa.
 */
export const IconToIllustration: Partial<Record<IconName, ContentIllustrationName>> = {
  favorito: 'favorito',
  cupon: 'cupon',
  descuento: 'cupon',
  soporte: 'soporte',
  ayuda: 'ayuda',
  documento: 'documento',
  privacidad: 'seguridad',
  seguridad: 'seguridad',
  ubicacion: 'ubicacion',
  navegar: 'ubicacion',
  pedidos: 'paquete',
  paquete: 'paquete',
  ruta: 'domiciliario',
  domiciliario: 'domiciliario',
  notificaciones: 'notificaciones',
  trofeo: 'trofeo',
  racha: 'racha',
  regalo: 'regalo',
  calificacion: 'calificacion',
  efectivo: 'efectivo',
  tarjeta: 'tarjeta',
  billetera: 'billetera',
  negocio: 'negocio',
  explorar: 'explorar',
};

/** Ilustración equivalente a un icono, si el concepto la tiene. */
export const illustrationForIcon = (
  icon: IconName,
): ComponentType<IllustrationProps> | undefined => {
  const name = IconToIllustration[icon];
  return name ? ContentIllustrationRegistry[name] : undefined;
};
