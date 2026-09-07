import { palette } from './palette';

/** Pedidos por preparar: mini reloj de cocina con vapor, mismo blob del set. */
export function PrepTimeIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="prepBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="prepFace" x1="18" y1="18" x2="46" y2="46">
          <stop offset="0" stopColor={palette.paper0} />
          <stop offset="1" stopColor={palette.mango100} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#prepBlob)" />
      <ellipse cx="32" cy="49" rx="11" ry="2.6" fill={palette.mango700} opacity={0.14} />

      {/* vapor */}
      <path
        d="M26 14 C24 16 26 18 25 20 M32 12 C30 14.5 32 17 31 19.5 M38 14 C36 16 38 18 37 20"
        stroke={palette.paper300}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
      />

      {/* botón superior */}
      <rect x="29" y="19" width="6" height="4" rx="1.5" fill={palette.mango700} />

      {/* esfera */}
      <circle cx="32" cy="35" r="15" fill="url(#prepFace)" stroke={palette.mango500} strokeWidth={2.2} />
      <circle cx="32" cy="35" r="1.6" fill={palette.ink700} />
      <path d="M32 35 L32 26" stroke={palette.ink700} strokeWidth={1.8} strokeLinecap="round" />
      <path d="M32 35 L38 39" stroke={palette.ink700} strokeWidth={1.8} strokeLinecap="round" />

      {/* marca de "a tiempo" */}
      <circle cx="44" cy="42" r="6" fill={palette.lima500} />
      <path d="M41.3 42.2 L43.2 44.1 L46.7 40.3" stroke={palette.lima800} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
