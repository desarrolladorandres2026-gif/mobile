import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Puntos / logros Zipp: mini trofeo dorado con base de color, mismo blob y luz del set. */
export function TrophyIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="trophyBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="trophyCup" x1="20" y1="18" x2="44" y2="40">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
        <LinearGradient id="trophyBase" x1="24" y1="44" x2="40" y2="47.4">
          <Stop offset="0" stopColor={palette.lima500} />
          <Stop offset="1" stopColor={palette.lima600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#trophyBlob)" />
      <Ellipse cx="32" cy="47" rx="12" ry="3.2" fill={palette.mango700} opacity={0.14} />

      {/* asas */}
      <Path
        d="M22 22 C15 22 15 32 23 33"
        stroke={palette.mango500}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
      <Path
        d="M42 22 C49 22 49 32 41 33"
        stroke={palette.mango500}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />

      {/* copa */}
      <Path d="M23 20 H41 L39.5 33 C38.8 37.5 34.8 40 32 40 C29.2 40 25.2 37.5 24.5 33 Z" fill="url(#trophyCup)" />
      {/* pie */}
      <Path d="M29 40 H35 L36 44 H28 Z" fill={palette.mango700} />
      <Path d="M24 44 H40 L39 47.4 H25 Z" fill="url(#trophyBase)" />

      {/* destello */}
      <Path
        d="M46 16 L47.2 19 L50 20 L47.2 21 L46 24 L44.8 21 L42 20 L44.8 19 Z"
        fill={palette.mango400}
        opacity={0.9}
      />
    </Svg>
  );
}
