import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import SummaryGrid from '../components/SummaryGrid';

/**
 * Invitaciones: quién trajo a quién y en qué quedó.
 *
 * El programa no paga recompensa hoy: una invitación"cumplida" es la que
 * terminó en la primera compra del invitado. Las bloqueadas son las que las
 * tres señales antiabuso frenaron (mismo dispositivo, tope de invitaciones,
 * quien invita nunca ha comprado).
 */

type Status = 'pending' | 'converted' | 'blocked';

interface Data {
 summary: { invited: number; converted: number; blocked: number; pending: number };
 topReferrers: { referrerId: string; name: string; invited: number; converted: number }[];
 invitations: {
 inviteeId: string; invitee: string; referrer: string; status: Status;
 reason: string | null; joinedAt: string; resolvedAt: string | null;
 }[];
}

const TABS: { key: Status | 'all'; label: string }[] = [
 { key: 'all', label: 'Todas' },
 { key: 'pending', label: 'Pendientes' },
 { key: 'converted', label: 'Cumplidas' },
 { key: 'blocked', label: 'Bloqueadas' },
];

const STATUS_LABEL: Record<Status, string> = {
 pending: 'Esperando su primera compra',
 converted: 'Compró',
 blocked: 'Bloqueada por abuso',
};

export default function Referrals() {
 const [tab, setTab] = useState<Status | 'all'>('all');
 const [data, setData] = useState<Data | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');

 const load = useCallback(async () => {
 try {
 setLoading(true); setError('');
 const { data: res } = await api.get('/admin/growth/referrals', {
 params: tab === 'all' ? {} : { status: tab },
 });
 setData(res.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las invitaciones.'));
 } finally {
 setLoading(false);
 }
 }, [tab]);

 useEffect(() => { load(); }, [load]);

 const s = data?.summary;
 const rate = s && s.invited > 0 ? Math.round((s.converted / s.invited) * 100) : 0;

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Referidos</h1>
 <p className="page-subtitle">Quién invita, quién compró y qué frenó el antiabuso.</p>
 </div>
 <button
 onClick={load}
 className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" /> Actualizar
 </button>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 <SummaryGrid
 items={[
 { label: 'Invitados', value: s?.invited ?? '–' },
 { label: 'Compraron', value: s ? `${s.converted} (${rate}%)` : '–' },
 { label: 'Pendientes', value: s?.pending ?? '–' },
 { label: 'Bloqueadas', value: s?.blocked ?? '–' },
 ]}
 />

 {data && data.topReferrers.length > 0 && (
 <div>
 <h2 className="mb-1 text-sm font-bold text-[var(--color-text-main)]">Quién más invita</h2>
 <p className="mb-2 text-xs text-[var(--color-text-main)]">Mucha invitación con poca compra es la señal de cuentas fabricadas.</p>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Quién invita</th>
 <th className="table-header-cell">Invitados</th>
 <th className="table-header-cell">Compraron</th>
 </tr>
 </thead>
 <tbody>
 {data.topReferrers.map((t) => (
 <tr key={t.referrerId}>
 <td className="table-body-cell text-[var(--color-text-main)]">{t.name}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{t.invited}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{t.converted}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}

 <div className="flex flex-wrap gap-x-6 border-b border-[var(--color-border-light)]">
 {TABS.map((t) => (
 <button
 key={t.key}
 onClick={() => setTab(t.key)}
 className={`cursor-pointer pb-2 text-xs font-bold ${tab === t.key ? 'border-b-2 border-[var(--color-primary)] text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}
 >
 {t.label}
 </button>
 ))}
 </div>

 {loading && !data ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : !data || data.invitations.length === 0 ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Sin invitaciones en esta vista.</p>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Invitado</th>
 <th className="table-header-cell">Invitado por</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Motivo</th>
 <th className="table-header-cell">Fecha</th>
 </tr>
 </thead>
 <tbody>
 {data.invitations.map((i) => (
 <tr key={i.inviteeId}>
 <td className="table-body-cell text-[var(--color-text-main)]">{i.invitee}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{i.referrer}</td>
 <td className={`table-body-cell ${i.status === 'blocked' ? 'text-[var(--color-danger)]' : i.status === 'converted' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-main)]'}`}>
 {STATUS_LABEL[i.status]}
 </td>
 <td className="table-body-cell wrap text-[var(--color-text-main)]">{i.reason ?? '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{new Date(i.joinedAt).toLocaleDateString('es-CO')}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 <p className="text-xs text-[var(--color-text-main)]">Se muestran las 50 más recientes; los totales son de todo el programa.</p>
 </div>
 );
}
