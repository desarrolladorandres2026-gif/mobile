import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Pago digital: mini tarjeta azul con chip dorado, mismo blob y luz del set. */
export function PaymentCardIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="cardBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="cardBody" x1="16" y1="20" x2="48" y2="44">
          <Stop offset="0" stopColor={palette.zipp500} />
          <Stop offset="1" stopColor={palette.zipp700} />
        </LinearGradient>
        <LinearGradient id="cardChip" x1="19" y1="35" x2="28" y2="39">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#cardBlob)" />
      <Ellipse cx="32" cy="47" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      <Rect x="15" y="19" width="34" height="24" rx="4" fill="url(#cardBody)" />
      <Rect x="15" y="25" width="34" height="5" fill={palette.ink700} opacity={0.9} />
      <Rect x="19" y="35" width="9" height="4" rx="1.2" fill="url(#cardChip)" />
      <Path d="M35 37 H45" stroke={palette.zipp100} strokeWidth={1.6} strokeLinecap="round" opacity={0.7} />
    </Svg>
  );
}
