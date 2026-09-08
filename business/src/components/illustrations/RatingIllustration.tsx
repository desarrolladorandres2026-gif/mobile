import { palette } from './palette';

/**
 * Reseñas: estrella dorada con brillo.
 * Mismo diseño que `mobile/components/illustrations/RatingIllustration.tsx`.
 */
export function RatingIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="rateBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="rateStar" x1="18" y1="18" x2="46" y2="46">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#rateBlob)" />
      <ellipse cx="32" cy="47" rx="12" ry="3" fill={palette.mango700} opacity={0.14} />

      <path
        d="M32 15.5 L37.2 26.1 L48.9 27.8 L40.5 36 L42.4 47.7 L32 42.2 L21.6 47.7 L23.5 36 L15.1 27.8 L26.8 26.1 Z"
        fill="url(#rateStar)"
      />
      <path
        d="M27 23.5 C28 21.5 29.8 20.4 31.4 20.6"
        stroke={palette.paper0}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
      />
    </svg>
  );
}
