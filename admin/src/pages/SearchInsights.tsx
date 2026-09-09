import { useEffect, useState } from 'react';
import { Search, TrendingUp, SearchX, AlertCircle, RefreshCw } from 'lucide-react';
import api from '../services/api';

/**
 * Qué busca la gente en la app y, sobre todo, qué busca sin encontrarlo.
 *
 * La segunda tabla es la que justifica esta pantalla: cada término sin
 * resultados es alguien que quiso comprar algo que Zipp no tiene. Es la
 * lista priorizada de qué comercios salir a captar, y nadie más la tiene —
 * el cliente que no encuentra nada se va sin decírselo a nadie.
 */

interface TermRow {
  term: string;
  count: number;
}

interface EmptyRow extends TermRow {
  lastAt: string;
}

interface Insights {
  top: TermRow[];
  empty: EmptyRow[];
  days: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SearchInsights() {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchAll = async () => {
    try {
      setLoading(true);
      setError('');
      const { data: body } = await api.get('/search/insights');
      setData(body.data);
    } catch (err) {
      console.error(err);
      setError('No se pudieron cargar las búsquedas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const days = data?.days ?? 30;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[var(--color-text-main)] flex items-center gap-2">
            <Search className="w-5 h-5 text-[var(--color-primary)]" />
            Búsquedas
          </h1>
          <p className="mt-1 text-xs font-medium text-[var(--color-text-secondary)]">
            Lo que la gente escribió en la app durante los últimos {days} días.
          </p>
        </div>
        <button
          onClick={fetchAll}
          className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Actualizar
        </button>
      </div>

      {error ? (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando búsquedas…
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* ── Lo que sí se encuentra ── */}
          <section className="space-y-3">
            <header className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">
                Lo más buscado
              </h2>
            </header>
            <p className="text-[11px] font-medium text-[var(--color-text-muted)]">
              Alimenta las sugerencias de la pantalla de búsqueda en la app.
            </p>

            <div className="table-container overflow-x-auto">
              <table className="w-full min-w-[380px]">
                <thead>
                  <tr className="border-b border-[var(--color-border-light)]">
                    <th className="table-header-cell">Término</th>
                    <th className="table-header-cell text-right">Búsquedas</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.top.length ? (
                    data.top.map((row) => (
                      <tr
                        key={row.term}
                        className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-bg)] transition-colors"
                      >
                        <td className="px-4 py-3 text-xs font-semibold text-[var(--color-text-main)]">
                          {row.term}
                        </td>
                        <td className="px-4 py-3 text-xs font-bold text-right text-[var(--color-text-secondary)]">
                          {row.count}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={2}
                        className="px-4 py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]"
                      >
                        Todavía no hay búsquedas registradas.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Lo que falta en el catálogo ── */}
          <section className="space-y-3">
            <header className="flex items-center gap-2">
              <SearchX className="w-4 h-4 text-[var(--color-danger)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">
                Buscado y no encontrado
              </h2>
            </header>
            <p className="text-[11px] font-medium text-[var(--color-text-muted)]">
              Cada línea es una venta que se perdió. Ordenado por cuánta gente lo pidió:
              es la lista de qué comercios o productos hacen falta.
            </p>

            <div className="table-container overflow-x-auto">
              <table className="w-full min-w-[440px]">
                <thead>
                  <tr className="border-b border-[var(--color-border-light)]">
                    <th className="table-header-cell">Término</th>
                    <th className="table-header-cell text-right">Veces</th>
                    <th className="table-header-cell text-right">Última vez</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.empty.length ? (
                    data.empty.map((row) => (
                      <tr
                        key={row.term}
                        className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-bg)] transition-colors"
                      >
                        <td className="px-4 py-3 text-xs font-semibold text-[var(--color-text-main)]">
                          {row.term}
                        </td>
                        <td className="px-4 py-3 text-xs font-bold text-right text-[var(--color-danger)]">
                          {row.count}
                        </td>
                        <td className="px-4 py-3 text-[11px] font-medium text-right text-[var(--color-text-muted)] whitespace-nowrap">
                          {formatDate(row.lastAt)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]"
                      >
                        Nadie se ha ido con las manos vacías. Por ahora.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
