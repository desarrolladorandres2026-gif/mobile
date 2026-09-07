import { palette } from './palette';

/**
 * Comercio / negocio: mini tienda con toldo a rayas.
 * Mismo diseño que `mobile/components/illustrations/DefaultIllustration.tsx`.
 */
export function StoreIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="storeBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="storeFacade" x1="18" y1="30" x2="46" y2="46">
          <stop offset="0" stopColor={palette.paper0} />
          <stop offset="1" stopColor={palette.mango100} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#storeBlob)" />

      <path d="M18 28 L22 20 H42 L46 28 Z" fill={palette.mango500} />
      <path d="M18 28 L22 34 L26 28 Z" fill={palette.mango700} />
      <path d="M26 28 L30 34 L34 28 Z" fill={palette.mango400} />
      <path d="M34 28 L38 34 L42 28 Z" fill={palette.mango700} />
      <path d="M42 28 L46 34 L46 28 Z" fill={palette.mango400} />

      <path d="M20 32 H44 V46 H20 Z" fill="url(#storeFacade)" stroke={palette.mango500} strokeWidth={1.3} />
      <path
        d="M29 46 V37 C29 35.3 30.3 34 32 34 C33.7 34 35 35.3 35 37 V46 Z"
        fill={palette.mango700}
      />
    </svg>
  );
}
