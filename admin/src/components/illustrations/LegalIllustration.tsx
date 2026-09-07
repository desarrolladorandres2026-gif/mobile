import { palette } from './palette';

/** Legal y PQRS: mini balanza de justicia. */
export function LegalIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="legalBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#legalBlob)" />
      <ellipse cx="32" cy="49" rx="13" ry="2.6" fill={palette.mango700} opacity={0.14} />

      {/* base y poste */}
      <path d="M25 48 H39 L37 44 H27 Z" fill={palette.mango700} />
      <rect x="30.5" y="18" width="3" height="26" rx="1.5" fill={palette.ink700} />
      <path d="M20 22 H44" stroke={palette.ink700} strokeWidth={2.4} strokeLinecap="round" />
      <circle cx="32" cy="20" r="2.4" fill={palette.ink700} />

      {/* platillo izquierdo, azul */}
      <path d="M14 24 L20 24 L23 33 C23 35.8 20.6 38 17.8 38 C15 38 12.6 35.8 12.6 33 Z" fill={palette.zipp500} opacity={0.92} />
      <path d="M20 22 L17 32" stroke={palette.ink700} strokeWidth={1.1} opacity={0.7} />

      {/* platillo derecho, dorado */}
      <path d="M44 24 L50 24 L51.4 33 C51.4 35.8 49 38 46.2 38 C43.4 38 41 35.8 41 33 Z" fill={palette.mango500} opacity={0.92} />
      <path d="M44 22 L47 32" stroke={palette.ink700} strokeWidth={1.1} opacity={0.7} />
    </svg>
  );
}
