import { palette } from './palette';

/**
 * Comidas rápidas: mini hamburguesa con capas.
 * Mismo diseño que `mobile/components/illustrations/FastFoodIllustration.tsx`.
 */
export function FastFoodIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="ffBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="ffBun" x1="16" y1="18" x2="48" y2="30">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango500} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#ffBlob)" />
      <ellipse cx="32" cy="44" rx="15" ry="4" fill={palette.mango700} opacity={0.14} />

      <path d="M17 27 C17 19 47 19 47 27 Z" fill="url(#ffBun)" />
      <circle cx="25" cy="22" r="1.1" fill={palette.paper0} />
      <circle cx="32" cy="20" r="1.1" fill={palette.paper0} />
      <circle cx="39" cy="22" r="1.1" fill={palette.paper0} />

      <path
        d="M16 29 C19 27 21 30 24 28 C27 30.5 29 27.5 32 29.5 C35 27.5 37 30.5 40 28 C43 30 45 27 48 29 L47 31.5 L17 31.5 Z"
        fill={palette.lima500}
      />
      <path d="M20 29.5 C24 28.5 28 30 32 29" stroke={palette.lima600} strokeWidth={0.6} fill="none" opacity={0.7} />

      <path d="M16.5 31.5 L47.5 31.5 L46.5 34.5 L17.5 34.5 Z" fill={palette.cereza500} />
      <circle cx="24" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />
      <circle cx="32" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />
      <circle cx="40" cy="33" r="0.7" fill={palette.cereza700} opacity={0.6} />

      <path d="M16 34.5 L48 34.5 L47 38.5 L17 38.5 Z" fill={palette.mango700} />
      <path d="M17 38.5 L47 38.5 C47 43 17 43 17 38.5 Z" fill={palette.mango500} />
    </svg>
  );
}
