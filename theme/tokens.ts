/**
 * ZIPP — Sistema de diseño "El Trazo"
 *
 * Zipp no es un catálogo infinito: es un pueblo que se mueve rápido. En Garzón
 * casi nada queda a más de diez minutos, así que la interfaz se organiza
 * alrededor de la cercanía y los minutos, no del tamaño del catálogo.
 *
 * Paleta "Andén": una noche índigo del Huila (Ink), un azul eléctrico que
 * empuja la acción (Zipp) y un lima que marca todo lo que se gana (Lima).
 *
 * La fuente única de verdad del color en todo el proyecto es
 * /variables de color/colores.css (la consumen admin y business vía
 * @import). Este archivo es TypeScript y no puede importar ese .css
 * directamente, así que los hex de `palette` de abajo deben mantenerse
 * manualmente en sincronía con ese archivo cuando cambie.
 */

// ──────────────────────────────────────────────────────────────
// Paleta cruda. Nadie fuera de este archivo debería usarla directo:
// las pantallas consumen los tokens semánticos de más abajo.
// ──────────────────────────────────────────────────────────────
const palette = {
  // Noche índigo del Huila. No es negro: tiene horizonte.
  ink900: '#080B14',
  ink800: '#0D1120',
  ink700: '#141A2E',
  ink600: '#1C2338',
  ink500: '#252E47',
  ink400: '#323C59',
  ink300: '#46527A',
  ink200: '#6B78A0',

  // Blanco frío, no crema: acompaña al índigo sin ensuciarlo.
  paper0: '#FFFFFF',
  paper50: '#F4F4F8',
  paper100: '#ECECF3',
  paper200: '#DFDFEA',
  paper300: '#C5C5D6',
  paper400: '#8E8EA8',
  paper500: '#5C5C73',

  // Azul eléctrico: el color de "hazlo ya".
  zipp700: '#2A1BC9',
  zipp600: '#3A29E8',
  zipp500: '#4B3BFF',
  zipp400: '#7D72FF',
  zipp300: '#A79FFF',
  zipp100: '#E4E1FF',

  // Lima: el trazo, la recompensa, lo que sale bien.
  lima800: '#3F5106',
  lima700: '#5A7208',
  lima600: '#9DBB25',
  lima500: '#D9F55B',
  lima400: '#E6FA8C',
  lima100: '#F4FDD2',

  // Estados
  cereza700: '#B01829',
  cereza500: '#FF4D5E',
  cereza400: '#FF7A87',
  cereza100: '#FFE3E6',

  mango700: '#8A5A00',
  mango500: '#FFB020',
  mango400: '#FFC85C',
  mango100: '#FFF0D1',
} as const;

// ──────────────────────────────────────────────────────────────
// Escalas
// ──────────────────────────────────────────────────────────────

/** Ritmo de 4pt. Todo el espaciado sale de aquí. */
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/**
 * Escala tipográfica. Los saltos son amplios a propósito: en una pantalla de
 * teléfono, dos tamaños casi iguales solo generan ruido.
 */
export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
  xxxl: 32,
  title: 40,
} as const;

/** Curvas suaves y generosas: la app se siente blanda al tacto, no rígida. */
export const BorderRadius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 30,
  full: 999,
} as const;

/**
 * Duraciones de animación. Todo por debajo de 200ms se percibe como
 * instantáneo; ese es el rango donde vive la sensación de velocidad.
 */
export const Motion = {
  instant: 120,
  fast: 180,
  base: 260,
  slow: 420,
  /** El trazo dibujándose de punta a punta. */
  trace: 900,
} as const;

/** Alturas de elementos táctiles. Mínimo 44 por accesibilidad. */
export const Size = {
  tapMin: 44,
  inputHeight: 56,
  buttonSm: 40,
  buttonMd: 52,
  buttonLg: 60,
  tabBar: 64,
  iconSm: 16,
  iconMd: 20,
  iconLg: 24,
  /** Grosor único de todo icono lucide en la app. */
  iconStroke: 2,
  iconStrokeBold: 2.5,
} as const;

// ──────────────────────────────────────────────────────────────
// Tokens semánticos por tema
// ──────────────────────────────────────────────────────────────

/**
 * Colores de estado del pedido. Se leen de un vistazo y en el mismo orden que
 * avanza el pedido: espera → cocina → calle → entregado.
 */
const orderStatus = {
  statusPending: palette.mango500,
  statusAccepted: palette.zipp400,
  statusPreparing: palette.mango500,
  statusReady: palette.zipp400,
  statusOnWay: palette.zipp500,
  statusDelivered: palette.lima600,
  statusCancelled: palette.cereza500,
} as const;

const shared = {
  white: palette.paper0,
  black: palette.ink900,
  transparent: 'transparent',

  /** Azul eléctrico. Siempre lleva texto blanco encima. */
  primary: palette.zipp500,
  primaryLight: palette.zipp400,
  primaryDark: palette.zipp700,

  /** Lima. Nunca es color de texto sobre fondo claro: es superficie. */
  lime: palette.lima500,
  limeDeep: palette.lima700,

  secondary: palette.ink700,
  accent: palette.lima500,

  ...orderStatus,
} as const;

