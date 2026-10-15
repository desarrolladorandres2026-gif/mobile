import { Link } from 'react-router-dom';
import type { SummaryItem } from './SummaryGrid';

/**
 * Cifras del resumen del día en el diseño de la orden de pedido: cabecera
 * blanca con las etiquetas y, debajo, una fila con las cifras. Se mira de pie
 * en el mostrador, así que la cifra va grande. Una cifra con `to` es un enlace
 * a la pantalla donde se actúa sobre ella.
 */
export default function BigStats({ items }: { items: SummaryItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-[var(--color-text-main)]">
            {items.map((item) => (
              <th key={item.label} className="whitespace-nowrap px-4 py-2.5 text-xs font-bold uppercase tracking-wide">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {items.map((item) => {
              const tone = item.alert ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]';
              const content = (
                <>
                  {item.loading ? (
                    <span className="block h-7 w-20 animate-pulse rounded bg-[var(--color-bg-alt)]" />
                  ) : (
                    <span className={`block text-xl font-bold tabular leading-tight sm:text-2xl ${tone}`}>{item.value}</span>
                  )}
                  {item.hint ? <span className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">{item.hint}</span> : null}
                </>
              );
              return (
                <td key={item.label} className="align-top">
                  {item.to ? (
                    <Link to={item.to} className="block px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
                      {content}
                    </Link>
                  ) : (
                    <div className="px-4 py-3">{content}</div>
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
