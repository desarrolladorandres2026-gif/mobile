import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Restaurantes: mini plato con cubiertos y guarnición de color, sobre un blob dorado suave. */
export function RestaurantIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="restBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="restPlate" x1="16" y1="24" x2="48" y2="48">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.mango100} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#restBlob)" />

      {/* sombra suave bajo el plato */}
      <Ellipse cx="33" cy="40" rx="14" ry="4" fill={palette.mango700} opacity={0.14} />

      {/* plato */}
      <Circle cx="32" cy="36" r="13" fill="url(#restPlate)" stroke={palette.mango500} strokeWidth={1.5} />
      <Circle cx="32" cy="36" r="7" fill="none" stroke={palette.mango500} strokeWidth={1.2} opacity={0.6} />

      {/* tomate */}
      <Circle cx="28.5" cy="34" r="3" fill={palette.cereza500} />
      <Circle cx="27.5" cy="33" r="0.8" fill={palette.cereza100} opacity={0.8} />

      {/* hoja de albahaca */}
      <Path d="M35.5 32.5 C39 31.5 41 33.5 39.8 36.5 C36.5 37 34.3 35.3 35.5 32.5 Z" fill={palette.lima500} />
      <Path d="M35.8 33.3 C37.2 33.8 38.3 34.7 39 35.8" stroke={palette.lima600} strokeWidth={0.5} fill="none" opacity={0.7} />

      {/* tenedor */}
      <Path
        d="M17 16 L17 26 M15 16 L15 22 M19 16 L19 22 M17 22 L17 30"
        stroke={palette.ink700}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      {/* cuchillo */}
      <Path
        d="M47 16 C47 21 45 23 45 26 L45 32"
        stroke={palette.mango700}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}
