import { palette } from './palette';

/**
 * Zonas: mini pin de mapa rojo.
 * Mismo diseño que `mobile/components/illustrations/LocationIllustration.tsx`.
 */
export function LocationIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="locBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="locPin" x1="18" y1="14" x2="46" y2="42">
          <stop offset="0" stopColor={palette.cereza400} />
          <stop offset="1" stopColor={palette.cereza500} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#locBlob)" />
      <ellipse cx="32" cy="47" rx="9" ry="2.6" fill={palette.mango700} opacity={0.16} />

      <path
        d="M32 14 C24.3 14 18 20.2 18 27.8 C18 37.8 32 46 32 46 C32 46 46 37.8 46 27.8 C46 20.2 39.7 14 32 14 Z"
        fill="url(#locPin)"
      />
      <path d="M22 20 C23.5 18 26 16.8 28.5 16.6" stroke={palette.cereza100} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.7} />
      <circle cx="32" cy="27.5" r="6" fill={palette.mango400} />
    </svg>
  );
}
