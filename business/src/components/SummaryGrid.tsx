import type { ReactNode } from 'react';

export interface SummaryItem {
  label: string;
  value: ReactNode;
  /** Línea secundaria bajo el valor (p. ej. "12 ventas"). */
  hint?: ReactNode;
  /** Muestra un marcador de carga en lugar del valor. */
  loading?: boolean;
  /** Valor en dorado, para la cifra principal. */
  strong?: boolean;
}

/**
 * Resumen en cuadrícula: una fila de encabezados y una de valores, con la misma
 * tipografía que el resto de tablas. Sustituye a los números grandes sueltos.
 */
export default function SummaryGrid({ items }: { items: SummaryItem[] }) {
  return (
    <div className="table-container">
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              {items.map((k) => (
                <th key={k.label} className="table-header-cell">{k.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {items.map((k) => (
                <td key={k.label} className="table-body-cell align-top">
                  {k.loading ? (
                    <span className="block h-4 w-24 rounded bg-[var(--color-bg-alt)] animate-pulse" />
                  ) : (
                    <p className={`text-sm font-semibold tabular ${k.strong ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-main)]'}`}>
                      {k.value}
                    </p>
                  )}
                  {k.hint ? <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{k.hint}</p> : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
