import { palette } from './palette';

/**
 * Paquete / pedido: mini caja de cartón con cinta azul y etiqueta.
 * Mismo diseño que `mobile/components/illustrations/PackageIllustration.tsx`.
 */
export function PackageIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="pkgBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="pkgFront" x1="18" y1="28" x2="46" y2="48">
          <stop offset="0" stopColor={palette.mango500} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#pkgBlob)" />
      <ellipse cx="32" cy="48" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      <path d="M18 26 L32 19 L46 26 L32 33 Z" fill={palette.mango500} />
      <path d="M18 26 L32 33 V47 L18 40 Z" fill="url(#pkgFront)" />
      <path d="M46 26 L32 33 V47 L46 40 Z" fill={palette.mango700} opacity={0.85} />

      <path d="M32 19 V47" stroke={palette.zipp500} strokeWidth={2.2} opacity={0.9} />
      <path d="M18 26 L32 33 L46 26" stroke={palette.zipp400} strokeWidth={1.6} fill="none" opacity={0.8} />

      <rect x="36" y="35.5" width="7" height="5" rx="1" fill={palette.paper0} stroke={palette.mango700} strokeWidth={0.7} />
      <circle cx="37.5" cy="37" r="0.5" fill={palette.mango700} />
    </svg>
  );
}
