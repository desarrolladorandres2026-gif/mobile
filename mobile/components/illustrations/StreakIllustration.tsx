import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Racha semanal: mini llama de fuego real, mismo blob y luz del set. */
export function StreakIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="streakBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="streakFlame" x1="32" y1="44" x2="32" y2="15">
          <Stop offset="0" stopColor={palette.cereza500} />
          <Stop offset="1" stopColor={palette.mango500} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#streakBlob)" />
      <Ellipse cx="32" cy="47" rx="11" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* brasa */}
      <Ellipse cx="32" cy="43.5" rx="7" ry="2.6" fill={palette.cereza700} opacity={0.5} />

      {/* llama exterior */}
      <Path
        d="M32 15 C38 22 40 27 38 33 C41 31 42 27 41 24 C46 30 45 40 38 44.5 C41 40 40 36 37 34 C36.5 39 32.5 41 28.5 39 C31 37.5 31.5 34.5 30 32 C27 35 25 38 27 42 C21 39.5 19.5 32 24 26 C24 30 25.5 31.5 27.5 32 C25.5 26 27 19.5 32 15 Z"
        fill="url(#streakFlame)"
      />
      {/* núcleo */}
      <Path
        d="M31.5 27 C34 30.5 34.5 33.5 32.5 37 C31 34.5 29.5 34 28.5 35.5 C27.5 32.5 28.5 29 31.5 27 Z"
        fill={palette.mango400}
        opacity={0.9}
      />
    </Svg>
  );
}
