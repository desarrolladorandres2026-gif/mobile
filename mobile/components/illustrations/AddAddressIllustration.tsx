import Svg, { Circle, Ellipse, Path, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Mini-ilustración 3D para el botón / banner de "Agregar dirección".
 * Esfera flotante dorada con símbolo de suma en relieve, destellos y aura de iluminación.
 */
export function AddAddressIllustration({ size = 52 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        <RadialGradient id="addGlow" cx="50%" cy="40%" r="50%">
          <Stop offset="0%" stopColor={palette.gold300} stopOpacity={0.45} />
          <Stop offset="70%" stopColor={palette.gold500} stopOpacity={0.15} />
          <Stop offset="100%" stopColor={palette.gold700} stopOpacity={0} />
        </RadialGradient>

        <LinearGradient id="addBlob" x1="6" y1="6" x2="58" y2="58">
          <Stop offset="0%" stopColor="#FFFBEB" stopOpacity={0.95} />
          <Stop offset="100%" stopColor="#FDE68A" stopOpacity={0.4} />
        </LinearGradient>

        <LinearGradient id="addSphere" x1="16" y1="14" x2="48" y2="48">
          <Stop offset="0%" stopColor={palette.gold300} />
          <Stop offset="45%" stopColor={palette.gold500} />
          <Stop offset="100%" stopColor={palette.gold700} />
        </LinearGradient>

        <LinearGradient id="addHighlight" x1="22" y1="16" x2="36" y2="28">
          <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.9} />
          <Stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
        </LinearGradient>
      </Defs>

      {/* Halo y fondo */}
      <Circle cx="32" cy="32" r="30" fill="url(#addGlow)" />
      <Circle cx="32" cy="32" r="26" fill="url(#addBlob)" />

      {/* Sombra base */}
      <Ellipse cx="32" cy="52" rx="16" ry="4" fill="#78350F" opacity={0.2} />

      {/* Esfera / Medalla central 3D */}
      <Circle cx="32" cy="31" r="19" fill="url(#addSphere)" />

      {/* Resplandor de borde superior */}
      <Path
        d="M20 22 C23.5 16 32 14 38 16"
        stroke="url(#addHighlight)"
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />

      {/* Símbolo "+" en relieve 3D */}
      {/* Sombra del "+" */}
      <Path
        d="M32 20.5 L32 41.5 M21.5 31 L42.5 31"
        stroke="#78350F"
        strokeWidth={5}
        strokeLinecap="round"
        opacity={0.3}
      />
      {/* "+" Frontal blanco puro */}
      <Path
        d="M32 20 L32 40 M22 30 L42 30"
        stroke="#FFFFFF"
        strokeWidth={4.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}
