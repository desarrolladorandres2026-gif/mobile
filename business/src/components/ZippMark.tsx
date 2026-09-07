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
        stroke={mono ?? 'var(--color-primary)'}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx={36} cy={35} r={5} fill={mono ?? 'var(--color-accent)'} />
    </svg>
  );
}

/** Marca + nombre. En minúsculas y muy apretado: es un logotipo, no un título. */
export function ZippWordmark({
  size = 28,
  label,
}: {
  size?: number;
  /** Qué panel es: "Admin", "Negocios". */
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <ZippMark size={size} />
      <div className="min-w-0 leading-none">
        <span
          className="font-display text-text block leading-none"
          style={{ fontSize: size * 0.78, letterSpacing: '-0.05em', fontWeight: 800 }}
        >
          zipp
        </span>
        {label ? (
          <span className="text-[9px] text-text-muted font-bold tracking-[0.18em] uppercase block mt-1">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

