import { palette } from './palette';

/**
 * Cargos: mini maletín — el puesto de la persona en la organización.
 */
export function PositionsIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="posBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.lima100} />
          <stop offset="1" stopColor={palette.lima500} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="posCase" x1="16" y1="26" x2="48" y2="46">
          <stop offset="0" stopColor={palette.zipp500} />
          <stop offset="1" stopColor={palette.zipp600} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#posBlob)" />
      <ellipse cx="32" cy="49" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      <path d="M26 24 C26 21 28 19 31 19 H33 C36 19 38 21 38 24 V27 H26 Z" fill="none" stroke="url(#posCase)" strokeWidth={2.4} />
      <rect x="16" y="27" width="32" height="20" rx="4" fill="url(#posCase)" />
      <rect x="16" y="27" width="32" height="6" fill={palette.zipp400} opacity={0.5} />
      <rect x="28" y="33" width="8" height="6" rx="1.5" fill={palette.zipp100} />
    </svg>
  );
}
