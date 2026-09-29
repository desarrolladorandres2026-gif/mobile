import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Respuestas predefinidas de soporte.
 *
 * Son borradores: al insertarlas en un caso se sustituyen las variables y la
 * persona puede editar el texto antes de enviarlo. Nada sale solo.
 */

type CaseType = 'petition' | 'complaint' | 'claim' | 'suggestion';

interface Macro {
 _id: string;
 title: string;
 body: string;
 appliesTo: CaseType[];
 isActive: boolean;
}

const TYPE_LABEL: Record<CaseType, string> = {
 petition: 'Petición',
 complaint: 'Queja',
 claim: 'Reclamo',
 suggestion: 'Sugerencia',
};

const EMPTY = { title: '', body: '', appliesTo: [] as CaseType[] };

export default function SupportMacros() {
 const [macros, setMacros] = useState<Macro[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [editing, setEditing] = useState<string | 'new' | null>(null);
 const [form, setForm] = useState(EMPTY);
 const [toDelete, setToDelete] = useState<Macro | null>(null);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/pqrs/macros', { params: { all: 'true' } });
 setMacros(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las respuestas predefinidas.'));
 } finally {
 setLoading(false);
 }
 }, []);

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

 const startEdit = (macro?: Macro) => {
 setEditing(macro ? macro._id : 'new');
 setForm(macro ? { title: macro.title, body: macro.body, appliesTo: macro.appliesTo } : EMPTY);
 };

 const save = () =>
 run(async () => {
 if (editing === 'new') await api.post('/pqrs/macros', form);
 else await api.patch(`/pqrs/macros/${editing}`, form);
 setEditing(null);
 }, 'No se pudo guardar la respuesta.');

 const toggleType = (type: CaseType) =>
 setForm((f) => ({
 ...f,
 appliesTo: f.appliesTo.includes(type) ? f.appliesTo.filter((t) => t !== type) : [...f.appliesTo, type],
 }));

 const fieldClass = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Respuestas predefinidas</h1>
 <p className="page-subtitle">
 Borradores para responder más rápido desde la bandeja de Soporte.
 Variables: {'{{cliente}}'}, {'{{pedido}}'} y {'{{agente}}'}.
 </p>
 </div>
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => startEdit()}
 className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white"
 >
 <Plus className="h-4 w-4" /> Nueva respuesta
 </button>
 </PermissionGate>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 {editing && (
 <div className="space-y-3 border-y border-[var(--color-border-light)] py-4">
 <input
 value={form.title}
 onChange={(e) => setForm({ ...form, title: e.target.value })}
 placeholder="Título (lo que ves al elegirla)"
 maxLength={80}
 className={fieldClass}
 />
 <textarea
 value={form.body}
 onChange={(e) => setForm({ ...form, body: e.target.value })}
 rows={5}
 maxLength={2000}
 placeholder="Hola {{cliente}}, ya revisamos tu pedido {{pedido}}…"
 className={fieldClass}
 />
 <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--color-text-main)]">
 <span className="font-semibold">Aplica a:</span>
 {(Object.keys(TYPE_LABEL) as CaseType[]).map((type) => (
 <label key={type} className="flex cursor-pointer items-center gap-1.5">
 <input
 type="checkbox"
 checked={form.appliesTo.includes(type)}
 onChange={() => toggleType(type)}
 className="cursor-pointer accent-[var(--color-primary)]"
 />
 {TYPE_LABEL[type]}
 </label>
 ))}
 <span className="text-[var(--color-text-main)]">
 {form.appliesTo.length === 0 ? '(sin marcar: aplica a todos)' : ''}
 </span>
 </div>
 <div className="flex justify-end gap-2">
 <button
 onClick={() => setEditing(null)}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Cancelar
 </button>
 <button
 onClick={save}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
 >
 Guardar
 </button>
 </div>
 </div>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : macros.length === 0 ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">
 Aún no hay respuestas predefinidas.
 </p>
 ) : (
 <ul>
 {macros.map((macro) => (
 <li key={macro._id} className="flex flex-wrap items-start gap-3 border-b border-[var(--color-border-light)] py-4">
 <div className={`min-w-0 flex-1 ${macro.isActive ? '' : 'opacity-50'}`}>
 <p className="font-bold text-[var(--color-text-main)]">
 {macro.title}
 {!macro.isActive && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-main)]">archivada</span>}
 </p>
 <p className="text-[11px] uppercase tracking-wider text-[var(--color-text-main)]">
 {macro.appliesTo.length ? macro.appliesTo.map((t) => TYPE_LABEL[t]).join(' · ') : 'Todos los tipos'}
 </p>
 <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{macro.body}</p>
 </div>
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <div className="flex gap-1.5">
 <button
 onClick={() => startEdit(macro)}
 title="Editar"
 className="cursor-pointer rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-main)]"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 <button
 onClick={() => run(() => api.patch(`/pqrs/macros/${macro._id}`, { isActive: !macro.isActive }), 'No se pudo cambiar el estado.')}
 title={macro.isActive ? 'Archivar' : 'Restaurar'}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-main)]"
 >
 {macro.isActive ? <Archive className="h-3.5 w-3.5" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
 </button>
 <button
 onClick={() => setToDelete(macro)}
 title="Eliminar"
 className="cursor-pointer rounded-lg border border-[var(--color-danger)] p-2 text-[var(--color-danger)]"
 >
 <Trash2 className="h-3.5 w-3.5" />
 </button>
 </div>
 </PermissionGate>
 </li>
 ))}
 </ul>
 )}

 {toDelete && (
 <ConfirmDialog
 title="Eliminar respuesta"
 message={`«${toDelete.title}» se elimina para siempre. Si solo quieres dejar de usarla, archívala.`}
 confirmLabel="Eliminar"
 onConfirm={() => {
 const id = toDelete._id;
 setToDelete(null);
 run(() => api.delete(`/pqrs/macros/${id}`), 'No se pudo eliminar la respuesta.');
 }}
 onCancel={() => setToDelete(null)}
 />
 )}
 </div>
 );
}
