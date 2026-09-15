import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** En tendencia: mini gráfico de barras ascendente con flecha, mismo blob y luz del set. */
export function TrendingIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="trendBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="trendBars" x1="18" y1="20" x2="46" y2="46">
          <Stop offset="0" stopColor={palette.emerald400} />
          <Stop offset="1" stopColor={palette.emerald600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#trendBlob)" />
      <Ellipse cx="32" cy="48" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* barras */}
      <Rect x="19" y="35" width="6" height="11" rx="1.5" fill="url(#trendBars)" opacity={0.55} />
      <Rect x="29" y="28" width="6" height="18" rx="1.5" fill="url(#trendBars)" opacity={0.75} />
      <Rect x="39" y="19" width="6" height="27" rx="1.5" fill="url(#trendBars)" />

      {/* flecha ascendente */}
      <Path
        d="M20 30 L30 21 L36 26 L45 15"
        stroke={palette.mango500}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M39 15 H45 V21" stroke={palette.mango500} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
