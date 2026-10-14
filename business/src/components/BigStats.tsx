import { Link } from 'react-router-dom';
import type { SummaryItem } from './SummaryGrid';

/**
 * Cifras legibles de un vistazo, en filas compactas.
 *
 * Es la versión de mostrador de `SummaryGrid`: el resumen del día del personal
 * se mira de pie, así que la cifra es más grande que en una tabla, pero sin
 * estirarse a toda la pantalla: ocupa lo que necesita y deja que la página
 * agrupe secciones lado a lado. Sin cajas: solo tipografía, sin cuadrículas ni
 * líneas entre cifras. Una cifra con `to` es un enlace a la pantalla donde se
 * actúa sobre ella.
 */
export default function BigStats({ items }: { items: SummaryItem[] }) {
  return (
    <ul
      className="grid"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(8rem, 100%), 1fr))` }}
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
              <span className="block h-7 w-20 rounded bg-[var(--color-bg-alt)] animate-pulse" />
            ) : (
              <span className={`block truncate text-xl sm:text-2xl font-semibold tabular leading-tight ${tone}`}>{item.value}</span>
            )}
            {item.hint ? <span className="block text-xs text-[var(--color-text-secondary)]">{item.hint}</span> : null}
          </>
        );
        const cell = 'flex h-full min-w-0 flex-col gap-0.5 py-2 pr-4';
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
