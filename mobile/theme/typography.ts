import { Platform } from 'react-native';
import type { TextStyle } from 'react-native';

/**
 * Fuente nativa del sistema — San Francisco en iOS, Roboto en Android — en
 * vez de una tipografía empaquetada. Segoe UI Variable (la fuente pedida
 * para los paneles web, ver colores.css) es propietaria de Microsoft y no
 * tiene licencia de redistribución: no hay forma legal de meterla dentro del
 * bundle de una app móvil. Ni Office ni Teams la usan en sus apps de
 * iOS/Android por el mismo motivo — ahí corren con la fuente del sistema.
 *
 * Con Inter, el peso vivía en el nombre del archivo (Inter_600SemiBold). Con
 * la fuente del sistema no hay un archivo por peso: hay que declarar
 * `fontWeight` explícito en cada rol de `Type` (ver más abajo).
 */
const SYSTEM_FONT = Platform.OS === 'ios' ? 'System' : 'sans-serif';

export const FontFamily = {
  display: SYSTEM_FONT,
  displayBold: SYSTEM_FONT,

  regular: SYSTEM_FONT,
  medium: SYSTEM_FONT,
  semibold: SYSTEM_FONT,
  bold: SYSTEM_FONT,

  data: SYSTEM_FONT,
  dataBold: SYSTEM_FONT,
} as const;

/** Pesos por rol. Acompañan siempre a `FontFamily`, nunca van solos. */
export const FontWeight = {
  display: '800',
  displayBold: '700',

  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',

  data: '500',
  dataBold: '700',
} as const satisfies Record<keyof typeof FontFamily, TextStyle['fontWeight']>;

/**
 * Estilos con nombre. Las pantallas componen desde aquí en vez de repetir
 * fontSize/fontWeight sueltos, que es como una app pierde consistencia.
 */
export const Type = {
  // ── Display: peso 800. Se usa con moderación, solo donde hay jerarquía real.
  displayXL: {
    fontFamily: FontFamily.display,
    fontWeight: FontWeight.display,
    fontSize: 40,
    lineHeight: 43,
    letterSpacing: -1.4,
  },
  displayL: {
    fontFamily: FontFamily.display,
    fontWeight: FontWeight.display,
    fontSize: 32,
    lineHeight: 35,
    letterSpacing: -1,
  },
  displayM: {
    fontFamily: FontFamily.display,
    fontWeight: FontWeight.display,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.7,
  },
  displayS: {
    fontFamily: FontFamily.display,
    fontWeight: FontWeight.display,
    fontSize: 21,
    lineHeight: 25,
    letterSpacing: -0.4,
  },

  // ── Títulos de sección y de tarjeta
  titleL: {
    fontFamily: FontFamily.displayBold,
    fontWeight: FontWeight.displayBold,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.3,
  },
  titleM: {
    fontFamily: FontFamily.displayBold,
    fontWeight: FontWeight.displayBold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  titleS: {
    fontFamily: FontFamily.displayBold,
    fontWeight: FontWeight.displayBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },

  // ── Texto corrido
  bodyL: { fontFamily: FontFamily.regular, fontWeight: FontWeight.regular, fontSize: 17, lineHeight: 25 },
  bodyM: { fontFamily: FontFamily.regular, fontWeight: FontWeight.regular, fontSize: 15, lineHeight: 22 },
  bodyS: { fontFamily: FontFamily.regular, fontWeight: FontWeight.regular, fontSize: 13, lineHeight: 19 },

  // ── Texto con énfasis
  strongL: { fontFamily: FontFamily.semibold, fontWeight: FontWeight.semibold, fontSize: 17, lineHeight: 24 },
  strongM: { fontFamily: FontFamily.semibold, fontWeight: FontWeight.semibold, fontSize: 15, lineHeight: 21 },
  strongS: { fontFamily: FontFamily.semibold, fontWeight: FontWeight.semibold, fontSize: 13, lineHeight: 18 },

  // ── Etiquetas y microcopy
  /** Encabezado de grupo. Mayúsculas, muy espaciado, siempre en color apagado. */
  label: {
    fontFamily: FontFamily.bold,
    fontWeight: FontWeight.bold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  caption: { fontFamily: FontFamily.medium, fontWeight: FontWeight.medium, fontSize: 11, lineHeight: 15 },
  captionStrong: { fontFamily: FontFamily.bold, fontWeight: FontWeight.bold, fontSize: 11, lineHeight: 15 },

  // ── Botones
  buttonLg: { fontFamily: FontFamily.bold, fontWeight: FontWeight.bold, fontSize: 17, letterSpacing: -0.2 },
  buttonMd: { fontFamily: FontFamily.bold, fontWeight: FontWeight.bold, fontSize: 15, letterSpacing: -0.1 },
  buttonSm: { fontFamily: FontFamily.bold, fontWeight: FontWeight.bold, fontSize: 13 },

  // ── Datos: minutos, kilómetros, pesos, códigos
  dataXL: {
    fontFamily: FontFamily.dataBold,
    fontWeight: FontWeight.dataBold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -1.5,
  },
  dataL: {
    fontFamily: FontFamily.dataBold,
    fontWeight: FontWeight.dataBold,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.8,
  },
  dataM: {
    fontFamily: FontFamily.dataBold,
    fontWeight: FontWeight.dataBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.4,
  },
  dataS: {
    fontFamily: FontFamily.data,
    fontWeight: FontWeight.data,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: -0.2,
  },
  dataXS: {
    fontFamily: FontFamily.data,
    fontWeight: FontWeight.data,
    fontSize: 11,
    lineHeight: 14,
  },
  /** Códigos de pedido y de cupón: espaciados para poder dictarlos en voz alta. */
  code: {
    fontFamily: FontFamily.dataBold,
    fontWeight: FontWeight.dataBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 1.6,
  },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof Type;
