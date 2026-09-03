import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Calificación: mini estrella dorada con destello y estrella secundaria, mismo blob y luz del set. */
export function RatingIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="ratingBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="ratingStar" x1="16" y1="14" x2="48" y2="46">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#ratingBlob)" />
      <Ellipse cx="32" cy="47" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* estrella secundaria */}
      <Path
        d="M44 36 L45.2 38.8 L48.2 39.2 L46 41.3 L46.6 44.2 L44 42.7 L41.4 44.2 L42 41.3 L39.8 39.2 L42.8 38.8 Z"
        fill={palette.zipp300}
        opacity={0.85}
      />

      <Path
        d="M32 15 L36.6 25 L47.5 26.5 L39.7 34 L41.6 45 L32 39.8 L22.4 45 L24.3 34 L16.5 26.5 L27.4 25 Z"
        fill="url(#ratingStar)"
      />
      <Path d="M25 22 L28.5 20.5" stroke={palette.mango100} strokeWidth={1.4} strokeLinecap="round" opacity={0.75} />
    </Svg>
  );
}
