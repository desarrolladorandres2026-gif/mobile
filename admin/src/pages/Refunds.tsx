import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, dateTime } from '../lib/drivers';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Bandeja de reembolsos y contracargos de toda la plataforma.
 *
 * Solo se lee aquí. Decidir un reembolso se hace mirando el pedido (quién
 * pidió, qué pagó, qué salió mal), así que cada fila abre la ficha del pedido,
 * donde vive el formulario de reembolso,"hecho por fuera" y contracargo.
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
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {t.text}{t.count ? ` (${t.count})` : ''}
 </button>
 ))}
 </div>
 </div>

 {totals && (
 <SummaryGrid
 items={[
 { label: 'Devuelto', value: money(totals.completed.amount), sub: `${totals.completed.count} ${totals.completed.count === 1 ? 'registro' : 'registros'}` },
 { label: 'Contracargos', value: money(totals.chargebacks.amount), tone: 'warning', sub: `${totals.chargebacks.count} ${totals.chargebacks.count === 1 ? 'registro' : 'registros'}` },
 { label: 'Fallidos', value: money(totals.failed.amount), tone: 'danger', sub: `${totals.failed.count} ${totals.failed.count === 1 ? 'registro' : 'registros'}` },
 { label: 'En curso', value: money(totals.pending.amount), sub: `${totals.pending.count} ${totals.pending.count === 1 ? 'registro' : 'registros'}` },
 ]}
 />
 )}

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">
 {filter === 'attention' ? 'Nada requiere atención: no hay reembolsos fallidos ni trabados.' : 'No hay registros con este filtro.'}
 </p>
 ) : (
 <>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Pedido</th>
 <th className="table-header-cell">Negocio</th>
 <th className="table-header-cell">Tipo</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Motivo</th>
 <th className="table-header-cell">Transacción</th>
 <th className="table-header-cell">Comercio asume</th>
 <th className="table-header-cell">Comisión asume</th>
 <th className="table-header-cell">ZIPP asume</th>
 <th className="table-header-cell">Monto</th>
 <th className="table-header-cell">Estado</th>
 </tr>
 </thead>
 <tbody>
 {items.map((r) => (
 <tr key={r._id}>
 <td className="table-body-cell">
 <EntityLink type="order" id={r.orderId}>#{r.orderNumber ?? 'N/A'}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.businessName ?? '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{KIND_LABEL[r.kind]}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{dateTime(r.createdAt)}</td>
 <td className="table-body-cell wrap text-[var(--color-text-main)]">{r.reason}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.transactionId ?? '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.status === 'completed' ? money(r.allocation.fromMerchantPayout) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.status === 'completed' ? money(r.allocation.fromCommission) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.status === 'completed' ? money(r.allocation.fromPlatform) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(r.amount)}</td>
 <td className={`table-body-cell ${STATUS[r.status].className}`}>{STATUS[r.status].text}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 {items.some((r) => r.status === 'failed') && (
 <p className="text-xs font-semibold text-[var(--color-danger)]">
 Los reembolsos fallidos no devolvieron el dinero. Abre el pedido y repítelo, o regístralo como "Hecho por fuera" si ya lo devolviste en Wompi.
 </p>
 )}
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}
 </div>
 );
}
