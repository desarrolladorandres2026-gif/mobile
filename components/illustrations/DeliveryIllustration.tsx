import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Domiciliario: mini moto de reparto azul con baúl dorado, mismo blob y luz del set. */
export function DeliveryIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="delBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="delBox" x1="16" y1="20" x2="30" y2="32">
          <Stop offset="0" stopColor={palette.mango400} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#delBlob)" />
      <Ellipse cx="32" cy="47" rx="14" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* ruedas */}
      <Circle cx="21" cy="42" r="5.5" stroke={palette.ink700} strokeWidth={2.2} fill="none" />
      <Circle cx="43" cy="42" r="5.5" stroke={palette.ink700} strokeWidth={2.2} fill="none" />

      {/* cuerpo moto */}
      <Path
        d="M21 42 L27 30 H33 L36 36 H43"
        stroke={palette.zipp500}
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M33 30 H38 L36 36" stroke={palette.zipp400} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />

      {/* caja de entrega */}
      <Path d="M15 20 H28 V30 H15 Z" fill="url(#delBox)" />
      <Path d="M15 25 H28" stroke={palette.mango100} strokeWidth={1.2} opacity={0.7} />
    </Svg>
  );
}