export const DarkColors = {
  ...shared,

  background: palette.ink700,
  backgroundDeep: palette.ink800,
  surface: palette.ink600,
  surfaceLight: palette.ink500,
  surfaceRaised: palette.ink500,
  card: palette.ink600,

  text: palette.paper0,
  textSecondary: '#B9C0D8',
  textMuted: palette.ink200,
  /** Texto sobre relleno primario sólido. */
  textOnPrimary: palette.paper0,
  /** Texto sobre relleno lima sólido. */
  textOnLime: palette.ink800,

  border: palette.ink500,
  borderLight: palette.ink400,
  borderStrong: palette.ink300,

  /** El azul puro no alcanza contraste como texto sobre índigo: se aclara. */
  primaryText: palette.zipp400,
  primarySoft: 'rgba(75, 59, 255, 0.18)',
  primarySoftBorder: 'rgba(125, 114, 255, 0.32)',

  limeText: palette.lima500,
  limeSoft: 'rgba(217, 245, 91, 0.14)',
  limeSoftBorder: 'rgba(217, 245, 91, 0.28)',

  success: palette.lima500,
  successText: palette.lima500,
  successLight: palette.lima400,
  successSoft: 'rgba(217, 245, 91, 0.14)',

  warning: palette.mango500,
  warningText: palette.mango400,
  warningLight: palette.mango400,
  warningSoft: 'rgba(255, 176, 32, 0.14)',

  error: palette.cereza500,
  errorText: palette.cereza400,
  errorLight: palette.cereza400,
  errorSoft: 'rgba(255, 77, 94, 0.14)',

  overlay: 'rgba(8, 11, 20, 0.72)',
  skeleton: palette.ink500,
  skeletonHighlight: palette.ink400,
} as const;

/**
 * El tema oscuro define el contrato. Los valores se ensanchan a `string`
 * porque si no, TypeScript trataría cada hex como su propio tipo literal y el
 * tema claro nunca sería asignable al oscuro.
 *
 * El beneficio real: anotar `LightColors` con este tipo hace que olvidar una
 * clave en el tema claro sea un error de compilación, no un `undefined` que
 * aparece como color transparente en producción.
 */
export type ColorScheme = { readonly [K in keyof typeof DarkColors]: string };

export const LightColors: ColorScheme = {
  ...shared,

  background: palette.paper50,
  backgroundDeep: palette.paper100,
  surface: palette.paper0,
  surfaceLight: palette.paper100,
  surfaceRaised: palette.paper0,
  card: palette.paper0,

  text: palette.ink700,
  textSecondary: palette.paper500,
  textMuted: palette.paper400,
  textOnPrimary: palette.paper0,
  textOnLime: palette.ink800,

  border: palette.paper200,
  borderLight: palette.paper100,
  borderStrong: palette.paper300,

  primaryText: palette.zipp600,
  primarySoft: 'rgba(75, 59, 255, 0.08)',
  primarySoftBorder: 'rgba(75, 59, 255, 0.20)',

  /** Sobre papel, el lima se oscurece hasta ser legible. */
  limeText: palette.lima700,
  limeSoft: 'rgba(157, 187, 37, 0.14)',
  limeSoftBorder: 'rgba(157, 187, 37, 0.32)',

  success: palette.lima600,
  successText: palette.lima700,
  successLight: palette.lima500,
  successSoft: 'rgba(157, 187, 37, 0.14)',

  warning: palette.mango500,
  warningText: palette.mango700,
  warningLight: palette.mango400,
  warningSoft: 'rgba(255, 176, 32, 0.16)',

  error: palette.cereza500,
  errorText: palette.cereza700,
  errorLight: palette.cereza400,
  errorSoft: 'rgba(255, 77, 94, 0.10)',

  overlay: 'rgba(20, 26, 46, 0.55)',
  skeleton: palette.paper100,
  skeletonHighlight: palette.paper200,
};

/** Alias histórico. Código antiguo que asumía tema oscuro sigue funcionando. */
export const Colors = DarkColors;

// ──────────────────────────────────────────────────────────────
// Elevación
// ──────────────────────────────────────────────────────────────

/**
 * En modo oscuro una sombra negra es invisible, así que la elevación se
 * comunica con el color de la superficie y una sombra muy difusa. En claro
 * la sombra sí hace el trabajo.
 */
export const Shadow = {
  none: {},
  sm: {
    shadowColor: '#080B14',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: '#080B14',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 6,
  },
  lg: {
    shadowColor: '#080B14',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.2,
    shadowRadius: 32,
    elevation: 14,
  },
  /** Halo de color bajo los botones primarios: el "empuje" de la marca. */
  primaryGlow: {
    shadowColor: palette.zipp500,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  limeGlow: {
    shadowColor: palette.lima500,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 10,
  },
} as const;

export { palette };
