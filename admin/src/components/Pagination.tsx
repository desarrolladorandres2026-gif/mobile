interface PaginationProps {
 page: number;
 totalPages: number;
 total: number;
 limit: number;
 onPageChange: (page: number) => void;
}

const fmt = (n: number) => n.toLocaleString('es-CO');

/**
 * Paginación numerada para listados de admin.
 *
 * Antes cada tabla traía una sola página de hasta 100-200 filas y se
 * quedaba ahí para siempre: en cuanto el negocio crecía más allá de eso,
 * el resto de usuarios/negocios/pedidos simplemente dejaba de aparecer,
 * sin ningún aviso. El backend ya paginaba correctamente (`page`, `limit`,
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
 <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-2 py-1 border-t border-[var(--color-border)]">
 <p className="text-xs text-[var(--color-text-main)]">
 {fmt(from)}–{fmt(to)} de {fmt(total)}
 </p>
 <div className="flex items-center gap-1">
 <button
 onClick={() => onPageChange(page - 1)}
 disabled={page <= 1}
 className="btn btn-text"
 >
 Anterior
 </button>
 {start > 1 && <span className="text-xs text-[var(--color-text-main)] px-1">…</span>}
 {pages.map((p) => (
 <button
 key={p}
 onClick={() => onPageChange(p)}
 aria-current={p === page ? 'page' : undefined}
 className={`min-w-6 px-1 text-xs cursor-pointer hover:underline ${
 p === page
 ? 'font-semibold text-[var(--color-text-main)] underline decoration-2 underline-offset-4 decoration-[var(--accent-fill)]'
 : 'font-normal text-[var(--color-text-main)]'
 }`}
 >
 {fmt(p)}
 </button>
 ))}
 {end < totalPages && <span className="text-xs text-[var(--color-text-main)] px-1">…</span>}
 <button
 onClick={() => onPageChange(page + 1)}
 disabled={page >= totalPages}
 className="btn btn-text"
 >
 Siguiente
 </button>
 </div>
 </div>
 );
}
