import Svg, { Circle, Ellipse, Path, Rect, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { palette } from '../../theme/tokens';
import type { IllustrationProps } from './types';

/**
 * Ilustración 3D para dirección de tipo Trabajo / Oficina.
 * Representa una torre corporativa moderna en titanio zafiro y detalles en oro,
 * con fachada de cristal reflectante, entrada con marquesina y antena de telecomunicaciones.
 */
export function WorkAddressIllustration({ size = 52 }: IllustrationProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Defs>
        {/* Halo de fondo zafiro y titanio */}
        <RadialGradient id="workGlow" cx="50%" cy="40%" r="50%">
          <Stop offset="0%" stopColor="#60A5FA" stopOpacity={0.35} />
          <Stop offset="70%" stopColor="#3B82F6" stopOpacity={0.12} />
          <Stop offset="100%" stopColor="#1D4ED8" stopOpacity={0} />
        </RadialGradient>

        <LinearGradient id="workBlob" x1="4" y1="4" x2="60" y2="60">
          <Stop offset="0%" stopColor="#EFF6FF" stopOpacity={0.95} />
          <Stop offset="100%" stopColor="#BFDBFE" stopOpacity={0.4} />
        </LinearGradient>

        {/* Fachada torre principal */}
        <LinearGradient id="workTowerMain" x1="20" y1="12" x2="44" y2="52">
          <Stop offset="0%" stopColor="#1E293B" />
          <Stop offset="50%" stopColor="#0F172A" />
          <Stop offset="100%" stopColor="#090D16" />
        </LinearGradient>

        {/* Fachada torre secundaria / ala lateral */}
        <LinearGradient id="workTowerSide" x1="38" y1="20" x2="52" y2="52">
          <Stop offset="0%" stopColor="#334155" />
          <Stop offset="100%" stopColor="#1E293B" />
        </LinearGradient>

        {/* Remate / Corona dorada Zipp en la cima */}
        <LinearGradient id="workCrown" x1="22" y1="12" x2="42" y2="15">
          <Stop offset="0%" stopColor={palette.gold300} />
          <Stop offset="50%" stopColor={palette.gold400} />
          <Stop offset="100%" stopColor={palette.gold600} />
        </LinearGradient>

        {/* Reflejo diagonal de cristal */}
        <LinearGradient id="workGlassReflection" x1="20" y1="14" x2="44" y2="50">
          <Stop offset="0%" stopColor="#93C5FD" stopOpacity={0.6} />
          <Stop offset="40%" stopColor="#60A5FA" stopOpacity={0.15} />
          <Stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
        </LinearGradient>
      </Defs>

      {/* Halo y fondo */}
      <Circle cx="32" cy="32" r="30" fill="url(#workGlow)" />
      <Circle cx="32" cy="32" r="26" fill="url(#workBlob)" />

      {/* Sombra proyectada */}
      <Ellipse cx="33" cy="53" rx="19" ry="4.5" fill="#0F172A" opacity={0.18} />

      {/* Ala secundaria lateral (derecha) */}
      <Rect x="37" y="22" width="13" height="30" rx="2" fill="url(#workTowerSide)" />
      {/* Ventanitas ala lateral */}
      <Rect x="40" y="26" width="3" height="3" rx="0.8" fill="#93C5FD" opacity={0.7} />
      <Rect x="45" y="26" width="3" height="3" rx="0.8" fill="#60A5FA" opacity={0.5} />
      <Rect x="40" y="32" width="3" height="3" rx="0.8" fill="#FDE68A" opacity={0.8} />
      <Rect x="45" y="32" width="3" height="3" rx="0.8" fill="#93C5FD" opacity={0.6} />
      <Rect x="40" y="38" width="3" height="3" rx="0.8" fill="#93C5FD" opacity={0.5} />
      <Rect x="45" y="38" width="3" height="3" rx="0.8" fill="#FDE68A" opacity={0.7} />
      <Rect x="40" y="44" width="3" height="3" rx="0.8" fill="#60A5FA" opacity={0.6} />
      <Rect x="45" y="44" width="3" height="3" rx="0.8" fill="#93C5FD" opacity={0.5} />

      {/* Antena / Spire en la torre principal */}
      <Path d="M29.5 12 L29.5 5" stroke="#94A3B8" strokeWidth={1.5} strokeLinecap="round" />
      <Circle cx="29.5" cy="5" r="1.4" fill={palette.gold300} />
      <Path d="M26.5 8 L32.5 8" stroke="#CBD5E1" strokeWidth={0.9} strokeLinecap="round" />

      {/* Torre principal */}
      <Rect x="17" y="12" width="23" height="40" rx="3" fill="url(#workTowerMain)" />

      {/* Corona dorada superior */}
      <Rect x="17" y="12" width="23" height="3.2" rx="1.5" fill="url(#workCrown)" />

      {/* Franja de reflejo de cristal diagonal */}
      <Path
        d="M20 15 L28 15 L22 52 L17 52 L17 30 Z"
        fill="url(#workGlassReflection)"
      />

      {/* Cuadrícula de ventanas iluminadas torre principal */}
      <Rect x="21" y="19" width="3.5" height="3.5" rx="0.8" fill="#FDE68A" opacity={0.95} />
      <Rect x="27" y="19" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.8} />
      <Rect x="33" y="19" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.6} />

      <Rect x="21" y="25" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.7} />
      <Rect x="27" y="25" width="3.5" height="3.5" rx="0.8" fill="#FDE68A" opacity={0.9} />
      <Rect x="33" y="25" width="3.5" height="3.5" rx="0.8" fill="#60A5FA" opacity={0.5} />

      <Rect x="21" y="31" width="3.5" height="3.5" rx="0.8" fill="#60A5FA" opacity={0.6} />
      <Rect x="27" y="31" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.75} />
      <Rect x="33" y="31" width="3.5" height="3.5" rx="0.8" fill="#FDE68A" opacity={0.85} />

      <Rect x="21" y="37" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.8} />
      <Rect x="27" y="37" width="3.5" height="3.5" rx="0.8" fill="#60A5FA" opacity={0.5} />
      <Rect x="33" y="37" width="3.5" height="3.5" rx="0.8" fill="#93C5FD" opacity={0.7} />

      {/* Entrada / Lobby acristalado en planta baja */}
      <Rect x="24" y="44" width="9" height="8" rx="1.2" fill="#38BDF8" opacity={0.85} />
      <Path d="M28.5 44 L28.5 52" stroke="#0F172A" strokeWidth={1} />
      {/* Marquesina dorada de entrada */}
      <Rect x="22" y="43" width="13" height="2" rx="1" fill={palette.gold400} />
    </Svg>
  );
}
