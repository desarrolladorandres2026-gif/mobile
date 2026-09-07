import { palette } from './palette';

/**
 * Roles: mini llave — el permiso de acceso que un Rol otorga.
 */
export function RolesIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="rolBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.zipp100} />
          <stop offset="1" stopColor={palette.zipp400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="rolKey" x1="14" y1="18" x2="48" y2="48">
          <stop offset="0" stopColor={palette.mango500} />
          <stop offset="1" stopColor={palette.mango700} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#rolBlob)" />
      <ellipse cx="32" cy="49" rx="13" ry="3" fill={palette.zipp700} opacity={0.12} />

      <circle cx="24" cy="24" r="9" fill="none" stroke="url(#rolKey)" strokeWidth={4.5} />
      <path d="M30 30 L46 46 M40 40 L44 36 M44 44 L48 40" stroke="url(#rolKey)" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
