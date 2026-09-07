import { palette } from './palette';

/**
 * Efectivo / ventas: mini billete verde con sello dorado.
 * Mismo diseño que `mobile/components/illustrations/CashIllustration.tsx`.
 */
export function CashIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="cashBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="cashBill" x1="14" y1="24" x2="50" y2="40">
          <stop offset="0" stopColor={palette.lima500} />
          <stop offset="1" stopColor={palette.lima600} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#cashBlob)" />
      <ellipse cx="32" cy="47" rx="14" ry="3" fill={palette.mango700} opacity={0.14} />

      <rect x="13" y="23" width="38" height="20" rx="3" fill="url(#cashBill)" />
      <rect x="15.5" y="25.5" width="33" height="15" rx="1.5" stroke={palette.lima800} strokeWidth={1} fill="none" opacity={0.55} />
      <circle cx="32" cy="33" r="6" fill={palette.mango500} />
      <circle cx="32" cy="33" r="6" stroke={palette.mango700} strokeWidth={1} fill="none" opacity={0.6} />
      <circle cx="19" cy="28" r="1.4" fill={palette.lima800} opacity={0.6} />
      <circle cx="45" cy="38" r="1.4" fill={palette.lima800} opacity={0.6} />
    </svg>
  );
}
