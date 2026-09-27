import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

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

 <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-[var(--color-border-light)] pb-4">
 {[
 ['Invitados', s?.invited],
 ['Compraron', s ? `${s.converted} (${rate}%)` : undefined],
 ['Pendientes', s?.pending],
 ['Bloqueadas', s?.blocked],
 ].map(([label, value]) => (
 <div key={label as string}>
 <p className="text-2xl font-bold text-[var(--color-text-main)]">{value ?? '–'}</p>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 </div>
 ))}
 </div>

 {data && data.topReferrers.length > 0 && (
 <div>
 <h2 className="mb-1 text-sm font-bold text-[var(--color-text-main)]">Quién más invita</h2>
 <p className="mb-2 text-xs text-[var(--color-text-main)]">Mucha invitación con poca compra es la señal de cuentas fabricadas.</p>
 <ul>
 {data.topReferrers.map((t) => (
 <li key={t.referrerId} className="flex items-center gap-4 border-b border-[var(--color-border-light)] py-2 text-sm">
 <span className="flex-1 font-semibold text-[var(--color-text-main)]">{t.name}</span>
 <span className="text-xs text-[var(--color-text-main)]">{t.invited} invitados · {t.converted} compraron</span>
 </li>
 ))}
 </ul>
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
 <ul>
 {data.invitations.map((i) => (
 <li key={i.inviteeId} className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-[var(--color-border-light)] py-3">
 <div className="min-w-0 flex-1">
 <p className="font-semibold text-[var(--color-text-main)]">{i.invitee}</p>
 <p className="text-xs text-[var(--color-text-main)]">invitado por {i.referrer}</p>
 </div>
 <div className="text-right">
 <p className={`text-xs font-bold ${i.status === 'blocked' ? 'text-[var(--color-danger)]' : i.status === 'converted' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-main)]'}`}>
 {STATUS_LABEL[i.status]}
 </p>
 {i.reason && <p className="text-xs text-[var(--color-text-main)]">{i.reason}</p>}
 </div>
 <p className="w-24 text-right text-xs text-[var(--color-text-main)]">{new Date(i.joinedAt).toLocaleDateString('es-CO')}</p>
 </li>
 ))}
 </ul>
 )}
 <p className="text-xs text-[var(--color-text-main)]">Se muestran las 50 más recientes; los totales son de todo el programa.</p>
 </div>
 );
}
