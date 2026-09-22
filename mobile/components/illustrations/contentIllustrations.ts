import type { ComponentType } from 'react';
import { LOGOS } from '../../lib/logos';
import { pngIllustration } from './pngIllustration';
import type { IllustrationProps } from './types';
import type { IconName } from '../../theme/icons';

/** Genérica: negocio sin categoría reconocida — nunca un cuadro vacío. */
export const DefaultIllustration = pngIllustration(LOGOS.negocio);

const help = pngIllustration(LOGOS.ayuda);
const sweet = pngIllustration(LOGOS.dulce);

/**
 * Ilustraciones de "contenido": conceptos recurrentes de la app (puntos,
 * racha, cupones, favoritos, pedidos, pagos, calificación, seguridad,
 * ubicación, notificaciones, ayuda, invitar amigos). Logos PNG de
 * `lib/logos.ts`. Se usan en lugar de `<Icon />` para todo lo que sea
 * categoría, servicio, promoción, cupón, puntos, módulo principal o elemento
 * destacado — no para acciones funcionales (esas siguen en `theme/icons.ts`).
 */
export const ContentIllustrationRegistry = {
  trofeo: pngIllustration(LOGOS.trofeo),
  racha: pngIllustration(LOGOS.racha),
  cupon: pngIllustration(LOGOS.cupon),
  favorito: pngIllustration(LOGOS.favorito),
  paquete: pngIllustration(LOGOS.paquete),
  tarjeta: pngIllustration(LOGOS.tarjeta),
  efectivo: pngIllustration(LOGOS.efectivo),
  billetera: pngIllustration(LOGOS.billetera),
  domiciliario: pngIllustration(LOGOS.domiciliario),
  calificacion: pngIllustration(LOGOS.calificacion),
  seguridad: pngIllustration(LOGOS.seguridad),
  ubicacion: pngIllustration(LOGOS.ubicacion),
  notificaciones: pngIllustration(LOGOS.notificaciones),
  ayuda: help,
  soporte: help,
  regalo: pngIllustration(LOGOS.regalo),
  documento: pngIllustration(LOGOS.documento),
  negocio: DefaultIllustration,
  dulce: sweet,
  // Nombre que usan las semillas de colecciones del backend para `algoDulce`.
  postre: sweet,
  bebida: pngIllustration(LOGOS.bebida),
  etiqueta: pngIllustration(LOGOS.etiqueta),
  corona: pngIllustration(LOGOS.corona),
  tendencia: pngIllustration(LOGOS.tendencia),
  hielo: pngIllustration(LOGOS.hielo),
  explorar: pngIllustration(LOGOS.explorar),
  bolsa: pngIllustration(LOGOS.bolsa),
  consentimiento: pngIllustration(LOGOS.consentimiento),
  restaurante: pngIllustration(LOGOS.restaurant),
  nuevo: pngIllustration(LOGOS.nuevo),
  estrella: pngIllustration(LOGOS.estrella),
  repetir: pngIllustration(LOGOS.repetir),
} as const;

export type ContentIllustrationName = keyof typeof ContentIllustrationRegistry;

export const contentIllustration = (
  name: ContentIllustrationName,
): ComponentType<IllustrationProps> => ContentIllustrationRegistry[name];

/** Para nombres que llegan del servidor como texto libre: `undefined` si no existe. */
export const contentIllustrationByName = (
  name: string | undefined,
): ComponentType<IllustrationProps> | undefined =>
  name && Object.prototype.hasOwnProperty.call(ContentIllustrationRegistry, name)
    ? ContentIllustrationRegistry[name as ContentIllustrationName]
    : undefined;

/**
 * Puente icono → ilustración.
 *
 * Los estados vacíos se escribieron pidiendo un icono lucide, y el
 * vocabulario de ambos registros coincide. Este mapa deja que `EmptyState`
 * use la ilustración sin tocar los sitios que lo invocan: si el icono está
 * aquí se pinta la ilustración, y si no se conserva el glifo.
 *
 * Solo entra lo que representa el mismo concepto: es mejor un glifo honesto
 * que una ilustración que habla de otra cosa.
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
  bolsa: 'bolsa',
  catRestaurante: 'restaurante',
  consentimiento: 'consentimiento',
};

/** Ilustración equivalente a un icono, si el concepto la tiene. */
export const illustrationForIcon = (
  icon: IconName,
): ComponentType<IllustrationProps> | undefined => {
  const name = IconToIllustration[icon];
  return name ? ContentIllustrationRegistry[name] : undefined;
};
