import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Ayuda / soporte: mini globo de chat azul con signo de pregunta, mismo blob y luz del set. */
export function HelpIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="helpBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="helpBubble" x1="16" y1="16" x2="48" y2="40">
          <Stop offset="0" stopColor={palette.zipp500} />
          <Stop offset="1" stopColor={palette.zipp600} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#helpBlob)" />
      <Ellipse cx="32" cy="47" rx="11" ry="2.8" fill={palette.mango700} opacity={0.14} />

      <Path
        d="M18 26 C18 20.5 23.6 16 32 16 C40.4 16 46 20.5 46 26 C46 31.5 40.4 36 32 36 C30.4 36 28.9 35.8 27.5 35.5 L20.5 40 L22 33.5 C19.5 31.5 18 29 18 26 Z"
        fill="url(#helpBubble)"
      />
      <Path
        d="M29 23.5 C29 21.6 30.3 20.3 32.2 20.3 C34 20.3 35.3 21.5 35.3 23.1 C35.3 26 32 25.6 32 29"
        stroke={palette.mango400}
        strokeWidth={1.8}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx="32" cy="32.4" r="1.4" fill={palette.mango400} />
    </Svg>
  );
}
