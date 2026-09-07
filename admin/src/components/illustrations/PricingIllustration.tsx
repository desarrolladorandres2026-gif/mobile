import { palette } from './palette';

/** Tarifas y precios: mini etiqueta con signo % y moneda de acento. */
export function PricingIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="priceBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="priceTag" x1="14" y1="16" x2="42" y2="42">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#priceBlob)" />
      <ellipse cx="30" cy="48" rx="12" ry="2.8" fill={palette.mango700} opacity={0.14} />

      <path
        d="M16 20 C16 18.3 17.3 17 19 17 H33 C33.8 17 34.6 17.3 35.1 17.9 L46.1 28.9 C47.3 30.1 47.3 31.9 46.1 33.1 L33.1 46.1 C31.9 47.3 30.1 47.3 28.9 46.1 L17.9 35.1 C17.3 34.6 17 33.8 17 33 Z"
        fill="url(#priceTag)"
        stroke={palette.mango700}
        strokeWidth={1}
      />
      <circle cx="24" cy="25" r="3" fill={palette.paper0} />

      <circle cx="45" cy="44" r="7.5" fill={palette.lima500} stroke={palette.lima700} strokeWidth={1.2} />
      <path
        d="M42 46.2 L43.6 47.8 L48 43"
        stroke={palette.lima800}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
