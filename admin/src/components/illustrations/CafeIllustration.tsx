import { palette } from './palette';

/**
 * Cafeterías: mini taza humeante con platillo.
 * Mismo diseño que `mobile/components/illustrations/CafeIllustration.tsx`.
 */
export function CafeIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="cafeBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="cafeMug" x1="18" y1="28" x2="42" y2="46">
          <stop offset="0" stopColor={palette.paper0} />
          <stop offset="1" stopColor={palette.mango100} />
        </linearGradient>
        <linearGradient id="cafeSaucer" x1="14" y1="42" x2="46" y2="46">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#cafeBlob)" />
      <ellipse cx="30" cy="47" rx="14" ry="3.2" fill={palette.mango700} opacity={0.14} />

      <path
        d="M25 14 C23 17 27 18 25 21 M33 14 C31 17 35 18 33 21"
        stroke={palette.paper400}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
      />

      <ellipse cx="29" cy="44" rx="16" ry="3" fill="url(#cafeSaucer)" />

      <path
        d="M18 28 H38 L36.5 41 C36.2 43.5 34 45 31.5 45 H24.5 C22 45 19.8 43.5 19.5 41 Z"
        fill="url(#cafeMug)"
        stroke={palette.mango400}
        strokeWidth={1}
      />
      <ellipse cx="28" cy="28" rx="10" ry="2" fill={palette.mango700} />
      <path
        d="M38 31 C43 31 43 40 38 40"
        stroke={palette.mango500}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />

      <path d="M42 44.5 C44.5 43.5 46 44.8 45.3 46.6 C43.2 47 41.4 46 42 44.5 Z" fill={palette.lima500} />
    </svg>
  );
}
