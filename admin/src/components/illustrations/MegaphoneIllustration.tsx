import { palette } from './palette';

/** Publicidad: mini megáfono con ondas de sonido. */
export function MegaphoneIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="megaBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="megaBody" x1="16" y1="18" x2="42" y2="40">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#megaBlob)" />
      <ellipse cx="30" cy="49" rx="13" ry="2.6" fill={palette.mango700} opacity={0.14} />

      <path d="M16 28 V36 H21 L36 44 V20 L21 28 Z" fill="url(#megaBody)" />
      <rect x="13" y="27" width="4" height="10" rx="1.5" fill={palette.ink700} />
      <path d="M22 36 L25 45 C25.4 46.2 24.5 47.4 23.2 47.4 H21.3 C20.4 47.4 19.6 46.8 19.4 46 L17 36" fill={palette.ink700} opacity={0.8} />

      <path d="M40 24 C43 27 43 33 40 36" stroke={palette.lima600} strokeWidth={2} strokeLinecap="round" fill="none" />
      <path d="M44.5 19.5 C50 25.5 50 34.5 44.5 40.5" stroke={palette.lima500} strokeWidth={2} strokeLinecap="round" fill="none" />
      <circle cx="46" cy="17" r="3.4" fill={palette.cereza500} />
    </svg>
  );
}
