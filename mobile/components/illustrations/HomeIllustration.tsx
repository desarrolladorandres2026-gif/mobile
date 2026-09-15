import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Inicio: mini casita con puerta y ventana dorada, mismo blob y luz del set. */
export function HomeIllustration({ size = 48, bleed = false }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="homeBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="homeWall" x1="18" y1="30" x2="46" y2="47">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      {bleed
        ? <Rect x="0" y="0" width="64" height="64" fill="url(#homeBlob)" />
        : <Circle cx="32" cy="32" r="28" fill="url(#homeBlob)" />}
      <Ellipse cx="32" cy="48" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* techo */}
      <Path d="M17 30 L32 17 L47 30 L43 30 L32 21 L21 30 Z" fill={palette.mango700} />
      {/* pared */}
      <Path d="M20 29 H44 V46 H20 Z" fill="url(#homeWall)" />
      {/* puerta */}
      <Path d="M28 46 V36 C28 34.3 29.3 33 31 33 H33 C34.7 33 36 34.3 36 36 V46 Z" fill={palette.ink700} opacity={0.85} />
      {/* ventana */}
      <Rect x="23" y="36" width="6" height="6" rx="1" fill={palette.zipp400} />
    </Svg>
  );
}
