import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Date un gusto: mini corona dorada con joyas, mismo blob y luz del set. */
export function CrownIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="crownBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="crownGold" x1="16" y1="24" x2="48" y2="44">
          <Stop offset="0" stopColor={palette.zipp300} />
          <Stop offset="1" stopColor={palette.zipp600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#crownBlob)" />
      <Ellipse cx="32" cy="47" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* base */}
      <Path d="M18 42 H46 V46 C46 47.1 45.1 48 44 48 H20 C18.9 48 18 47.1 18 46 Z" fill="url(#crownGold)" />

      {/* corona */}
      <Path
        d="M18 42 L16 26 L25 33 L32 20 L39 33 L48 26 L46 42 Z"
        fill="url(#crownGold)"
        stroke={palette.zipp700}
        strokeWidth={1}
      />

      {/* joyas */}
      <Circle cx="32" cy="24" r="2.4" fill={palette.cereza500} />
      <Circle cx="24" cy="30" r="1.8" fill={palette.paper0} />
      <Circle cx="40" cy="30" r="1.8" fill={palette.paper0} />

      {/* brillo */}
      <Path d="M22 38 H42" stroke={palette.zipp100} strokeWidth={1} opacity={0.6} />
    </Svg>
  );
}
