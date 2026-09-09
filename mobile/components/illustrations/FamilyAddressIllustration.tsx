import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Ilustración 3D para dirección de tipo Familia / Donde mi mamá / Pareja.
 * Resalta la calidez del hogar familiar con un techo acogedor en rosa-coral y oro,
 * un corazón flotante emblemático, ventana cálida y jardín de entrada.
 */
export function FamilyAddressIllustration({ size = 52 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        {/* Halo de fondo cálido coral / rosa ámbar */}
        <RadialGradient id="famGlow" cx="50%" cy="40%" r="50%">
          <Stop offset="0%" stopColor="#FB7185" stopOpacity={0.35} />
          <Stop offset="70%" stopColor="#F43F5E" stopOpacity={0.12} />
          <Stop offset="100%" stopColor="#E11D48" stopOpacity={0} />
        </RadialGradient>

        <LinearGradient id="famBlob" x1="4" y1="4" x2="60" y2="60">
          <Stop offset="0%" stopColor="#FFF1F2" stopOpacity={0.95} />
          <Stop offset="100%" stopColor="#FECDD3" stopOpacity={0.45} />
        </LinearGradient>

        {/* Tejado coral y cereza cálido */}
        <LinearGradient id="famRoof" x1="12" y1="14" x2="52" y2="34">
          <Stop offset="0%" stopColor="#F43F5E" />
          <Stop offset="60%" stopColor="#E11D48" />
          <Stop offset="100%" stopColor="#BE123C" />
        </LinearGradient>

        {/* Fachada cálida crema */}
        <LinearGradient id="famWall" x1="18" y1="28" x2="46" y2="52">
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#FFE4E6" />
        </LinearGradient>

        {/* Corazón en gradiente oro-rosa */}
        <LinearGradient id="famHeart" x1="26" y1="10" x2="38" y2="24">
          <Stop offset="0%" stopColor="#FB7185" />
          <Stop offset="100%" stopColor="#E11D48" />
        </LinearGradient>

        {/* Luz de ventana */}
        <LinearGradient id="famWinGlow" x1="33" y1="33" x2="43" y2="43">
          <Stop offset="0%" stopColor="#FEF08A" />
          <Stop offset="100%" stopColor="#F59E0B" />
        </LinearGradient>
      </Defs>

      {/* Halo y fondo */}
      <Circle cx="32" cy="32" r="30" fill="url(#famGlow)" />
      <Circle cx="32" cy="32" r="26" fill="url(#famBlob)" />

      {/* Sombra base */}
      <Ellipse cx="32" cy="53" rx="19" ry="4.5" fill="#881337" opacity={0.16} />

      {/* Estructura frontal */}
      <Path
        d="M17 29 L47 29 Q49 29 49 31 L49 50 Q49 52 47 52 L17 52 Q15 52 15 50 L15 31 Q15 29 17 29 Z"
        fill="url(#famWall)"
      />

      {/* Techo a dos aguas con curvatura acogedora */}
      <Path
        d="M32 15 L53 30 Q54 31 52.5 31.5 L48 30.5 L32 19 L16 30.5 L11.5 31.5 Q10 31 11 30 Z"
        fill="url(#famRoof)"
      />

      {/* Emblema de Corazón en el frontón */}
      <Circle cx="32" cy="22" r="5.5" fill="#FFFFFF" opacity={0.9} />
      <Path
        d="M32 24.5 C32 24.5 29 22.5 29 20.8 C29 19.5 30 18.5 31.2 18.5 C31.7 18.5 32 18.8 32 18.8 C32 18.8 32.3 18.5 32.8 18.5 C34 18.5 35 19.5 35 20.8 C35 22.5 32 24.5 32 24.5 Z"
        fill="url(#famHeart)"
      />

      {/* Ventana cálida con postigos */}
      <Rect x="34" y="34" width="9.5" height="9.5" rx="2" fill="url(#famWinGlow)" />
      <Path d="M34 38.7 L43.5 38.7" stroke="#FFFFFF" strokeWidth={0.9} opacity={0.85} />
      <Path d="M38.7 34 L38.7 43.5" stroke="#FFFFFF" strokeWidth={0.9} opacity={0.85} />
      <Rect x="34" y="34" width="9.5" height="9.5" rx="2" stroke="#FDA4AF" strokeWidth={1} fill="none" />

      {/* Puerta con arco suave */}
      <Path
        d="M20 52 L20 38 Q20 35.5 24 35.5 Q28 35.5 28 38 L28 52 Z"
        fill="#9F1239"
      />
      <Circle cx="26.5" cy="45" r="1.1" fill={palette.gold300} />

      {/* Macetero de flores en la base */}
      <Rect x="33" y="44.5" width="11.5" height="2" rx="1" fill="#E2E8F0" />
      <Circle cx="35" cy="43.5" r="1.6" fill="#F43F5E" />
      <Circle cx="38.7" cy="43" r="1.7" fill="#FBBF24" />
      <Circle cx="42.5" cy="43.5" r="1.6" fill="#FB7185" />
    </Svg>
  );
}
