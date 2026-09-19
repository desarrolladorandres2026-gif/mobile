/**
 * La Z de Zipp es una ruta, no una letra.
 *
 * Un trazo continuo sale arriba a la izquierda —el negocio— baja en diagonal
 * y termina en un punto lima abajo a la derecha: el destino. Es la misma
 * marca que dibuja la app móvil (mobile/components/brand/ZippLogo.tsx) y los
 * paneles admin/business, para que todo el producto se lea como uno solo.
 */
export function ZippMark({
  size = 32,
  className = '',
  mono,
}: {
  size?: number;
  className?: string;
  /** Un solo color, para contextos monocromos. */
  mono?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 13 H36 L12 35 H36"
        stroke={mono ?? '#E5B242'}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx={36} cy={35} r={5} fill={mono ?? '#F3CE72'} />
    </svg>
  );
}

/** Logotipo oficial ZIPP con coronita en oro cepillado de alta gama. */
export function ZippWordmark({
  size = 32,
  showMark = false,
  className = '',
}: {
  size?: number;
  /** Mostrar el trazo / pin junto al nombre */
  showMark?: boolean;
  className?: string;
  /** Para fondos oscuros */
  dark?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`}>
      {showMark && <ZippMark size={size} />}
      <img
        src="/zipp-crown-logo.webp"
        alt="ZIPP"
        style={{ height: size * 1.05 }}
        className="w-auto object-contain select-none drop-shadow-xs"
      />
    </div>
  );
}
