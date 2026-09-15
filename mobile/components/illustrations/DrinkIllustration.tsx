import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Algo para tomar: mini vaso con pitillo y burbujas, mismo blob y luz del set. */
export function DrinkIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="drinkBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="drinkCup" x1="20" y1="20" x2="44" y2="47">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#drinkBlob)" />
      <Ellipse cx="32" cy="48" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* vaso */}
      <Path d="M21 20 H43 L40 45 C39.8 46.7 38.3 48 36.5 48 H27.5 C25.7 48 24.2 46.7 24 45 Z" fill="url(#drinkCup)" />
      <Ellipse cx="32" cy="20" rx="11" ry="2.4" fill={palette.mango100} />

      {/* líneas del vaso */}
      <Path d="M27 26 L28.5 43 M37 26 L35.5 43" stroke={palette.mango100} strokeWidth={1} opacity={0.5} />

      {/* pitillo */}
      <Path d="M35 12 L28 24" stroke={palette.paper0} strokeWidth={2.4} strokeLinecap="round" />
      <Path d="M35 12 L28 24" stroke={palette.cereza400} strokeWidth={2.4} strokeLinecap="round" strokeDasharray="2.4,3" />

      {/* burbujas */}
      <Circle cx="30" cy="32" r="1.6" fill={palette.paper0} opacity={0.7} />
      <Circle cx="35" cy="37" r="1.2" fill={palette.paper0} opacity={0.6} />
    </Svg>
  );
}
