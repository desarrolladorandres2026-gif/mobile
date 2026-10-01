import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';
import { money, day } from '../lib/drivers';
import SummaryGrid from '../components/SummaryGrid';

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
 <Link to="/financials" className="text-xs font-semibold text-[var(--color-text-main)] underline underline-offset-2">
 Verificar consignaciones en Finanzas
 </Link>
 </div>

 <SummaryGrid
 items={[
 { label: 'Sin rendir', value: money(total) },
 { label: 'Declarado, sin verificar', value: money(reported), tone: 'warning' },
 { label: 'Vencido', value: money(overdue), tone: 'danger' },
 ]}
 />

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
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Domiciliario</th>
 <th className="table-header-cell">Pedidos</th>
 <th className="table-header-cell">Sin rendir</th>
 <th className="table-header-cell">Declarado</th>
 <th className="table-header-cell">Vencidos</th>
 <th className="table-header-cell">Monto vencido</th>
 <th className="table-header-cell">Vence el más antiguo</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.driverId}>
 <td className="table-body-cell">
 <EntityLink type="driver" id={r.driverId}>{r.name ?? 'Sin nombre'}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.count}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{money(r.amount)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{r.reportedAmount > 0 ? money(r.reportedAmount) : '—'}</td>
 <td className={`table-body-cell ${r.overdueCount > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>{r.overdueCount}</td>
 <td className={`table-body-cell ${r.overdueCount > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>{r.overdueCount > 0 ? money(r.overdueAmount) : '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{day(r.oldestDueAt)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 </div>
 );
}
