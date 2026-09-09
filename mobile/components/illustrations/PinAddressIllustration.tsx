import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Ilustración 3D para dirección de tipo General / GPS / Otro punto.
 * Pin tridimensional metálico en oro champagne Zipp y esmeralda de entrega,
 * levitando sobre un disco de radar holográfico con ondas concéntricas de satélite.
 */
export function PinAddressIllustration({ size = 52 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        {/* Halo esmeralda y oro */}
        <RadialGradient id="pinGlow" cx="50%" cy="40%" r="50%">
          <Stop offset="0%" stopColor="#34D399" stopOpacity={0.35} />
          <Stop offset="70%" stopColor="#10B981" stopOpacity={0.12} />
          <Stop offset="100%" stopColor="#047857" stopOpacity={0} />
        </RadialGradient>

        <LinearGradient id="pinBlob" x1="4" y1="4" x2="60" y2="60">
          <Stop offset="0%" stopColor="#ECFDF5" stopOpacity={0.95} />
          <Stop offset="100%" stopColor="#A7F3D0" stopOpacity={0.4} />
        </LinearGradient>

        {/* Pin cuerpo 3D (dorado Zipp y esmeralda) */}
        <LinearGradient id="pinBodyGrad" x1="18" y1="12" x2="46" y2="48">
          <Stop offset="0%" stopColor={palette.gold300} />
          <Stop offset="45%" stopColor={palette.gold500} />
          <Stop offset="100%" stopColor={palette.gold700} />
        </LinearGradient>

        {/* Bisel de luz especular en el lomo del pin */}
        <LinearGradient id="pinLightBevel" x1="22" y1="14" x2="30" y2="30">
          <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.9} />
          <Stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
        </LinearGradient>

        {/* Disco de radar holográfico */}
        <LinearGradient id="radarDisc" x1="16" y1="48" x2="48" y2="54">
          <Stop offset="0%" stopColor="#10B981" stopOpacity={0.4} />
          <Stop offset="50%" stopColor="#34D399" stopOpacity={0.8} />
          <Stop offset="100%" stopColor="#10B981" stopOpacity={0.2} />
        </LinearGradient>
      </Defs>

      {/* Halo y fondo */}
      <Circle cx="32" cy="32" r="30" fill="url(#pinGlow)" />
      <Circle cx="32" cy="32" r="26" fill="url(#pinBlob)" />

      {/* Ondas concéntricas de radar en la base */}
      <Ellipse cx="32" cy="51" rx="21" ry="6" stroke="#10B981" strokeWidth={1} strokeDasharray="3 3" opacity={0.45} />
      <Ellipse cx="32" cy="51" rx="14" ry="4" stroke="#10B981" strokeWidth={1.2} opacity={0.65} />
      <Ellipse cx="32" cy="51" rx="7" ry="2.2" fill="url(#radarDisc)" />

      {/* Sombra del pin bajo la punta */}
      <Ellipse cx="32" cy="49" rx="4" ry="1.5" fill="#064E3B" opacity={0.3} />

      {/* Cuerpo principal del Pin 3D */}
      <Path
        d="M32 12 C23.2 12 16 19.2 16 28 C16 38.5 28.5 46.5 31.2 48.2 Q32 48.7 32.8 48.2 C35.5 46.5 48 38.5 48 28 C48 19.2 40.8 12 32 12 Z"
        fill="url(#pinBodyGrad)"
      />

      {/* Reflejo curvado de luz en el lateral superior */}
      <Path
        d="M21 21 C23.5 17.5 27.5 15 32 15 C34 15 36 15.6 37.8 16.5"
        stroke="url(#pinLightBevel)"
        strokeWidth={2.2}
        strokeLinecap="round"
        fill="none"
      />

      {/* Núcleo interior / Lente de satélite */}
      <Circle cx="32" cy="27" r="7.5" fill="#080B11" />
      <Circle cx="32" cy="27" r="5" fill="#10B981" />
      <Circle cx="30.5" cy="25.5" r="1.8" fill="#A7F3D0" />

      {/* Corona / Destello en la cúspide */}
      <Circle cx="32" cy="12" r="1.4" fill="#FFFFFF" />
    </Svg>
  );
}
