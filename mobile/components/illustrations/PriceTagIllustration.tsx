import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Precio bajo: mini etiqueta con signo de pesos, mismo blob y luz del set. */
export function PriceTagIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="tagBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="tagBody" x1="16" y1="16" x2="46" y2="42">
          <Stop offset="0" stopColor={palette.lima400} />
          <Stop offset="1" stopColor={palette.lima600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#tagBlob)" />
      <Ellipse cx="32" cy="47" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* etiqueta */}
      <Path
        d="M19 21 C19 19.3 20.3 18 22 18 H34 L47 31 C48.2 32.2 48.2 34.1 47 35.3 L36.3 46 C35.1 47.2 33.2 47.2 32 46 L19 33 Z"
        fill="url(#tagBody)"
        stroke={palette.lima700}
        strokeWidth={1}
      />
      <Circle cx="27" cy="26" r="3" fill={palette.paper0} />

      {/* signo de pesos */}
      <Path
        d="M36 26 H30.5 M36 30 H29.5 M32.5 22.5 V33.5"
        stroke={palette.paper0}
        strokeWidth={1.8}
        strokeLinecap="round"
        opacity={0.9}
      />
    </Svg>
  );
}
