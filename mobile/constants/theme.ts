/**
 * Puente hacia el sistema de diseño.
 *
 * El sistema real vive en `theme/`. Este archivo se conserva porque las
 * pantallas del domiciliario importan desde `constants/`, y todas las claves
 * que usaban siguen existiendo: heredan la identidad nueva sin cambiar una
 * línea. En código nuevo importa desde `theme/`.
 */
export {
  Colors,
  DarkColors,
  LightColors,
  Spacing,
  FontSize,
  BorderRadius,
  Motion,
  Size,
  Shadow,
} from '../theme/tokens';

export type { ColorScheme } from '../theme/tokens';
