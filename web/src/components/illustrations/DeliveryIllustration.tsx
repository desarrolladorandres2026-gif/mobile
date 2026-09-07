import { palette } from './palette';

/**
 * Domiciliarios: mini moto de reparto azul con baúl dorado.
 * Mismo diseño que `mobile/components/illustrations/DeliveryIllustration.tsx`.
 */
export function DeliveryIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="delBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="delBox" x1="16" y1="20" x2="30" y2="32">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango500} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#delBlob)" />
      <ellipse cx="32" cy="47" rx="14" ry="3" fill={palette.mango700} opacity={0.14} />

      <circle cx="21" cy="42" r="5.5" stroke={palette.ink700} strokeWidth={2.2} fill="none" />
      <circle cx="43" cy="42" r="5.5" stroke={palette.ink700} strokeWidth={2.2} fill="none" />

      <path
        d="M21 42 L27 30 H33 L36 36 H43"
        stroke={palette.zipp500}
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M33 30 H38 L36 36" stroke={palette.zipp400} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />

      <path d="M15 20 H28 V30 H15 Z" fill="url(#delBox)" />
      <path d="M15 25 H28" stroke={palette.mango100} strokeWidth={1.2} opacity={0.7} />
    </svg>
  );
}
