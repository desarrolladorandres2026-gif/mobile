import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, dateTime } from '../lib/drivers';

/**
 * Pagos en línea (Wompi): el listado por estado y método, y la conciliación
 * diaria contra los desembolsos.
 *
 * La comisión por fila es la **estimada con la tarifa vigente** (Tarifas y
 * Precios). La conciliación separa lo que se asentó en el libro el día de
 * cada cobro de lo que Wompi debería depositar: si el depósito real difiere,
 * o la tarifa está mal o Wompi no liquidó algún cobro.
 */

interface PaymentRow {
 _id: string;
 orderId: string | null;
 orderNumber: string | null;
 type: string;
 status: 'pending' | 'paid' | 'refunded' | 'failed';
 methodType: string | null;
 amount: number;
 estimatedFee: number;
 reference: string | null;
 createdAt: string;
}

interface DailyRow {
 date: string;
 count: number;
 gross: number;
 bookedFee: number;
 expectedDeposit: number;
 byMethod: Record<string, { count: number; amount: number }>;
}

interface Daily {
 items: DailyRow[];
 totals: { count: number; gross: number; bookedFee: number; expectedDeposit: number };
 feeConfigured: boolean;
}

const STATUS_LABEL: Record<PaymentRow['status'], { text: string; className: string }> = {
 paid: { text: 'Aprobado', className: 'text-[var(--color-success)]' },
 refunded: { text: 'Reembolsado', className: 'text-[var(--color-text-main)]' },
 pending: { text: 'Pendiente', className: 'text-[var(--color-text-main)]' },
 failed: { text: 'Fallido', className: 'text-[var(--color-danger)]' },
};

const METHOD_LABEL: Record<string, string> = { card: 'Tarjeta', pse: 'PSE', nequi: 'Nequi', other: 'Otros' };

type Tab = 'payments' | 'daily';

export default function Payments() {
 const [tab, setTab] = useState<Tab>('payments');
 const [status, setStatus] = useState('');
 const [methodType, setMethodType] = useState('');
 const [items, setItems] = useState<PaymentRow[]>([]);
 const [totals, setTotals] = useState<Record<string, { count: number; amount: number }>>({});
 const [daily, setDaily] = useState<Daily | null>(null);
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 if (tab === 'payments') {
 const { data } = await api.get('/finance/payments', {
 params: { page, limit: 25, ...(status ? { status } : {}), ...(methodType ? { methodType } : {}) },
 });
 setItems(data.data?.items ?? []);
 setTotals(data.data?.totals ?? {});
 setMeta(data.meta ?? { total: 0, totalPages: 1, limit: 25 });
 } else {
 const { data } = await api.get('/finance/payments/daily');
 setDaily(data.data);
 }
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los pagos.'));
 } finally {
 setLoading(false);
 }
 }, [tab, page, status, methodType]);

 useEffect(() => {
 load();
 }, [load]);

 const select =
 'h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs font-semibold text-[var(--color-text-main)]';

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Pagos en línea</h1>
 <p className="page-subtitle">Cobros de Wompi por estado y método, y la conciliación diaria contra sus desembolsos</p>
 </div>
 <div className="flex gap-1">
 {(['payments', 'daily'] as const).map((t) => (
 <button
 key={t}
 onClick={() => { setTab(t); setPage(1); }}
 className={`cursor-pointer border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all ${
 tab === t
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {t === 'payments' ? 'Pagos' : 'Conciliación diaria'}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {tab === 'payments' ? (
 <>
 <div className="flex flex-wrap items-center gap-3">
 <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={select} aria-label="Estado">
 <option value="">Todos los estados</option>
 <option value="paid">Aprobados</option>
 <option value="pending">Pendientes</option>
 <option value="failed">Fallidos</option>
 <option value="refunded">Reembolsados</option>
 </select>
 <select value={methodType} onChange={(e) => { setMethodType(e.target.value); setPage(1); }} className={select} aria-label="Método">
 <option value="">Todos los métodos</option>
 <option value="CARD">Tarjeta</option>
 <option value="PSE">PSE</option>
 <option value="NEQUI">Nequi</option>
 <option value="BANCOLOMBIA_TRANSFER">Bancolombia</option>
 <option value="DAVIPLATA">Daviplata</option>
 </select>
 <span className="text-xs text-[var(--color-text-main)]">
 {Object.entries(totals).map(([k, v]) => `${STATUS_LABEL[k as PaymentRow['status']]?.text ?? k}: ${money(v.amount)} (${v.count})`).join(' · ')}
 </span>
 </div>

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">No hay pagos con este filtro.</p>
 ) : (
 <>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Concepto</th>
 <th className="table-header-cell">Método</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Referencia</th>
 <th className="table-header-cell">Monto</th>
 <th className="table-header-cell">Comisión est.</th>
 <th className="table-header-cell">Estado</th>
 </tr>
 </thead>
 <tbody>
 {items.map((p) => (
 <tr key={p._id}>
 <td className="table-body-cell">
 {p.orderId ? (
 <EntityLink type="order" id={p.orderId}>Pedido #{p.orderNumber ?? 'N/A'}</EntityLink>
 ) : (
 'Membresía Zipp Pro'
 )}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.methodType ?? 'Sin método'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{dateTime(p.createdAt)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.reference ?? '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(p.amount)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.estimatedFee > 0 ? money(p.estimatedFee) : '—'}</td>
 <td className={`table-body-cell ${STATUS_LABEL[p.status].className}`}>{STATUS_LABEL[p.status].text}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </>
 )}
 </>
 ) : loading || !daily ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <>
 {!daily.feeConfigured && (
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 La tarifa de Wompi está sin configurar (Tarifas y Precios): la comisión asentada es 0 y el depósito esperado es igual a lo cobrado.
 </p>
 )}
 <div className="grid grid-cols-2 gap-4 border-b border-[var(--color-border-light)] pb-4 lg:grid-cols-4">
 {[
 { label: 'Cobros (14 días)', value: String(daily.totals.count) },
 { label: 'Cobrado', value: money(daily.totals.gross) },
 { label: 'Comisión asentada', value: money(daily.totals.bookedFee) },
 { label: 'Depósito esperado', value: money(daily.totals.expectedDeposit) },
 ].map((k) => (
 <div key={k.label}>
 <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{k.label}</p>
 <p className="kpi-value mt-1 text-xl text-[var(--color-text-main)]">{k.value}</p>
 </div>
 ))}
 </div>
 {daily.items.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">No hubo cobros aprobados en este periodo.</p>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Cobros</th>
 <th className="table-header-cell">Por método</th>
 <th className="table-header-cell">Cobrado</th>
 <th className="table-header-cell">Comisión</th>
 <th className="table-header-cell">Depósito esperado</th>
 </tr>
 </thead>
 <tbody>
 {daily.items.map((d) => (
 <tr key={d.date}>
 <td className="table-body-cell text-[var(--color-text-main)]">{d.date}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{d.count}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {Object.entries(d.byMethod).map(([m, v]) => `${METHOD_LABEL[m] ?? m} ${money(v.amount)}`).join(' · ')}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(d.gross)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(d.bookedFee)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(d.expectedDeposit)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 <p className="text-[11px] text-[var(--color-text-main)]">
 Compara el depósito esperado de cada día con el reporte de desembolsos de Wompi. Una diferencia es una tarifa mal cargada o un cobro que Wompi no liquidó.
 </p>
 </>
 )}
 </div>
 );
}
