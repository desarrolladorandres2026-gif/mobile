import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Invitar amigos / regalo: mini caja de regalo roja con lazo verde, mismo blob y luz del set. */
export function GiftIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="giftBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="giftBox" x1="16" y1="26" x2="48" y2="46">
          <Stop offset="0" stopColor={palette.cereza400} />
          <Stop offset="1" stopColor={palette.cereza500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#giftBlob)" />
      <Ellipse cx="32" cy="47" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      <Rect x="16" y="26" width="32" height="7" rx="1.5" fill={palette.cereza500} />
      <Path d="M18 33 H46 V45 C46 46.1 45.1 47 44 47 H20 C18.9 47 18 46.1 18 45 Z" fill="url(#giftBox)" />
      <Rect x="30" y="26" width="4" height="21" fill={palette.lima500} />

      {/* moño */}
      <Path
        d="M32 26 C29 22 24 22 23 25.5 C22.3 28 25 26.5 32 26 Z"
        fill={palette.lima600}
      />
      <Path
        d="M32 26 C35 22 40 22 41 25.5 C41.7 28 39 26.5 32 26 Z"
        fill={palette.lima600}
      />

      {/* brillo */}
      <Path
        d="M32 15.5 L33 18.2 L35.8 18.8 L33.6 20.6 L34.2 23.4 L32 21.8 L29.8 23.4 L30.4 20.6 L28.2 18.8 L31 18.2 Z"
        fill={palette.mango400}
        opacity={0.9}
      />
    </Svg>
  );
}
