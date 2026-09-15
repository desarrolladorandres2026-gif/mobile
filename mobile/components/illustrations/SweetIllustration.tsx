import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Algo dulce: mini barquillo de helado con cereza, mismo blob y luz del set. */
export function SweetIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="sweetBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="sweetScoop" x1="18" y1="18" x2="46" y2="34">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.mango100} />
        </LinearGradient>
        <LinearGradient id="sweetCone" x1="22" y1="30" x2="42" y2="48">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#sweetBlob)" />
      <Ellipse cx="32" cy="48" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* barquillo */}
      <Path d="M24 30 H40 L33.5 47 C33 48.3 31 48.3 30.5 47 Z" fill="url(#sweetCone)" />
      <Path d="M26 34 L38 34 M25.3 38 L37 38 M24.6 42 L36 42" stroke={palette.mango100} strokeWidth={1} opacity={0.5} />

      {/* bola de helado */}
      <Path
        d="M21 29 C21 22.4 25.9 17.5 32 17.5 C38.1 17.5 43 22.4 43 29 C43 30 24 30 21 29 Z"
        fill="url(#sweetScoop)"
      />
      <Path d="M25 24 C27 21.5 30 20.3 32.5 20.6" stroke={palette.paper0} strokeWidth={1.4} strokeLinecap="round" opacity={0.75} />

      {/* cereza */}
      <Circle cx="33" cy="17" r="3" fill={palette.cereza500} />
      <Path d="M33 14 C33.5 11.5 35.5 10.5 37 11" stroke={palette.lima600} strokeWidth={1.4} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
