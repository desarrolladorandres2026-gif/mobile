import { palette } from './palette';

/**
 * Billetera / ganancia neta: mini billetera de cuero con billete asomando.
 * Mismo diseño que `mobile/components/illustrations/WalletIllustration.tsx`.
 */
export function WalletIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="walletBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="walletBody" x1="16" y1="22" x2="48" y2="44">
          <stop offset="0" stopColor={palette.mango500} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#walletBlob)" />
      <ellipse cx="32" cy="47" rx="13" ry="3" fill={palette.mango700} opacity={0.14} />

      <rect x="22" y="15" width="20" height="10" rx="1.2" fill={palette.lima500} />
      <circle cx="32" cy="20" r="2.6" fill={palette.lima600} opacity={0.7} />

      <path d="M16 24 C16 21.8 17.8 20 20 20 H44 C46.2 20 48 21.8 48 24 V42 C48 44.2 46.2 46 44 46 H20 C17.8 46 16 44.2 16 42 Z" fill="url(#walletBody)" />
      <path d="M16 30 H48" stroke={palette.ink700} strokeWidth={1.2} opacity={0.4} strokeDasharray="2,2" />
      <circle cx="41" cy="35" r="3.4" fill={palette.ink700} opacity={0.85} />
      <circle cx="41" cy="35" r="1.2" fill={palette.mango400} />
    </svg>
  );
}
