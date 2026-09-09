import Svg, { Circle, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Genérica: negocio sin categoría reconocida (tienda con toldo).
 *
 * Cae aquí cualquier `key` que el backend mande y que todavía no tenga
 * ilustración propia — nunca un cuadro vacío ni un icono roto.
 */
export function DefaultIllustration({ size = 48, bleed = false }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="defBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="defStore" x1="18" y1="30" x2="46" y2="46">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.mango100} />
        </LinearGradient>
      </Defs>

      {bleed
        ? <Rect x="0" y="0" width="64" height="64" fill="url(#defBlob)" />
        : <Circle cx="32" cy="32" r="28" fill="url(#defBlob)" />}

      {/* toldo */}
      <Path
        d="M18 28 L22 20 H42 L46 28 Z"
        fill={palette.mango500}
      />
      <Path d="M18 28 L22 34 L26 28 Z" fill={palette.mango700} />
      <Path d="M26 28 L30 34 L34 28 Z" fill={palette.mango400} />
      <Path d="M34 28 L38 34 L42 28 Z" fill={palette.mango700} />
      <Path d="M42 28 L46 34 L46 28 Z" fill={palette.mango400} />

      {/* fachada */}
      <Path d="M20 32 H44 V46 H20 Z" fill="url(#defStore)" stroke={palette.mango500} strokeWidth={1.3} />
      {/* puerta */}
      <Path d="M29 46 V37 C29 35.3 30.3 34 32 34 C33.7 34 35 35.3 35 37 V46 Z" fill={palette.mango700} />
    </Svg>
  );
}
