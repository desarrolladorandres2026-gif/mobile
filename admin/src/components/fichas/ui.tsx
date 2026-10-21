import type { ReactNode } from 'react';

/**
 * Piezas de lectura compartidas por las fichas de pedido y de comercio.
 * Sin cajas: se separa con una línea fina, espacio y tipografía.
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
 return (
 <section className="space-y-3 border-t border-[var(--color-border)] py-3">
 <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">{title}</h3>
 {children}
 </section>
 );
}

export function Sub({ title, empty, children }: { title: string; empty?: string; children?: ReactNode }) {
 return (
 <div className="space-y-2">
 <p className="text-xs font-semibold text-[var(--color-text-main)]">{title}</p>
 {children ?? <p className="text-[var(--color-text-main)]">{empty ?? 'Nada por aquí.'}</p>}
 </div>
 );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
 return (
 <div className="min-w-0">
 <p className="text-xs text-[var(--color-text-secondary)]">{label}</p>
 <p className="truncate text-sm font-semibold text-[var(--color-text-main)]">{value || '–'}</p>
 </div>
 );
}

export function Row({ left, right }: { left: ReactNode; right?: ReactNode }) {
 return (
 <li className="flex justify-between gap-3">
 <span className="min-w-0 text-[var(--color-text-main)]">{left}</span>
 {right !== undefined && (
 <span className="shrink-0 font-semibold text-[var(--color-text-main)]">{right}</span>
 )}
 </li>
 );
}

export function ErrorLine({ children }: { children: ReactNode }) {
 return (
 <p className="font-semibold text-[var(--color-danger)]">
 <span className="min-w-0">{children}</span>
 </p>
 );
}

/**
 * Cuadrícula de datos de las fichas: mismo `data-grid` que el listado de
 * Pedidos. `Facts` es una fila de encabezados sobre una fila de valores;
 * `Grid` es una tabla con varias filas.
 */
export function Facts({ title, items }: { title: string; items: Array<[string, ReactNode]> }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">{title}</h3>
      <div className="table-container">
        <div className="overflow-x-auto">
          <table className="data-grid">
            <thead>
              <tr className="text-left">
                {items.map(([label]) => (
                  <th key={label} className="table-header-cell">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {items.map(([label, value]) => (
                  <td key={label} className="wrap">{value || '–'}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Grid({
  title,
  head,
  rows,
  empty,
  right = [],
}: {
  title: string;
  head: string[];
  rows: ReactNode[][];
  empty: string;
  /** Índices de columnas alineadas a la derecha (importes). */
  right?: number[];
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">{title}</h3>
      <div className="table-container">
        <div className="overflow-x-auto">
          <table className="data-grid">
            <thead>
              <tr className="text-left">
                {head.map((h, i) => (
                  <th key={h} className={`table-header-cell ${right.includes(i) ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={head.length} className="wrap">{empty}</td>
                </tr>
              ) : (
                rows.map((cells, r) =>
                  cells.length === 1 ? (
                    <tr key={r}>
                      <td colSpan={head.length} className="section-row">{cells[0]}</td>
                    </tr>
                  ) : (
                    <tr key={r}>
                      {cells.map((c, i) => (
                        <td key={i} className={`wrap ${right.includes(i) ? 'text-right' : ''}`}>{c}</td>
                      ))}
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** Botón de acción de la ficha: secundario, sin relleno. */
export const actionButtonClass = 'btn btn-secondary';

export const primaryButtonClass = 'btn btn-primary';

export const secondaryButtonClass = 'btn btn-secondary';

export const inputClass = 'field';

export const fieldLabelClass = 'field-label';
