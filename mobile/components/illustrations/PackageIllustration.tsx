import Svg, { Circle, Ellipse, Rect, Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/** Paquete / pedido: mini caja de cartón con cinta azul y etiqueta, mismo blob y luz del set. */
export function PackageIllustration({ size = 48, bleed = false }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <LinearGradient id="pkgBlob" x1="0" y1="0" x2="64" y2="64">
          <Stop offset="0" stopColor={palette.mango100} />
          <Stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </LinearGradient>
        <LinearGradient id="pkgFront" x1="18" y1="28" x2="46" y2="48">
          <Stop offset="0" stopColor={palette.mango500} />
          <Stop offset="1" stopColor={palette.mango700} />
        </LinearGradient>
      </Defs>

      {bleed
        ? <Rect x="0" y="0" width="64" height="64" fill="url(#pkgBlob)" />
        : <Circle cx="32" cy="32" r="28" fill="url(#pkgBlob)" />}
      <Ellipse cx="32" cy="48" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* tapa */}
      <Path d="M18 26 L32 19 L46 26 L32 33 Z" fill={palette.mango500} />
      {/* cara izquierda */}
      <Path d="M18 26 L32 33 V47 L18 40 Z" fill="url(#pkgFront)" />
      {/* cara derecha */}
      <Path d="M46 26 L32 33 V47 L46 40 Z" fill={palette.mango700} opacity={0.85} />

      {/* cinta cruzada */}
      <Path d="M32 19 V47" stroke={palette.zipp500} strokeWidth={2.2} opacity={0.9} />
      <Path d="M18 26 L32 33 L46 26" stroke={palette.zipp400} strokeWidth={1.6} fill="none" opacity={0.8} />

      {/* etiqueta */}
      <Rect x="36" y="35.5" width="7" height="5" rx="1" fill={palette.paper0} stroke={palette.mango700} strokeWidth={0.7} />
      <Circle cx="37.5" cy="37" r="0.5" fill={palette.mango700} />
    </Svg>
  );
}
