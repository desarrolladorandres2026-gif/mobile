import { palette } from './palette';

/**
 * Arma tu pedido: mini canasta con víveres de colores.
 * Mismo diseño que `mobile/components/illustrations/MarketIllustration.tsx`.
 */
export function MarketIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="mktBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="mktBasket" x1="16" y1="30" x2="48" y2="46">
          <stop offset="0" stopColor={palette.mango500} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#mktBlob)" />
      <ellipse cx="32" cy="47" rx="14" ry="3.4" fill={palette.mango700} opacity={0.14} />

      <circle cx="26" cy="26" r="4" fill={palette.lima500} />
      <path d="M26 22 C27.4 21 28.6 21.6 28 23" stroke={palette.lima700} strokeWidth={0.8} fill="none" opacity={0.7} />
      <circle cx="34" cy="23" r="3.4" fill={palette.cereza500} />
      <path d="M34 19.6 V21.4" stroke={palette.lima700} strokeWidth={0.9} strokeLinecap="round" />
      <circle cx="40" cy="27" r="3.6" fill={palette.mango400} />

      <path
        d="M22 30 C22 22 42 22 42 30"
        stroke={palette.mango700}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />

      <path d="M18 30 H46 L43 45 C42.6 46.7 41 48 39.2 48 H24.8 C23 48 21.4 46.7 21 45 Z" fill="url(#mktBasket)" />
      <path d="M22 34 H42 M23 39 H41" stroke={palette.mango100} strokeWidth={1.3} opacity={0.7} />
    </svg>
  );
}
