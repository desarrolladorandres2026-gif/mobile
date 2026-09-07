import { palette } from './palette';

/** Categorías de inicio: mini grilla de fichas de color. */
export function CategoriesIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="catGridBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#catGridBlob)" />
      <ellipse cx="32" cy="49" rx="14" ry="2.6" fill={palette.mango700} opacity={0.14} />

      <rect x="16" y="16" width="13" height="13" rx="4" fill={palette.mango500} />
      <rect x="35" y="16" width="13" height="13" rx="4" fill={palette.zipp500} />
      <rect x="16" y="35" width="13" height="13" rx="4" fill={palette.lima600} />
      <rect x="35" y="35" width="13" height="13" rx="4" fill={palette.cereza500} />
    </svg>
  );
}
