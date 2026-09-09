import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, RadialGradient, Stop, G } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Ilustración 3D para dirección de tipo Casa / Hogar.
 * Presenta una casa estilizada con tejado cálido en gradiente oro-ámbar,
 * ventana iluminada, puerta con dintel, chimenea y vegetación viva.
 */
export function HomeAddressIllustration({ size = 52 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        {/* Halo de fondo suave y brillante */}
        <RadialGradient id="homeGlow" cx="50%" cy="40%" r="50%">
          <Stop offset="0%" stopColor={palette.gold300} stopOpacity={0.4} />
          <Stop offset="70%" stopColor={palette.gold500} stopOpacity={0.15} />
          <Stop offset="100%" stopColor={palette.gold600} stopOpacity={0} />
        </RadialGradient>

        {/* Blob de base circular con gradiente ámbar-dorado */}
        <LinearGradient id="homeBlob" x1="4" y1="4" x2="60" y2="60">
          <Stop offset="0%" stopColor={palette.gold100} stopOpacity={0.95} />
          <Stop offset="100%" stopColor={palette.gold300} stopOpacity={0.4} />
        </LinearGradient>

        {/* Tejado 3D en gradiente terracota y ámbar dorado */}
        <LinearGradient id="homeRoofMain" x1="12" y1="14" x2="52" y2="34">
          <Stop offset="0%" stopColor="#F59E0B" />
          <Stop offset="50%" stopColor="#D97706" />
          <Stop offset="100%" stopColor="#B45309" />
        </LinearGradient>

        <LinearGradient id="homeRoofBevel" x1="14" y1="16" x2="32" y2="16">
          <Stop offset="0%" stopColor="#FDE68A" />
          <Stop offset="100%" stopColor="#F59E0B" />
        </LinearGradient>

        {/* Fachada frontal */}
        <LinearGradient id="homeWallFront" x1="18" y1="28" x2="46" y2="52">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#E2E8F0" />
        </LinearGradient>

        {/* Chimenea */}
        <LinearGradient id="homeChimney" x1="40" y1="12" x2="48" y2="24">
          <Stop offset="0%" stopColor="#D97706" />
          <Stop offset="100%" stopColor="#92400E" />
        </LinearGradient>

        {/* Ventana con luz cálida interior */}
        <LinearGradient id="homeWindowGlow" x1="33" y1="32" x2="43" y2="42">
          <Stop offset="0%" stopColor="#FEF08A" />
          <Stop offset="100%" stopColor="#F59E0B" />
        </LinearGradient>

        {/* Puerta principal de madera / obsidiana */}
        <LinearGradient id="homeDoor" x1="21" y1="35" x2="29" y2="52">
          <Stop offset="0%" stopColor="#1E293B" />
          <Stop offset="100%" stopColor="#0F172A" />
        </LinearGradient>
      </Defs>

      {/* Halo y fondo */}
      <Circle cx="32" cy="32" r="30" fill="url(#homeGlow)" />
      <Circle cx="32" cy="32" r="26" fill="url(#homeBlob)" />

      {/* Sombra proyectada en la base */}
      <Ellipse cx="32" cy="53" rx="19" ry="4.5" fill="#0F172A" opacity={0.16} />

      {/* Chimenea con borde y humo */}
      <Path d="M42 22 L42 14 Q42 12 44 12 L47 12 Q49 12 49 14 L49 26 Z" fill="url(#homeChimney)" />
      <Ellipse cx="45.5" cy="12" rx="3.5" ry="1.2" fill="#FDE68A" opacity={0.6} />
      {/* Humito sutil */}
      <Path d="M46 9 Q48 6 45 4 Q43 2 45 0.5" stroke={palette.gold400} strokeWidth={1.4} strokeLinecap="round" opacity={0.65} fill="none" />

      {/* Paredes de la casa */}
      <Path
        d="M17 29 L47 29 Q49 29 49 31 L49 50 Q49 52 47 52 L17 52 Q15 52 15 50 L15 31 Q15 29 17 29 Z"
        fill="url(#homeWallFront)"
      />

      {/* Zócalo inferior */}
      <Path d="M15 49 L49 49 L49 51 Q49 52 47 52 L17 52 Q15 52 15 51 Z" fill="#CBD5E1" />

      {/* Tejado a 2 aguas con voladizo y bisel de luz */}
      <Path
        d="M32 14 L53 29 Q54 30 52.8 30.8 L48 30 L32 19 L16 30 L11.2 30.8 Q10 30 11 29 Z"
        fill="url(#homeRoofMain)"
      />
      {/* Luz en el filo del techo */}
      <Path
        d="M32 14 L11 29"
        stroke="url(#homeRoofBevel)"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <Circle cx="32" cy="14" r="1.4" fill="#FEF3C7" />

      {/* Ventana con marco y luz */}
      <Rect x="34" y="33" width="10" height="10" rx="2.2" fill="url(#homeWindowGlow)" />
      <Path d="M34 38 L44 38" stroke="#FFFFFF" strokeWidth={1} opacity={0.8} />
      <Path d="M39 33 L39 43" stroke="#FFFFFF" strokeWidth={1} opacity={0.8} />
      <Rect x="34" y="33" width="10" height="10" rx="2.2" stroke="#D97706" strokeWidth={1} fill="none" />

      {/* Puerta con arco superior */}
      <Path
        d="M20 52 L20 38 Q20 35 24 35 Q28 35 28 38 L28 52 Z"
        fill="url(#homeDoor)"
      />
      {/* Pomo de la puerta dorado */}
      <Circle cx="26.5" cy="45" r="1.1" fill={palette.gold300} />
      {/* Escalón de entrada */}
      <Rect x="18" y="51" width="12" height="1.8" rx="0.9" fill="#94A3B8" />

      {/* Pequeña planta / arbusto junto a la entrada */}
      <Circle cx="16.5" cy="48.5" r="3.2" fill={palette.emerald500} />
      <Circle cx="15.2" cy="47.2" r="2.2" fill={palette.emerald400} />
      <Circle cx="17.8" cy="47" r="1.8" fill={palette.emerald400} />
    </Svg>
  );
}
