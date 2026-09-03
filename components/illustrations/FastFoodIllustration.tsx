import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Comidas rápidas: mini hamburguesa con capas de color, mismo blob dorado que el resto del set. */
export function FastFoodIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="ffBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="ffBun" x1="16" y1="18" x2="48" y2="30">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#ffBlob)" />
      <Ellipse cx="32" cy="44" rx="15" ry="4" fill={palette.mango700} opacity={0.14} />

      {/* pan superior */}
      <Path d="M17 27 C17 19 47 19 47 27 Z" fill="url(#ffBun)" />
      {/* ajonjolí */}
      <Circle cx="25" cy="22" r="1.1" fill={palette.paper0} />
      <Circle cx="32" cy="20" r="1.1" fill={palette.paper0} />
      <Circle cx="39" cy="22" r="1.1" fill={palette.paper0} />

      {/* lechuga */}
      <Path
        d="M16 29 C19 27 21 30 24 28 C27 30.5 29 27.5 32 29.5 C35 27.5 37 30.5 40 28 C43 30 45 27 48 29 L47 31.5 L17 31.5 Z"
        fill={palette.lima500}
      />
      <Path d="M20 29.5 C24 28.5 28 30 32 29" stroke={palette.lima600} strokeWidth={0.6} fill="none" opacity={0.7} />

      {/* tomate */}
      <Path d="M16.5 31.5 L47.5 31.5 L46.5 34.5 L17.5 34.5 Z" fill={palette.cereza500} />
      <Circle cx="24" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />
      <Circle cx="32" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />
      <Circle cx="40" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />

      {/* carne */}
      <Path d="M16 34.5 L48 34.5 L47 38.5 L17 38.5 Z" fill={palette.mango700} />
      {/* pan inferior */}
      <Path d="M17 38.5 L47 38.5 C47 43 17 43 17 38.5 Z" fill={palette.mango500} />
    </Svg>
  );
}
