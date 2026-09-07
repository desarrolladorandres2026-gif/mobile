import { palette } from './palette';

/** Clientes: mini dúo de perfiles superpuestos, mismo blob y luz del set. */
export function PeopleIllustration({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="pplBlob" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0" stopColor={palette.mango100} />
          <stop offset="1" stopColor={palette.mango400} stopOpacity={0.35} />
        </linearGradient>
        <linearGradient id="pplBack" x1="32" y1="18" x2="52" y2="48">
          <stop offset="0" stopColor={palette.mango400} />
          <stop offset="1" stopColor={palette.mango500} />
        </linearGradient>
        <linearGradient id="pplFront" x1="12" y1="20" x2="38" y2="50">
          <stop offset="0" stopColor={palette.zipp400} />
          <stop offset="1" stopColor={palette.zipp500} />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="28" fill="url(#pplBlob)" />
      <ellipse cx="30" cy="49" rx="15" ry="3" fill={palette.mango700} opacity={0.14} />

      {/* perfil de atrás, dorado */}
      <circle cx="41" cy="24" r="6.5" fill={palette.mango400} />
      <path d="M30 48 C30 39.3 35 34.5 41 34.5 C47 34.5 52 39.3 52 48 Z" fill="url(#pplBack)" />

      {/* perfil de adelante, azul, separado con un trazo blanco */}
      <circle cx="24" cy="27" r="7.5" fill="url(#pplFront)" stroke={palette.paper0} strokeWidth={2} />
      <path
        d="M12 49.5 C12 39.7 18 34 24 34 C30 34 36 39.7 36 49.5 Z"
        fill="url(#pplFront)"
        stroke={palette.paper0}
        strokeWidth={2}
      />
    </svg>
  );
}
