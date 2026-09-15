import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Turno del domiciliario: mini rayo dorado en anillo de encendido, mismo blob y luz del set. */
export function ShiftIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="shiftBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="shiftBolt" x1="24" y1="16" x2="40" y2="48">
          <Stop offset="0" stopColor={palette.zipp300} />
          <Stop offset="1" stopColor={palette.zipp600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#shiftBlob)" />
      <Ellipse cx="32" cy="47" rx="12" ry="2.8" fill={palette.mango700} opacity={0.14} />

      {/* anillo de encendido */}
      <Circle cx="32" cy="32" r="17" stroke={palette.mango700} strokeWidth={2.4} opacity={0.35} fill="none" />

      {/* rayo */}
      <Path d="M35 16 L21 36 H30 L28 48 L44 27 H34 Z" fill="url(#shiftBolt)" />
    </Svg>
  );
}
