import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Explorar: mini brújula con aguja dorada, mismo blob y luz del set. */
export function ExploreIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="exploreBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="exploreRing" x1="16" y1="16" x2="48" y2="48">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#exploreBlob)" />
      <Ellipse cx="32" cy="47" rx="12" ry="2.8" fill={palette.mango700} opacity={0.14} />

      <Circle cx="32" cy="32" r="16" fill="url(#exploreRing)" />
      <Circle cx="32" cy="32" r="12" fill={palette.paper0} opacity={0.9} />

      {/* aguja */}
      <Path d="M32 22 L36 32 L32 42 L28 32 Z" fill={palette.zipp500} />
      <Path d="M32 22 L36 32 L32 32 Z" fill={palette.zipp300} />
      <Circle cx="32" cy="32" r="2.2" fill={palette.ink700} />
    </Svg>
  );
}
