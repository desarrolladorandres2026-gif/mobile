import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Seguridad: mini candado sobre escudo azul, mismo blob y luz del set. */
export function SecurityIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="secBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="secShield" x1="18" y1="14" x2="46" y2="46">
          <Stop offset="0" stopColor={palette.zipp500} />
          <Stop offset="1" stopColor={palette.zipp600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#secBlob)" />
      <Ellipse cx="32" cy="47" rx="11" ry="3" fill={palette.mango700} opacity={0.14} />

      <Path d="M32 14 L46 19 V29 C46 38 40 44.5 32 47 C24 44.5 18 38 18 29 V19 Z" fill="url(#secShield)" />
      <Rect x="27" y="28" width="10" height="9" rx="2" fill={palette.zipp100} opacity={0.95} />
      <Path d="M29 28 V25 C29 22.8 30.3 21.5 32 21.5 C33.7 21.5 35 22.8 35 25 V28" stroke={palette.zipp100} strokeWidth={1.8} fill="none" />
      <Path d="M29.3 32.3 L31.3 34.3 L34.7 30.5" stroke={palette.lima600} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
