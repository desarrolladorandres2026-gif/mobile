import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Droguerías: mini frasco con cruz médica y etiqueta, blob dorado a juego con el set. */
export function PharmacyIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="phBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="phJar" x1="20" y1="22" x2="44" y2="46">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.paper100} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#phBlob)" />
      <Ellipse cx="32" cy="46" rx="12" ry="3.4" fill={palette.mango700} opacity={0.14} />

      {/* tapa */}
      <Rect x="27" y="14" width="10" height="5" rx="1.5" fill={palette.zipp600} />
      <Rect x="29" y="19" width="6" height="3" fill={palette.zipp400} />

      {/* frasco */}
      <Path
        d="M23 22 H41 C42 22 43 23 43 24 V42 C43 44.5 41 46 38.5 46 H25.5 C23 46 21 44.5 21 42 V24 C21 23 22 22 23 22 Z"
        fill="url(#phJar)"
        stroke={palette.paper300}
        strokeWidth={1.4}
      />

      {/* etiqueta */}
      <Rect x="21.8" y="37" width="20.4" height="5.5" fill={palette.mango400} />
      <Rect x="21.8" y="37" width="20.4" height="1.4" fill={palette.mango100} opacity={0.85} />

      {/* cruz */}
      <Path
        d="M32 25.5 V34.5 M27.5 30 H36.5"
        stroke={palette.cereza500}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}
