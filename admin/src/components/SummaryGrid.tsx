import type { ReactNode } from 'react';

export interface SummaryItem {
  label: string;
  value: ReactNode;
  /** Línea secundaria bajo el valor (p. ej. "12 pedidos"). */
  sub?: ReactNode;
  /** Color del valor; por defecto tinta. */
  tone?: 'warning' | 'danger';
}

const TONE = {
  warning: 'text-[var(--color-text-main)]',
  danger: 'text-[var(--color-danger)]',
} as const;

/**
 * Resumen en cuadrícula: una fila de encabezados y una de valores, con la misma
 * tipografía que el resto de tablas. Sustituye a los números grandes sueltos.
 */
export default function SummaryGrid({ items }: { items: SummaryItem[] }) {
  return (
    <div className="table-container">
      <div className="overflow-x-auto">
        <table className="data-grid">
          <thead>
            <tr className="text-left">
              {items.map((k) => (
                <th key={k.label} className="table-header-cell">{k.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {items.map((k) => (
                <td key={k.label} className="wrap">
                  <p className={`text-sm font-bold ${k.tone ? TONE[k.tone] : 'text-[var(--color-text-main)]'}`}>{k.value}</p>
                  {k.sub != null && <p className="mt-0.5 text-xs text-[var(--color-text-main)]">{k.sub}</p>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
