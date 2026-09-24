import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

/**
 * Paginación numerada para listados del panel de negocio.
 *
 * Copia exacta de `admin/src/components/Pagination.tsx`: mismo diseño,
 * mismos tokens `var(--color-*)` (business/ usa la misma paleta que
 * admin/). Antes cada tabla traía una sola página de hasta 100 filas y se
 * quedaba ahí para siempre: en cuanto un negocio muy activo pasaba de
 * eso, el resto de pedidos simplemente dejaba de aparecer, sin ningún
 * aviso. El backend ya paginaba correctamente (`page`, `limit`,
 * `meta.total`) — lo que faltaba era que la UI lo usara.
 */
export default function Pagination({ page, totalPages, total, limit, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  // Máximo 5 números visibles, centrados en la página actual.
  const pages: number[] = [];
  let start = Math.max(1, page - 2);
  const end = Math.min(totalPages, start + 4);
  start = Math.max(1, end - 4);
  for (let p = start; p <= end; p++) pages.push(p);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border-light)]">
      <p className="text-[11px] text-[var(--color-text-muted)] font-medium">
        Mostrando <span className="font-bold text-[var(--color-text-secondary)]">{from}-{to}</span> de{' '}
        <span className="font-bold text-[var(--color-text-secondary)]">{total}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        {start > 1 && <span className="text-[11px] text-[var(--color-text-muted)] px-1">…</span>}
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`min-w-[28px] h-7 px-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
              p === page
                ? 'bg-[var(--color-primary)] text-white shadow-xs'
                : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)]'
            }`}
          >
            {p}
          </button>
        ))}
        {end < totalPages && <span className="text-[11px] text-[var(--color-text-muted)] px-1">…</span>}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
