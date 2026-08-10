import type { TextStyle } from 'react-native';

/**
 * Tres familias, tres trabajos. Ninguna hace el trabajo de otra.
 *
 * — Bricolage Grotesque (display): tiene rarezas deliberadas en la 'g', la 'a'
 *   y las aperturas cerradas. Da carácter en titulares sin gritar.
 *
 * — Inter (texto): la mejor pantalla pequeña que existe. Invisible a propósito.
 *
 * — JetBrains Mono (datos): toda cifra de la app va en mono. No es decoración:
 *   el total se recotiza en el servidor cada vez que cambias algo del carrito,
 *   y con cifras tabulares el precio no baila mientras se recalcula. Además le
 *   da a Zipp una textura de tiquete de despacho que nadie más tiene.
 */
export const FontFamily = {
  display: 'BricolageGrotesque_800ExtraBold',
  displayBold: 'BricolageGrotesque_700Bold',

  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',

  data: 'JetBrainsMono_500Medium',
  dataBold: 'JetBrainsMono_700Bold',
} as const;

/**
 * Estilos con nombre. Las pantallas componen desde aquí en vez de repetir
 * fontSize/fontWeight sueltos, que es como una app pierde consistencia.
 */
export const Type = {
  // ── Display: Bricolage. Se usa con moderación, solo donde hay jerarquía real.
  displayXL: {
    fontFamily: FontFamily.display,
    fontSize: 40,
    lineHeight: 43,
    letterSpacing: -1.4,
  },
  displayL: {
    fontFamily: FontFamily.display,
    fontSize: 32,
    lineHeight: 35,
    letterSpacing: -1,
  },
  displayM: {
    fontFamily: FontFamily.display,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.7,
  },
  displayS: {
    fontFamily: FontFamily.display,
    fontSize: 21,
    lineHeight: 25,
    letterSpacing: -0.4,
  },

  // ── Títulos de sección y de tarjeta
  titleL: {
    fontFamily: FontFamily.displayBold,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.3,
  },
  titleM: {
    fontFamily: FontFamily.displayBold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  titleS: {
    fontFamily: FontFamily.displayBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },

  // ── Texto corrido
  bodyL: { fontFamily: FontFamily.regular, fontSize: 17, lineHeight: 25 },
  bodyM: { fontFamily: FontFamily.regular, fontSize: 15, lineHeight: 22 },
  bodyS: { fontFamily: FontFamily.regular, fontSize: 13, lineHeight: 19 },

  // ── Texto con énfasis
  strongL: { fontFamily: FontFamily.semibold, fontSize: 17, lineHeight: 24 },
  strongM: { fontFamily: FontFamily.semibold, fontSize: 15, lineHeight: 21 },
  strongS: { fontFamily: FontFamily.semibold, fontSize: 13, lineHeight: 18 },

  // ── Etiquetas y microcopy
  /** Encabezado de grupo. Mayúsculas, muy espaciado, siempre en color apagado. */
  label: {
    fontFamily: FontFamily.bold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  caption: { fontFamily: FontFamily.medium, fontSize: 11, lineHeight: 15 },
  captionStrong: { fontFamily: FontFamily.bold, fontSize: 11, lineHeight: 15 },

  // ── Botones
  buttonLg: { fontFamily: FontFamily.bold, fontSize: 17, letterSpacing: -0.2 },
  buttonMd: { fontFamily: FontFamily.bold, fontSize: 15, letterSpacing: -0.1 },
  buttonSm: { fontFamily: FontFamily.bold, fontSize: 13 },

  // ── Datos: minutos, kilómetros, pesos, códigos
  dataXL: {
    fontFamily: FontFamily.dataBold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -1.5,
  },
  dataL: {
    fontFamily: FontFamily.dataBold,
    fontSize: 20,
    lineHeight: 25,
    letterSpacing: -0.8,
  },
  dataM: {
    fontFamily: FontFamily.dataBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.4,
  },
  dataS: {
    fontFamily: FontFamily.data,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: -0.2,
  },
  dataXS: {
    fontFamily: FontFamily.data,
    fontSize: 11,
    lineHeight: 14,
  },
  /** Códigos de pedido y de cupón: espaciados para poder dictarlos en voz alta. */
  code: {
    fontFamily: FontFamily.dataBold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 1.6,
  },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof Type;
