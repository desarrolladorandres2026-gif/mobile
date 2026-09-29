import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, day } from '../lib/drivers';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Comisiones por pedido entregado.
 *
 * Una fila por pedido: lo que se queda ZIPP, lo que le toca al comercio y al
 * domiciliario. Pasa a"Liquidada" cuando ya no queda ningún pago del pedido
 * por saldar (el del comercio y el del domiciliario). Los totales de arriba
 * son de todo el filtro, no de la página.
 *
 * No es el resultado de ZIPP: eso lo da el libro mayor en Finanzas, que
 * además descuenta promociones y devoluciones. Esto es el desglose bruto.
 */

interface CommissionRow {
 _id: string;
 status: 'pending' | 'settled';
 platformAmount: number;
 businessAmount: number;
 driverAmount: number;
 settledAt?: string | null;
 createdAt: string;
 orderId?: { _id: string; orderNumber?: string; total?: number } | null;
 businessId?: { _id: string; name?: string } | null;
}

type Totals = Record<'pending' | 'settled', { count: number; platformAmount: number; businessAmount: number; driverAmount: number }>;

const EMPTY = { count: 0, platformAmount: 0, businessAmount: 0, driverAmount: 0 };

export default function Commissions() {
 const [status, setStatus] = useState<'' | 'pending' | 'settled'>('');
 const [items, setItems] = useState<CommissionRow[]>([]);
 const [totals, setTotals] = useState<Partial<Totals>>({});
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 const { data } = await api.get('/admin/commissions', {
 params: { page, limit: 25, ...(status ? { status } : {}) },
 });
 setItems(data.data?.items ?? []);
 setTotals(data.data?.totals ?? {});
 setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las comisiones.'));
 } finally {
 setLoading(false);
 }
 }, [page, status]);

 useEffect(() => {
 load();
 }, [load]);

 const pending = totals.pending ?? EMPTY;
 const settled = totals.settled ?? EMPTY;

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Comisiones</h1>
 <p className="page-subtitle">Desglose bruto de cada pedido entregado: ZIPP, comercio y domiciliario</p>
 </div>
 <select
 value={status}
 onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}
 aria-label="Estado"
 className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <option value="">Todas</option>
 <option value="pending">Por liquidar</option>
 <option value="settled">Liquidadas</option>
 </select>
 </div>

 <SummaryGrid
 items={[
 { label: 'Comisión por liquidar', value: money(pending.platformAmount), sub: `${pending.count} pedidos` },
 { label: 'Comisión liquidada', value: money(settled.platformAmount), sub: `${settled.count} pedidos` },
 { label: 'Comercios por liquidar', value: money(pending.businessAmount), sub: 'lo que se les debe por estos pedidos' },
 { label: 'Domiciliarios por liquidar', value: money(pending.driverAmount), sub: 'lo que se les debe por estos pedidos' },
 ]}
 />

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">No hay comisiones con este filtro.</p>
 ) : (
 <>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Pedido</th>
 <th className="table-header-cell">Negocio</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Total</th>
 <th className="table-header-cell">Comercio</th>
 <th className="table-header-cell">Domiciliario</th>
 <th className="table-header-cell">Comisión ZIPP</th>
 <th className="table-header-cell">Estado</th>
 </tr>
 </thead>
 <tbody>
 {items.map((c) => (
 <tr key={c._id}>
 <td className="table-body-cell">
 <EntityLink type="order" id={c.orderId?._id}>#{c.orderId?.orderNumber ?? 'N/A'}</EntityLink>
 </td>
 <td className="table-body-cell">
 <EntityLink type="business" id={c.businessId?._id}>{c.businessId?.name ?? ''}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(c.createdAt)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(c.orderId?.total)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(c.businessAmount)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(c.driverAmount)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(c.platformAmount)}</td>
 <td className={`table-body-cell ${c.status === 'settled' ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`}>
 {c.status === 'settled' ? `Liquidada ${day(c.settledAt ?? undefined)}` : 'Por liquidar'}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}
 </div>
 );
}
