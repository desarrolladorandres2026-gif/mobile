import { palette } from './palette';

/** Dashboard: mini gráfico de barras con tendencia al alza. */
export function DashboardIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="dashBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#dashBlob)" />
      <ellipse cx="32" cy="49" rx="14" ry="2.6" fill={palette.mango700} opacity={0.14} />

      <rect x="15" y="34" width="8" height="14" rx="2" fill={palette.mango500} />
      <rect x="28" y="26" width="8" height="22" rx="2" fill={palette.zipp500} />
      <rect x="41" y="19" width="8" height="29" rx="2" fill={palette.lima600} />

      <path
        d="M16 25 L27 17 L36 22 L49 10"
        stroke={palette.ink700}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="49" cy="10" r="2.6" fill={palette.ink700} />
    </svg>
  );
}
