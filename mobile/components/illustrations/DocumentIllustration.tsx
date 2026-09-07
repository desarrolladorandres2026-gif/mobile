import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Documento legal: mini hoja doblada con cinta separadora azul, mismo blob y luz del set. */
export function DocumentIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="docBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="docSheet" x1="18" y1="14" x2="46" y2="48">
          <Stop offset="0" stopColor={palette.paper0} />
          <Stop offset="1" stopColor={palette.mango100} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#docBlob)" />
      <Ellipse cx="32" cy="48" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* hoja con esquina doblada */}
      <Path
        d="M20 14 H38 L46 22 V46 C46 47.1 45.1 48 44 48 H20 C18.9 48 18 47.1 18 46 V16 C18 14.9 18.9 14 20 14 Z"
        fill="url(#docSheet)"
        stroke={palette.mango500}
        strokeWidth={1.2}
      />
      <Path d="M38 14 V20 C38 21.1 38.9 22 40 22 H46" fill="none" stroke={palette.mango500} strokeWidth={1.2} />

      {/* líneas de texto */}
      <Path d="M23 27 H41" stroke={palette.ink300} strokeWidth={1.4} strokeLinecap="round" opacity={0.55} />
      <Path d="M23 32 H41" stroke={palette.ink300} strokeWidth={1.4} strokeLinecap="round" opacity={0.55} />
      <Path d="M23 37 H35" stroke={palette.ink300} strokeWidth={1.4} strokeLinecap="round" opacity={0.55} />

      {/* cinta separadora */}
      <Path d="M28 40 V52 L32 49.5 L36 52 V40 Z" fill={palette.zipp500} />
      <Path d="M28 40 V44 L32 42 L36 44 V40 Z" fill={palette.zipp400} />
    </Svg>
  );
}
