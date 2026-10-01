import { useCallback, useEffect, useState } from 'react';
import { useLiveReload } from '../hooks/useLiveReload';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Interruptores: separan publicar código de encender lo que pasa en la calle.
 * Cambiarlos se ve en unos 10 segundos y queda auditado.
 */

type Audience = 'off' | 'all' | 'staff' | 'percentage';

interface Flag {
 key: string;
 description: string;
 audience: Audience;
 percentage: number;
 updatedAt: string;
}

const AUDIENCE_LABEL: Record<Audience, string> = {
 off: 'Apagado',
 all: 'Todos',
 staff: 'Solo el equipo',
 percentage: 'Un porcentaje',
};

/** Estos dos cambian el comportamiento de todo el panel o de la operación. */
const CRITICAL: Record<string, string> = {
 rbac_enforce: 'Decide si los permisos bloquean (todos) o solo avisan (staff). Cambiarlo cierra las sesiones de socket de todo el equipo.',
};

const fieldClass = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';

export default function FeatureFlags() {
 const [flags, setFlags] = useState<Flag[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [pending, setPending] = useState<{ flag: Flag; audience: Audience; percentage: number } | null>(null);
 const [toDelete, setToDelete] = useState<Flag | null>(null);
 const [draft, setDraft] = useState<{ key: string; description: string } | null>(null);

 const load = useCallback(async () => {
 try {
 setLoading(true); setError('');
 const { data } = await api.get('/admin/feature-flags');
 setFlags(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los interruptores.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useLiveReload(['settings'], load);
 useEffect(() => { load(); }, [load]);

 const run = async (action: () => Promise<unknown>, fallback: string) => {
 try {
 setError('');
 await action();
 await load();
 } catch (err) {
 setError(apiMessage(err, fallback));
 }
 };

 const apply = () => {
 if (!pending) return;
 const { flag, audience, percentage } = pending;
 setPending(null);
 return run(
 () => api.put(`/admin/feature-flags/${flag.key}`, {
 audience,
 ...(audience === 'percentage' ? { percentage } : {}),
 }),
 'No se pudo cambiar el interruptor.'
 );
 };

 const create = () => {
 if (!draft) return;
 const body = { description: draft.description.trim(), audience: 'off' as const };
 const key = draft.key.trim();
 setDraft(null);
 return run(() => api.put(`/admin/feature-flags/${key}`, body), 'No se pudo crear el interruptor.');
 };

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Interruptores</h1>
 <p className="page-subtitle">Enciende o apaga funciones sin publicar una versión. Un interruptor nuevo nace apagado.</p>
 </div>
 <div className="flex gap-2">
 <PermissionGate permission={Permission.SETTINGS_UPDATE}>
 <button
 onClick={() => setDraft({ key: '', description: '' })}
 className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-[var(--color-on-primary,#000)]"
 >
 <Plus className="h-4 w-4" /> Nuevo
 </button>
 </PermissionGate>
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 {draft && (
 <div className="space-y-3 border-y border-[var(--color-border-light)] py-4">
 <input
 value={draft.key}
 onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase() })}
 placeholder="clave.en.minusculas (ej. pedidos.programados)"
 maxLength={60}
 className={`${fieldClass} w-full`}
 />
 <input
 value={draft.description}
 onChange={(e) => setDraft({ ...draft, description: e.target.value })}
 placeholder="Qué controla, para quien lo lea en seis meses"
 maxLength={300}
 className={`${fieldClass} w-full`}
 />
 <div className="flex gap-3">
 <button
 onClick={create}
 disabled={!/^[a-z][a-z0-9._-]{1,59}$/.test(draft.key.trim()) || draft.description.trim().length < 3}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-[var(--color-on-primary,#000)] disabled:opacity-50"
 >
 Crear apagado
 </button>
 <button onClick={() => setDraft(null)} className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)]">Cancelar</button>
 </div>
 </div>
 )}

 {loading && flags.length === 0 ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : flags.length === 0 ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">No hay interruptores creados.</p>
 ) : (
 <ul>
 {flags.map((f) => (
 <li key={f.key} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--color-border-light)] py-3">
 <div className="min-w-0 flex-1">
 <p className="font-mono text-sm font-semibold text-[var(--color-text-main)]">{f.key}</p>
 <p className="text-xs text-[var(--color-text-main)]">{f.description}</p>
 {CRITICAL[f.key] && <p className="text-xs font-semibold text-[var(--color-text-main)]">{CRITICAL[f.key]}</p>}
 </div>
 <PermissionGate
 permission={Permission.SETTINGS_UPDATE}
 fallback={<p className="text-xs font-bold text-[var(--color-text-main)]">{AUDIENCE_LABEL[f.audience]}{f.audience === 'percentage' ? ` ${f.percentage}%` : ''}</p>}
 >
 <select
 value={f.audience}
 onChange={(e) => {
 const audience = e.target.value as Audience;
 setPending({ flag: f, audience, percentage: f.percentage || 10 });
 }}
 className={fieldClass}
 >
 {(Object.keys(AUDIENCE_LABEL) as Audience[])
 // rbac_enforce es igual para todos: solo estas audiencias tienen sentido.
 .filter((a) => f.key !== 'rbac_enforce' || a !== 'percentage')
 .map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}{a === 'percentage' && f.audience === 'percentage' ? ` ${f.percentage}%` : ''}</option>)}
 </select>
 {f.key !== 'rbac_enforce' && (
 <button onClick={() => setToDelete(f)} aria-label={`Eliminar ${f.key}`} className="cursor-pointer text-[var(--color-text-main)]">
 <Trash2 className="h-4 w-4" />
 </button>
 )}
 </PermissionGate>
 <p className="w-24 text-right text-xs text-[var(--color-text-main)]">{new Date(f.updatedAt).toLocaleDateString('es-CO')}</p>
 </li>
 ))}
 </ul>
 )}

 {pending && (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
 <div className="w-full max-w-sm space-y-3 rounded-xl bg-[var(--color-surface,#fff)] p-5 shadow-xl">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">
 {pending.flag.key} → {AUDIENCE_LABEL[pending.audience]}
 </h3>
 {pending.audience === 'percentage' && (
 <label className="block text-xs text-[var(--color-text-main)]">
 Porcentaje de usuarios (1–100)
 <input
 type="number" min={1} max={100} value={pending.percentage}
 onChange={(e) => setPending({ ...pending, percentage: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
 className={`${fieldClass} mt-1 w-full`}
 />
 </label>
 )}
 {CRITICAL[pending.flag.key] && <p className="text-xs font-semibold text-[var(--color-text-main)]">{CRITICAL[pending.flag.key]}</p>}
 <p className="text-xs text-[var(--color-text-main)]">El cambio se nota en unos 10 segundos y queda en la auditoría.</p>
 <div className="flex justify-end gap-3">
 <button onClick={() => setPending(null)} className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)]">Cancelar</button>
 <button onClick={apply} className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-[var(--color-on-primary,#000)]">Aplicar</button>
 </div>
 </div>
 </div>
 )}

 {toDelete && (
 <ConfirmDialog
 title={`Eliminar ${toDelete.key}`}
 message="Sin el interruptor, la función vuelve a su comportamiento por defecto (apagada). No se puede deshacer."
 confirmLabel="Eliminar"
 variant="danger"
 onConfirm={() => { const k = toDelete.key; setToDelete(null); return run(() => api.delete(`/admin/feature-flags/${k}`), 'No se pudo eliminar.'); }}
 onCancel={() => setToDelete(null)}
 />
 )}
 </div>
 );
}
