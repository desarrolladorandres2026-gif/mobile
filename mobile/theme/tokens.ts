/**
 * ZIPP — Sistema de diseño "Obsidian & Gold Titanium"
 *
 * Zipp no es un catálogo genérico: es una experiencia de movilidad y entregas
 * de alta gama, rápida, segura y distinguida.
 *
 * Paleta de marca:
 * - Modo Oscuro: Noche Obsidiana (#080B11), Titanio ahumado (#141B2A) y Oro Champagne satinado (#E5B242).
 * - Modo Claro: Platino perla (#F6F8FA), Blanco puro (#FFFFFF) y Oro Real (#D69E26 / #B88214) con contraste AAA.
 * - Seguridad y Domicilios: Verde Esmeralda (#10B981) para entregas seguras y Ámbar (#F59E0B) para preparación.
 *
 * La fuente única de verdad del color en todo el proyecto es
 * /variables de color/colores.css (la consumen admin, business y web vía @import).
 * Este archivo es TypeScript y mantiene los valores sincronizados para React Native.
 */

// ──────────────────────────────────────────────────────────────
// Paleta cruda. Las pantallas consumen los tokens semánticos abajo.
// ──────────────────────────────────────────────────────────────
const palette = {
  // Obsidiana & Titanio (Dark base). Profundo, cinematográfico, de alta gama.
  ink900: '#080B11',
  ink800: '#0E131E',
  ink700: '#141B2A',
  ink600: '#1B2437',
  ink500: '#232E46',
  ink400: '#2E3D5C',
  ink300: '#465A84',
  ink200: '#7184A8',
  ink100: '#A4B3CD',

  // Platino & Perla (Light base). Limpio, sólido, editorial y premium.
  paper0: '#FFFFFF',
  paper50: '#F6F8FA',
  paper100: '#EDF1F5',
  paper200: '#E1E6ED',
  paper300: '#CBD5E1',
  paper400: '#7C8BA1',
  paper500: '#475569',
  paper600: '#0B0F19',

  // Oro Champagne Zipp (El alma de la nueva identidad visual).
  // Diseñado para irradiar valor, solidez y velocidad sin ser opaco ni chillón.
  gold700: '#8A5D08',
  gold600: '#B88214',
  gold500: '#D69E26',
  gold400: '#E5B242',
  gold300: '#F3CE72',
  gold200: '#FCE7B2',
  gold100: '#FDF7E7',

  // Titanio & Cromo (Inspirado en el casco metálico y detalles de la equipación)
  chrome700: '#475569',
  chrome500: '#94A3B8',
  chrome300: '#CBD5E1',
  chrome100: '#F1F5F9',
  chrome50: '#F8FAFC',

  // Estados de Entrega y Seguridad
  emerald700: '#047857',
  emerald600: '#059669',
  emerald500: '#10B981',
  emerald400: '#34D399',
  emerald100: '#D1FAE5',

  coral700: '#B91C1C',
  coral600: '#DC2626',
  coral500: '#EF4444',
  coral400: '#F87171',
  coral100: '#FEE2E2',

  amber700: '#B45309',
  amber600: '#D97706',
  amber500: '#F59E0B',
  amber400: '#FBBF24',
  amber100: '#FEF3C7',

  // Mapeos de compatibilidad retroactiva
  zipp700: '#8A5D08',
  zipp600: '#B88214',
  zipp500: '#D69E26',
  zipp400: '#E5B242',
  zipp300: '#F3CE72',
  zipp100: '#FDF7E7',

  lima800: '#8A5D08',
  lima700: '#B88214',
  lima600: '#D69E26',
  lima500: '#E5B242',
  lima400: '#F3CE72',
  lima100: '#FDF7E7',

  cereza700: '#B91C1C',
  cereza500: '#EF4444',
  cereza400: '#F87171',
  cereza100: '#FEE2E2',

  mango700: '#B45309',
  mango500: '#F59E0B',
  mango400: '#FBBF24',
  mango100: '#FEF3C7',
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
 * Colores de estado del pedido. Claridad instantánea en cada fase:
 * espera → cocina → calle → entregado.
 */
const orderStatus = {
  statusPending: palette.amber500,
  statusAccepted: palette.gold400,
  statusPreparing: palette.amber500,
  statusReady: palette.gold400,
  statusOnWay: palette.gold500,
  statusDelivered: palette.emerald500,
  statusCancelled: palette.coral500,
} as const;

const shared = {
  white: palette.paper0,
  black: palette.ink900,
  transparent: 'transparent',

  /** Oro Champagne de alta gama. */
  primary: palette.gold400,
  primaryLight: palette.gold300,
  primaryDark: palette.gold600,

  gold: palette.gold400,
  goldLight: palette.gold300,
  goldDark: palette.gold600,

  lime: palette.gold400,
  limeDeep: palette.gold600,

  secondary: palette.ink700,
  accent: palette.gold400,

  ...orderStatus,
} as const;

export const DarkColors = {
  ...shared,

  background: palette.ink900,
  backgroundDeep: '#05070B',
  surface: palette.ink700,
  surfaceLight: palette.ink600,
  surfaceRaised: palette.ink600,
  card: palette.ink700,

  text: palette.paper0,
  textSecondary: palette.ink100,
  textMuted: palette.ink200,
  /** Texto sobre botón dorado sólido: obsidiana puro con máximo impacto y legibilidad */
  textOnPrimary: palette.ink900,
  textOnLime: palette.ink900,

  border: palette.ink500,
  borderLight: palette.ink600,
  borderStrong: palette.ink400,

  primaryText: palette.gold400,
  primarySoft: 'rgba(229, 178, 66, 0.14)',
  primarySoftBorder: 'rgba(229, 178, 66, 0.32)',

  limeText: palette.gold400,
  limeSoft: 'rgba(229, 178, 66, 0.14)',
  limeSoftBorder: 'rgba(229, 178, 66, 0.32)',

  success: palette.emerald500,
  successText: palette.emerald400,
  successLight: palette.emerald400,
  successSoft: 'rgba(16, 185, 129, 0.16)',
  successSoftBorder: 'rgba(16, 185, 129, 0.34)',

  warning: palette.amber500,
  warningText: palette.amber400,
  warningLight: palette.amber400,
  warningSoft: 'rgba(245, 158, 11, 0.16)',

  error: palette.coral500,
  errorText: palette.coral400,
  errorLight: palette.coral400,
  errorSoft: 'rgba(239, 68, 68, 0.16)',

  overlay: 'rgba(8, 11, 17, 0.78)',
  skeleton: palette.ink600,
  skeletonHighlight: palette.ink500,
} as const;

export type ColorScheme = { readonly [K in keyof typeof DarkColors]: string };

export const LightColors: ColorScheme = {
  ...shared,

  background: palette.paper50,
  backgroundDeep: palette.paper100,
  surface: palette.paper0,
  surfaceLight: palette.paper100,
  surfaceRaised: palette.paper0,
  card: palette.paper0,

  text: palette.paper600,
  textSecondary: palette.paper500,
  textMuted: palette.paper600,
  textOnPrimary: palette.ink900,
  textOnLime: palette.ink900,

  border: palette.paper200,
  borderLight: palette.paper100,
  borderStrong: palette.paper300,

  primaryText: palette.gold600,
  primarySoft: 'rgba(214, 158, 38, 0.12)',
  primarySoftBorder: 'rgba(214, 158, 38, 0.28)',

  limeText: palette.gold600,
  limeSoft: 'rgba(214, 158, 38, 0.12)',
  limeSoftBorder: 'rgba(214, 158, 38, 0.28)',

  success: palette.emerald600,
  successText: palette.emerald700,
  successLight: palette.emerald500,
  successSoft: 'rgba(5, 150, 105, 0.12)',
  successSoftBorder: 'rgba(5, 150, 105, 0.28)',

  warning: palette.amber600,
  warningText: palette.amber700,
  warningLight: palette.amber500,
  warningSoft: 'rgba(217, 119, 6, 0.14)',

  error: palette.coral600,
  errorText: palette.coral700,
  errorLight: palette.coral400,
  errorSoft: 'rgba(220, 38, 38, 0.12)',

  overlay: 'rgba(8, 11, 17, 0.55)',
  skeleton: palette.paper100,
  skeletonHighlight: palette.paper200,
};

/** Alias histórico. */
export const Colors = DarkColors;

// ──────────────────────────────────────────────────────────────
// Elevación & Halos
// ──────────────────────────────────────────────────────────────

export const Shadow = {
  none: {},
  sm: {
    shadowColor: '#080B11',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: '#080B11',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 6,
  },
  lg: {
    shadowColor: '#080B11',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.18,
    shadowRadius: 32,
    elevation: 14,
  },
  /** Halo dorado bajo los botones primarios: el aura champagne premium de la marca */
  primaryGlow: {
    shadowColor: palette.gold400,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.42,
    shadowRadius: 20,
    elevation: 10,
  },
  limeGlow: {
    shadowColor: palette.gold400,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.42,
    shadowRadius: 20,
    elevation: 10,
  },
  goldGlow: {
    shadowColor: palette.gold400,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 12,
  },
} as const;

export { palette };
