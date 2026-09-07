import { palette } from './palette';

/** Resumen diario: mini hoja de calendario con una casilla marcada. */
export function CalendarIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="calBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.zipp100} />
          <stop offset="1" stopColor={palette.zipp300} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="calBody" x1="16" y1="16" x2="48" y2="48">
          <stop offset="0" stopColor={palette.paper0} />
          <stop offset="1" stopColor={palette.paper100} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#calBlob)" />
      <ellipse cx="32" cy="49" rx="13" ry="2.6" fill={palette.zipp700} opacity={0.14} />

      <rect x="16" y="18" width="32" height="28" rx="4" fill="url(#calBody)" stroke={palette.zipp500} strokeWidth={1.5} />
      <rect x="16" y="18" width="32" height="8" rx="4" fill={palette.zipp500} />
      <rect x="22" y="14" width="3" height="8" rx="1.5" fill={palette.zipp700} />
      <rect x="39" y="14" width="3" height="8" rx="1.5" fill={palette.zipp700} />

      <rect x="21" y="31" width="6" height="6" rx="1.4" fill={palette.paper200} />
      <rect x="30" y="31" width="6" height="6" rx="1.4" fill={palette.paper200} />
      <rect x="21" y="31" width="6" height="6" rx="1.4" fill={palette.lima500} opacity={0.9} />
      <path d="M22.6 34 L24 35.4 L26.2 32.6" stroke={palette.ink700} strokeWidth={1.3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="39" y="31" width="6" height="6" rx="1.4" fill={palette.paper200} />
    </svg>
  );
}
