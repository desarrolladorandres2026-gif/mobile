import { Link } from 'react-router-dom';
import type { SummaryItem } from './SummaryGrid';

/**
 * Cifras grandes que se reparten todo el alto y el ancho disponibles.
 *
 * Es la versión de pantalla completa de `SummaryGrid`: el resumen del día del
 * personal se mira de pie, a un par de metros del mostrador, y una tabla de
 * letra pequeña arriba con el resto en blanco no sirve para eso. Sin cajas:
 * solo tipografía grande, sin cuadrículas ni líneas entre cifras. Una cifra con `to` es un
 * enlace a la pantalla donde se actúa sobre ella.
 */
export default function BigStats({ items }: { items: SummaryItem[] }) {
  return (
    <ul
      className="grid flex-1"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(9rem, 100%), 1fr))` }}
    >
      {items.map((item) => {
        const tone = item.alert
          ? 'text-[var(--color-danger)]'
          : item.strong
            ? 'text-[var(--color-primary)]'
            : 'text-[var(--color-text-main)]';
        const content = (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">{item.label}</span>
            {item.loading ? (
              <span className="block h-10 w-28 rounded bg-[var(--color-bg-alt)] animate-pulse" />
            ) : (
              <span className={`block truncate text-3xl sm:text-5xl font-semibold tabular leading-tight ${tone}`}>{item.value}</span>
            )}
            {item.hint ? <span className="block text-xs sm:text-sm text-[var(--color-text-secondary)]">{item.hint}</span> : null}
          </>
        );
        const cell = 'flex h-full min-w-0 flex-col justify-center gap-1 px-4 py-6 sm:px-6';
        return (
          <li key={item.label} className="min-w-0">
            {item.to ? (
              <Link to={item.to} className={`${cell} transition-colors hover:bg-[var(--color-surface-hover)]`}>
                {content}
              </Link>
            ) : (
              <div className={cell}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
