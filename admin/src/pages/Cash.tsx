import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, day } from '../lib/drivers';

/**
 * Efectivo sin rendir, por domiciliario.
 *
 * Empieza por"a quién le tengo que cobrar", no por una lista de pedidos:
 * cada fila es una persona con lo que debe, lo que ya declaró haber
 * consignado (falta verificarlo) y lo que ya venció. La verificación con
 * referencia, monto y comprobante sigue en Finanzas, donde están los registros
 * por pedido.
 */

interface DriverCash {
 driverId: string;
 name: string | null;
 count: number;
 amount: number;
 reportedAmount: number;
 overdueCount: number;
 overdueAmount: number;
 oldestDueAt: string;
}

export default function Cash() {
 const [rows, setRows] = useState<DriverCash[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 const { data } = await api.get('/finance/cash/by-driver');
 setRows(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar el efectivo por domiciliario.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 load();
 }, [load]);

 const total = rows.reduce((s, r) => s + r.amount, 0);
 const overdue = rows.reduce((s, r) => s + r.overdueAmount, 0);
 const reported = rows.reduce((s, r) => s + r.reportedAmount, 0);

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Efectivo por domiciliario</h1>
 <p className="page-subtitle">Lo que cada persona debe rendir a ZIPP, lo declarado y lo vencido</p>
 </div>
 <Link to="/financials" className="text-xs font-semibold text-[var(--color-primary)] underline underline-offset-2">
 Verificar consignaciones en Finanzas
 </Link>
 </div>

 <div className="grid grid-cols-3 gap-4 border-b border-[var(--color-border-light)] pb-4">
 {[
 { label: 'Sin rendir', value: money(total), color: 'text-[var(--color-text-main)]' },
 { label: 'Declarado, sin verificar', value: money(reported), color: 'text-[var(--color-warning)]' },
 { label: 'Vencido', value: money(overdue), color: 'text-[var(--color-danger)]' },
 ].map((k) => (
 <div key={k.label}>
 <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{k.label}</p>
 <p className={`kpi-value mt-1 text-xl ${k.color}`}>{k.value}</p>
 </div>
 ))}
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <ShieldAlert className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : rows.length === 0 ? (
 <p className="py-10 text-center text-xs text-[var(--color-text-main)]">Ningún domiciliario tiene efectivo sin rendir.</p>
 ) : (
 <div className="divide-y divide-[var(--color-border-light)]">
 {rows.map((r) => (
 <div key={r.driverId} className="flex flex-wrap items-start justify-between gap-3 py-3">
 <div className="min-w-0">
 <p className="text-sm font-bold text-[var(--color-text-main)]">
 <EntityLink type="driver" id={r.driverId}>{r.name ?? 'Sin nombre'}</EntityLink>
 </p>
 <p className="text-[11px] text-[var(--color-text-main)]">
 {r.count} {r.count === 1 ? 'pedido' : 'pedidos'} · el más antiguo vence {day(r.oldestDueAt)}
 {r.reportedAmount > 0 ? ` · declaró ${money(r.reportedAmount)}` : ''}
 </p>
 </div>
 <div className="text-right">
 <p className="text-sm font-bold text-[var(--color-text-main)]">{money(r.amount)}</p>
 {r.overdueCount > 0 && (
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-danger)]">
 {r.overdueCount} vencido{r.overdueCount === 1 ? '' : 's'} · {money(r.overdueAmount)}
 </p>
 )}
 </div>
 </div>
 ))}
 </div>
 )}
 </div>
 );
}
