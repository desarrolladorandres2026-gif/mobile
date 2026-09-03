import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Notificaciones: mini campana dorada con aviso rojo, mismo blob y luz del set. */
export function NotificationIllustration({ size = 48 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="notifBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="notifBell" x1="18" y1="16" x2="46" y2="42">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      <Circle cx="32" cy="32" r="28" fill="url(#notifBlob)" />
      <Ellipse cx="32" cy="47" rx="10" ry="2.8" fill={palette.mango700} opacity={0.14} />

      <Path
        d="M32 15 C26.5 15 23 19 23 24.5 V31 C23 34 21.5 35.6 20 37.5 H44 C42.5 35.6 41 34 41 31 V24.5 C41 19 37.5 15 32 15 Z"
        fill="url(#notifBell)"
      />
      <Path d="M27 40.5 C27 43 29.2 45 32 45 C34.8 45 37 43 37 40.5 Z" fill={palette.mango700} />
      <Circle cx="41" cy="18" r="4" fill={palette.cereza500} stroke={palette.paper0} strokeWidth={1.3} />
    </Svg>
  );
}
