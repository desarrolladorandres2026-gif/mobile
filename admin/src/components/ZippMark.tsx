/**
 * La Z de Zipp es una ruta, no una letra.
 *
 * Un trazo continuo sale arriba a la izquierda —el negocio— baja en diagonal
 * y termina en un punto lima abajo a la derecha: el destino. Es la misma
 * marca que dibuja la app móvil (mobile/components/brand/ZippLogo.tsx), para
 * que el panel y la app se lean como un solo producto.
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
  label,
  showMark = false,
}: {
  size?: number;
  /** Qué panel es: "Admin", "Negocios". */
  label?: string;
  showMark?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      {showMark && <ZippMark size={size} />}
      <div className="min-w-0 leading-none flex items-center gap-2">
        <img
          src="/zipp-crown-logo.webp"
          alt="ZIPP"
          style={{ height: size * 1.05 }}
          className="w-auto object-contain select-none"
        />
        {label ? (
          <span className="text-[10px] text-primary-light font-bold tracking-[0.14em] uppercase px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

