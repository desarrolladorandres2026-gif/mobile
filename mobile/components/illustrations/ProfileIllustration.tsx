import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Perfil: mini avatar con collar dorado, mismo blob y luz del set. */
export function ProfileIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="profileBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="profileBody" x1="18" y1="34" x2="46" y2="48">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#profileBlob)" />
      <Ellipse cx="32" cy="48" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* hombros */}
      <Path d="M16 47 C16 38.5 23 33 32 33 C41 33 48 38.5 48 47 Z" fill="url(#profileBody)" />
      {/* collar dorado */}
      <Path d="M24 36 C26.5 38.5 29 39.6 32 39.6 C35 39.6 37.5 38.5 40 36" stroke={palette.zipp400} strokeWidth={1.6} fill="none" opacity={0.9} />
      {/* cabeza */}
      <Circle cx="32" cy="23" r="9.5" fill={palette.mango500} />
    </Svg>
  );
}
