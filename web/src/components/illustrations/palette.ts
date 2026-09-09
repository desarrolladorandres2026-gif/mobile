/**
 * Paleta de las mini-ilustraciones de la landing.
 *
 * La landing es dorado sobre obsidiana, tipografía mono, sin más color que el
 * ámbar de marca. La paleta "Andén" multicolor (azul eléctrico, lima) chocaría
 * ahí, así que este set colapsa los ramales `zipp*` y `lima*` sobre el dorado
 * de marca y deja solo el `cereza` (rojo) como acento puntual. Mismo criterio
 * que `admin/src/components/illustrations/palette.ts`. Estructura (`ink*`,
 * `paper*`) sin cambios.
 *
 * TODO(diseño): afinar estos valores. Ahora mismo es una traducción directa a
 * dorado; quizá una o dos ilustraciones ganen con un toque de `cereza` o un
 * ámbar más cálido en los degradados. Son ~10 líneas de hex.
 */
export const palette = {
  ink900: '#080B14',
  ink800: '#0D1120',
  ink700: '#141A2E',
  ink600: '#1C2338',
  ink500: '#252E47',
  ink400: '#323C59',
  ink300: '#46527A',
  ink200: '#6B78A0',

  paper0: '#FFFFFF',
  paper50: '#F4F4F8',
  paper100: '#ECECF3',
  paper200: '#DFDFEA',
  paper300: '#C5C5D6',
  paper400: '#8E8EA8',
  paper500: '#5C5C73',

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

  cereza700: '#B01829',
  cereza500: '#FF4D5E',
  cereza400: '#FF7A87',
  cereza100: '#FFE3E6',

  mango700: '#B45309',
  mango500: '#F59E0B',
  mango400: '#FBBF24',
  mango100: '#FEF3C7',
} as const;
