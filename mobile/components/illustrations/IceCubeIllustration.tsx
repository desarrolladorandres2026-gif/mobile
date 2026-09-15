import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Refresca el día: mini cubo de hielo con brillo, mismo blob y luz del set. */
export function IceCubeIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="iceBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="iceCube" x1="16" y1="16" x2="46" y2="46">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.chrome300} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#iceBlob)" />
      <Ellipse cx="32" cy="48" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* cubo */}
      <Path d="M20 20 H44 L44 44 H20 Z" fill="url(#iceCube)" stroke={palette.chrome500} strokeWidth={1} />
      <Path d="M20 20 L27 26 M44 20 L37 26 M20 44 L27 38 M44 44 L37 38 M27 26 H37 V38 H27 Z" stroke={palette.chrome500} strokeWidth={1} opacity={0.6} fill="none" />

      {/* brillo */}
      <Path d="M24 24 L29 24 L24 29 Z" fill={palette.paper0} opacity={0.9} />

      {/* gotas frías */}
      <Path d="M14 30 C14 27.8 16.5 26 16.5 26 C16.5 26 19 27.8 19 30 C19 31.4 17.9 32.5 16.5 32.5 C15.1 32.5 14 31.4 14 30 Z" fill={palette.chrome300} opacity={0.85} />
    </Svg>
  );
}
