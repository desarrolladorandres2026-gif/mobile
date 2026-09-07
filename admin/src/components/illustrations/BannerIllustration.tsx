import { palette } from './palette';

/** Banners de inicio: mini tarjetas de imagen apiladas. */
export function BannerIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="bannerBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#bannerBlob)" />
      <ellipse cx="32" cy="49" rx="14" ry="2.6" fill={palette.mango700} opacity={0.14} />

      {/* tarjeta de atrás */}
      <rect x="21" y="14" width="26" height="19" rx="3" fill={palette.zipp100} stroke={palette.zipp300} strokeWidth={1} />

      {/* tarjeta de adelante */}
      <rect x="15" y="22" width="28" height="20" rx="3" fill={palette.paper0} stroke={palette.mango500} strokeWidth={1.4} />
      <circle cx="21" cy="29" r="2.6" fill={palette.mango500} />
      <path d="M17 39 L25 32 L30 36 L37 29 L41 39 Z" fill={palette.lima500} opacity={0.9} />
    </svg>
  );
}
