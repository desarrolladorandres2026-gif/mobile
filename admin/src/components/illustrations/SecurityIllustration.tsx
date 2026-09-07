import { palette } from './palette';

/**
 * Seguridad: mini candado sobre escudo azul.
 * Mismo diseño que `mobile/components/illustrations/SecurityIllustration.tsx`.
 */
export function SecurityIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="secBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="secShield" x1="18" y1="14" x2="46" y2="46">
          <stop offset="0" stopColor={palette.zipp500} />
          <stop offset="1" stopColor={palette.zipp600} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#secBlob)" />
      <ellipse cx="32" cy="47" rx="11" ry="3" fill={palette.mango700} opacity={0.14} />

      <path d="M32 14 L46 19 V29 C46 38 40 44.5 32 47 C24 44.5 18 38 18 29 V19 Z" fill="url(#secShield)" />
      <rect x="27" y="28" width="10" height="9" rx="2" fill={palette.zipp100} opacity={0.95} />
      <path d="M29 28 V25 C29 22.8 30.3 21.5 32 21.5 C33.7 21.5 35 22.8 35 25 V28" stroke={palette.zipp100} strokeWidth={1.8} fill="none" />
      <path d="M29.3 32.3 L31.3 34.3 L34.7 30.5" stroke={palette.lima600} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
