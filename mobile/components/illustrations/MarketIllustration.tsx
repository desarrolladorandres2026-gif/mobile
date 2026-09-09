import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Mercados: mini canasta con víveres de colores, cierra el set de categorías. */
export function MarketIllustration({ size = 48, bleed = false }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="mktBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="mktBasket" x1="16" y1="30" x2="48" y2="46">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      {bleed
        ? <Rect x="0" y="0" width="64" height="64" fill="url(#mktBlob)" />
        : <Circle cx="32" cy="32" r="28" fill="url(#mktBlob)" />}
      <Ellipse cx="32" cy="47" rx="14" ry="3.4" fill={palette.mango700} opacity={0.14} />

      {/* víveres asomando */}
      <Circle cx="26" cy="26" r="4" fill={palette.lima500} />
      <Path d="M26 22 C27.4 21 28.6 21.6 28 23" stroke={palette.lima700} strokeWidth={0.8} fill="none" opacity={0.7} />
      <Circle cx="34" cy="23" r="3.4" fill={palette.cereza500} />
      <Path d="M34 19.6 V21.4" stroke={palette.lima700} strokeWidth={0.9} strokeLinecap="round" />
      <Circle cx="40" cy="27" r="3.6" fill={palette.mango400} />

      {/* asa */}
      <Path
        d="M22 30 C22 22 42 22 42 30"
        stroke={palette.mango700}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />

      {/* canasta */}
      <Path d="M18 30 H46 L43 45 C42.6 46.7 41 48 39.2 48 H24.8 C23 48 21.4 46.7 21 45 Z" fill="url(#mktBasket)" />
      <Path d="M22 34 H42 M23 39 H41" stroke={palette.mango100} strokeWidth={1.3} opacity={0.7} />
    </Svg>
  );
}
