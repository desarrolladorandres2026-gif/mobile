import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Ubicación / direcciones: mini pin de mapa rojo, mismo blob y luz del set. */
export function LocationIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="locBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="locPin" x1="18" y1="14" x2="46" y2="42">
          <Stop offset="0" stopColor={palette.cereza400} />
          <Stop offset="1" stopColor={palette.cereza500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#locBlob)" />
      <Ellipse cx="32" cy="47" rx="9" ry="2.6" fill={palette.mango700} opacity={0.16} />

      <Path
        d="M32 14 C24.3 14 18 20.2 18 27.8 C18 37.8 32 46 32 46 C32 46 46 37.8 46 27.8 C46 20.2 39.7 14 32 14 Z"
        fill="url(#locPin)"
      />
      <Path d="M22 20 C23.5 18 26 16.8 28.5 16.6" stroke={palette.cereza100} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.7} />
      <Circle cx="32" cy="27.5" r="6" fill={palette.mango400} />
    </Svg>
  );
}
