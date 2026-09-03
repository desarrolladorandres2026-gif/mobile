import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Favoritos: mini corazón rojo con brillo, mismo blob y luz del set. */
export function FavoriteIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="favBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="favHeart" x1="18" y1="22" x2="46" y2="44">
          <Stop offset="0" stopColor={palette.cereza400} />
          <Stop offset="1" stopColor={palette.cereza500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#favBlob)" />
      <Ellipse cx="32" cy="46" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      <Path
        d="M32 42 C22 35 17 29.5 17 23.8 C17 19.6 20.3 16.5 24.3 16.5 C27 16.5 29.5 18 32 21 C34.5 18 37 16.5 39.7 16.5 C43.7 16.5 47 19.6 47 23.8 C47 29.5 42 35 32 42 Z"
        fill="url(#favHeart)"
      />
      <Path
        d="M23.5 22 C24.3 20 26.2 19 28 19.4"
        stroke={palette.paper0}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
        opacity={0.85}
      />
    </Svg>
  );
}
