import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';

/**
 * Altas de domiciliarios: dónde se quedó cada persona.
 *
 * La cola de documentos solo enseña lo que ya se subió. Quien se registró y
 * nunca completó el perfil, quien no subió nada o quien tiene todo rechazado
 * sin reenviar no aparece en ninguna parte: aquí se ve por etapa, con los días
 * que lleva esperando, para escribirle a la persona correcta.
 */

type Stage = 'no_profile' | 'no_documents' | 'rejected_stuck' | 'in_review' | 'ready_to_approve';

interface Item {
 stage: Stage;
 userId: string;
 driverId: string | null;
 name: string;
 phone: string | null;
 daysWaiting: number;
 documents?: { pending: number; approved: number; rejected: number; expired: number };
}

interface Funnel {
 counts: Record<Stage, number>;
 items: Item[];
 truncated: boolean;
}

const STAGES: Array<{ key: Stage; label: string; hint: string }> = [
 { key: 'ready_to_approve', label: 'Listos para aprobar', hint: 'Todos sus documentos están aprobados: falta aprobar al domiciliario.' },
 { key: 'in_review', label: 'En revisión', hint: 'Tienen documentos esperando revisión en la cola.' },
 { key: 'rejected_stuck', label: 'Rechazados sin reenviar', hint: 'Tienen documentos rechazados o vencidos y ninguno en revisión: hay que escribirles.' },
 { key: 'no_documents', label: 'Sin documentos', hint: 'Crearon el perfil pero no subieron ningún documento.' },
 { key: 'no_profile', label: 'Sin perfil', hint: 'Se registraron como domiciliarios y nunca completaron el perfil.' },
];

export default function DriverFunnel() {
 const [funnel, setFunnel] = useState<Funnel | null>(null);
 const [stage, setStage] = useState<Stage>('ready_to_approve');
 const [error, setError] = useState('');
 const [loading, setLoading] = useState(true);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/drivers/onboarding-funnel');
 setFunnel(data.data);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar el embudo de altas.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { load(); }, [load]);

 const current = STAGES.find((s) => s.key === stage)!;
 const rows = (funnel?.items ?? []).filter((i) => i.stage === stage);

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Altas de domiciliarios</h1>
 <p className="page-subtitle">
 Quién se quedó a medias y desde cuándo. Los documentos se revisan en{' '}
 <Link to="/driver-documents" className="font-semibold text-[var(--color-primary)] underline">Documentos</Link>.
 </p>
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

 <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-[var(--color-border-light)]">
 {STAGES.map((s) => (
 <button
 key={s.key}
 onClick={() => setStage(s.key)}
 className={`cursor-pointer pb-2 text-left ${
 stage === s.key ? 'border-b-2 border-[var(--color-primary)]' : ''
 }`}
 >
 <p className="text-2xl font-bold text-[var(--color-text-main)]">{funnel?.counts[s.key] ?? '–'}</p>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{s.label}</p>
 </button>
 ))}
 </div>

 <p className="text-xs text-[var(--color-text-main)]">{current.hint}</p>

 {loading && !funnel ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : rows.length === 0 ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Nadie en esta etapa.</p>
 ) : (
 <ul>
 {rows.map((item) => (
 <li key={item.userId} className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-[var(--color-border-light)] py-3">
 <div className="min-w-0 flex-1">
 <p className="font-semibold text-[var(--color-text-main)]">
 <EntityLink type={item.driverId ? 'driver' : 'user'} id={item.driverId ?? item.userId}>{item.name}</EntityLink>
 </p>
 <p className="text-xs text-[var(--color-text-main)]">{item.phone ?? 'Sin teléfono'}</p>
 </div>
 {item.documents && (
 <p className="text-xs text-[var(--color-text-main)]">
 {item.documents.approved} aprobados · {item.documents.pending} en revisión · {item.documents.rejected + item.documents.expired} rechazados o vencidos
 </p>
 )}
 <p className={`text-xs font-bold ${item.daysWaiting >= 7 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-main)]'}`}>
 {item.daysWaiting === 0 ? 'hoy' : `hace ${item.daysWaiting} d`}
 </p>
 </li>
 ))}
 </ul>
 )}

 {funnel?.truncated && (
 <p className="text-xs text-[var(--color-text-main)]">Se muestran los 50 que más llevan esperando por etapa; los conteos son totales.</p>
 )}
 </div>
 );
}
