import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, dateTime } from '../lib/drivers';

/**
 * Bandeja de reembolsos y contracargos de toda la plataforma.
 *
 * Solo se lee aquí. Decidir un reembolso se hace mirando el pedido (quién
 * pidió, qué pagó, qué salió mal), así que cada fila abre la ficha del pedido,
 * donde vive el formulario de reembolso, "hecho por fuera" y contracargo.
 */

interface RefundRow {
  _id: string;
  orderId: string | null;
  orderNumber: string | null;
  businessName: string | null;
  kind: 'full' | 'partial' | 'chargeback' | 'external';
  status: 'pending' | 'completed' | 'failed';
  amount: number;
  reason: string;
  transactionId: string | null;
  allocation: {
    fromMerchantPayout: number;
    fromDriverPayout: number;
    fromCommission: number;
    fromPlatform: number;
  };
  createdAt: string;
}

interface Totals {
  chargebacks: { count: number; amount: number };
  failed: { count: number; amount: number };
  pending: { count: number; amount: number };
  completed: { count: number; amount: number };
}

const KIND_LABEL: Record<RefundRow['kind'], string> = {
  full: 'Total',
  partial: 'Parcial',
  chargeback: 'Contracargo',
  external: 'Hecho por fuera',
};

const STATUS: Record<RefundRow['status'], { text: string; className: string }> = {
  completed: { text: 'Completado', className: 'text-[var(--color-success)]' },
  pending: { text: 'En curso', className: 'text-[var(--color-warning)]' },
  failed: { text: 'Falló', className: 'text-[var(--color-danger)]' },
};

type Filter = 'attention' | 'chargeback' | 'all';

export default function Refunds() {
  const [filter, setFilter] = useState<Filter>('attention');
  const [items, setItems] = useState<RefundRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/payments/refunds', {
        params: {
          page,
          limit: 25,
          ...(filter === 'attention' ? { attention: 'true' } : {}),
          ...(filter === 'chargeback' ? { kind: 'chargeback' } : {}),
        },
      });
      setItems(data.data?.items ?? []);
      setTotals(data.data?.totals ?? null);
      setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar los reembolsos.'));
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const tabs: Array<{ id: Filter; text: string; count?: number }> = [
    { id: 'attention', text: 'Requieren atención', count: totals ? totals.failed.count : undefined },
    { id: 'chargeback', text: 'Contracargos', count: totals?.chargebacks.count },
    { id: 'all', text: 'Todos' },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reembolsos y contracargos</h1>
          <p className="page-subtitle">Lo devuelto a clientes, lo que la pasarela reversó y lo que falló</p>
        </div>
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => { setFilter(t.id); setPage(1); }}
              className={`cursor-pointer border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all ${
                filter === t.id
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
              }`}
            >
              {t.text}{t.count ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-4 border-b border-[var(--color-border-light)] pb-4 lg:grid-cols-4">
          {[
            { label: 'Devuelto', value: totals.completed, color: 'text-[var(--color-text-main)]' },
            { label: 'Contracargos', value: totals.chargebacks, color: 'text-[var(--color-warning)]' },
            { label: 'Fallidos', value: totals.failed, color: 'text-[var(--color-danger)]' },
            { label: 'En curso', value: totals.pending, color: 'text-[var(--color-text-secondary)]' },
          ].map((k) => (
            <div key={k.label}>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{k.label}</p>
              <p className={`kpi-value mt-1 text-xl ${k.color}`}>{money(k.value.amount)}</p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{k.value.count} {k.value.count === 1 ? 'registro' : 'registros'}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {loading ? (
        <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-xs text-[var(--color-text-muted)]">
          {filter === 'attention' ? 'Nada requiere atención: no hay reembolsos fallidos ni trabados.' : 'No hay registros con este filtro.'}
        </p>
      ) : (
        <>
          <div className="divide-y divide-[var(--color-border-light)]">
            {items.map((r) => (
              <div key={r._id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--color-text-main)]">
                    <EntityLink type="order" id={r.orderId}>
                      Pedido #{r.orderNumber ?? 'N/A'}
                    </EntityLink>
                    <span className="ml-2 text-xs font-normal text-[var(--color-text-secondary)]">{r.businessName}</span>
                  </p>
                  <p className="break-words text-[11px] text-[var(--color-text-secondary)]">{r.reason}</p>
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    {KIND_LABEL[r.kind]} · {dateTime(r.createdAt)}
                    {r.transactionId ? ` · ${r.transactionId}` : ''}
                  </p>
                  {r.status === 'completed' && (
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      Lo asumió: comercio {money(r.allocation.fromMerchantPayout)} · comisión {money(r.allocation.fromCommission)} · ZIPP {money(r.allocation.fromPlatform)}
                    </p>
                  )}
                  {r.status === 'failed' && (
                    <p className="text-[11px] font-semibold text-[var(--color-danger)]">
                      No se devolvió el dinero. Abre el pedido y repítelo, o regístralo como "Hecho por fuera" si ya lo devolviste en Wompi.
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-[var(--color-text-main)]">{money(r.amount)}</p>
                  <p className={`text-[10px] font-bold uppercase tracking-wider ${STATUS[r.status].className}`}>{STATUS[r.status].text}</p>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
