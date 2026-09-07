import { palette } from './palette';

/**
 * Cupones: mini ticket rojo con signo %.
 * Mismo diseño que `mobile/components/illustrations/CouponIllustration.tsx`.
 */
export function CouponIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="couponBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="couponTicket" x1="16" y1="22" x2="48" y2="42">
          <stop offset="0" stopColor={palette.cereza400} />
          <stop offset="1" stopColor={palette.cereza500} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#couponBlob)" />
      <ellipse cx="32" cy="46" rx="13" ry="3.2" fill={palette.mango700} opacity={0.14} />

      <path
        d="M17 24 C17 22.3 18.3 21 20 21 H44 C45.7 21 47 22.3 47 24 V27 C45.3 27 44 28.3 44 30 C44 31.7 45.3 33 47 33 V36 C47 37.7 45.7 39 44 39 H20 C18.3 39 17 37.7 17 36 V33 C18.7 33 20 31.7 20 30 C20 28.3 18.7 27 17 27 Z"
        fill="url(#couponTicket)"
        stroke={palette.mango400}
        strokeWidth={1}
      />
      <path d="M32 23 V37" stroke={palette.ink700} strokeWidth={1.2} strokeDasharray="2.5,2.5" opacity={0.6} />
      <circle cx="26.5" cy="27" r="1.8" fill={palette.paper0} />
      <circle cx="37.5" cy="33" r="1.8" fill={palette.paper0} />
      <path d="M25.5 34 L38.5 26" stroke={palette.paper0} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
