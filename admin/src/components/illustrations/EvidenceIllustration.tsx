import { palette } from './palette';

/**
 * Evidencias: cámara sobre círculo lima, con el disparador marcado.
 * Mismo lenguaje visual que `SecurityIllustration` — degradado + glifo simple.
 */
export function EvidenceIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="evBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.lima100} />
          <stop offset="1" stopColor={palette.lima500} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="evBody" x1="16" y1="22" x2="48" y2="46">
          <stop offset="0" stopColor={palette.ink600} />
          <stop offset="1" stopColor={palette.ink700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#evBlob)" />
      <ellipse cx="32" cy="47" rx="11" ry="3" fill={palette.lima700} opacity={0.14} />

      <rect x="24" y="20" width="7" height="4" rx="1.5" fill="url(#evBody)" />
      <rect x="15" y="23" width="34" height="24" rx="6" fill="url(#evBody)" />
      <circle cx="32" cy="35" r="8" fill={palette.ink500} />
      <circle cx="32" cy="35" r="5" fill={palette.lima400} />
      <circle cx="41.5" cy="28.5" r="1.6" fill={palette.lima400} />
    </svg>
  );
}
