import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveReload } from '../hooks/useLiveReload';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import { permissionLabel, groupShadowByUser, type ShadowRow } from '../lib/authzShadow';

interface ShadowResponse {
 rows: ShadowRow[];
 mode: 'observe' | 'enforce';
 enforceFlag?: unknown;
}

const fmt = (d: string) => new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

/** Pestaña"Revisión de accesos": qué perdería cada persona al activar el bloqueo. */
export default function AccessReview() {
 const [data, setData] = useState<ShadowResponse | null>(null);
 const [loading, setLoading] = useState(true);
 const [unavailable, setUnavailable] = useState(false);
 const [error, setError] = useState('');
 const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
 const [saving, setSaving] = useState(false);

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 try {
 const { data: res } = await api.get('/security/authz-shadow', { params: { days: 7 } });
 const d = res.data;
 setData({ rows: d.rows ?? d.entries ?? [], mode: d.mode === 'enforce' ? 'enforce' : 'observe', enforceFlag: d.enforceFlag });
 setUnavailable(false);
 } catch (err) {
 const status = (err as { response?: { status?: number } }).response?.status;
 if (status === 404) setUnavailable(true);
 else setError(apiMessage(err, 'No se pudo cargar la revisión de accesos.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useLiveReload(['users', 'settings'], load);
 useEffect(() => {
 void load();
 }, [load]);

 const groups = useMemo(() => groupShadowByUser(data?.rows ?? []), [data]);

 const applyMode = async () => {
 if (!confirm) return;
 setSaving(true);
 try {
 await api.put('/admin/feature-flags/rbac_enforce', {
 description: 'Bloqueo real de permisos por cargo (RBAC estricto)',
 audience: confirm === 'enable' ? 'staff' : 'off',
 });
 setConfirm(null);
 await load();
 } catch (err) {
 setConfirm(null);
 setError(apiMessage(err, 'No se pudo cambiar el modo.'));
 } finally {
 setSaving(false);
 }
 };

 const enforcing = data?.mode === 'enforce';

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="flex items-start justify-between gap-4">
 <div>
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Revisión de accesos</h2>
 <p className="text-xs text-[var(--color-text-main)] mt-1 max-w-2xl">
 Últimos 7 días. Cada fila es algo que una persona hizo gracias a permisos antiguos y que perdería al activar el bloqueo.
 </p>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 {data && (
 <button
 onClick={() => setConfirm(enforcing ? 'disable' : 'enable')}
 className={`px-3 py-2 text-xs font-bold rounded-lg cursor-pointer ${
 enforcing ? 'border border-[var(--color-border)] text-[var(--color-text-main)]' : 'bg-[var(--color-primary)] text-white'
 }`}
 >
 {enforcing ? 'Desactivar bloqueo' : 'Activar bloqueo'}
 </button>
 )}
 </div>
 </div>

 {data && (
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 Modo actual: {enforcing ? 'bloqueo activo' : 'observación (se registra y se deja pasar)'}
 </p>
 )}
 {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}

 {loading ? (
 <p className="text-xs text-[var(--color-text-main)] py-8">Cargando…</p>
 ) : unavailable ? (
 <p className="text-xs text-[var(--color-text-main)] py-8">
 El reporte todavía no está disponible en el servidor.
 </p>
 ) : groups.length === 0 ? (
 <p className="text-xs text-[var(--color-text-main)] py-8">
 Nadie perdería nada: no se registró ningún acceso que dependa de permisos antiguos.
 </p>
 ) : (
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Persona</th>
 <th className="table-header-cell">Perdería</th>
 <th className="table-header-cell">Dónde</th>
 <th className="table-header-cell">Veces</th>
 <th className="table-header-cell">Último uso</th>
 </tr>
 </thead>
 <tbody>
 {groups.map((g) => (
 <GroupRows key={g.userId} group={g} />
 ))}
 </tbody>
 </table>
 </div>
 )}

 {confirm && (
 <ConfirmDialog
 title={confirm === 'enable' ? 'Activar bloqueo de permisos' : 'Desactivar bloqueo'}
 message={
 confirm === 'enable'
 ? 'Desde ahora cada persona solo podrá hacer lo que su rol permite. Lo listado aquí dejará de funcionar. Puedes revertirlo con Desactivar.'
 : 'Se vuelve al modo observación: se registra lo que sobra pero se deja pasar.'
 }
 confirmLabel={saving ? 'Guardando…' : confirm === 'enable' ? 'Activar bloqueo' : 'Desactivar'}
 cancelLabel="Cancelar"
 variant={confirm === 'enable' ? 'danger' : 'warning'}
 onConfirm={() => void applyMode()}
 onCancel={() => setConfirm(null)}
 />
 )}
 </div>
 );
}

function GroupRows({ group }: { group: ReturnType<typeof groupShadowByUser>[number] }) {
 return (
 <>
 {group.rows.map((r, i) => (
 <tr key={`${r.permission}-${r.method}-${r.route}`} className="border-t border-[var(--color-border-light)]">
 <td className="table-body-cell align-top">
 {i === 0 && (
 <>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{group.userName}</p>
 <p className="text-[10px] text-[var(--color-text-main)]">
 {group.email ? `${group.email} · ` : ''}
 {group.roleSlugs.length ? group.roleSlugs.join(', ') : 'sin rol'}
 </p>
 </>
 )}
 </td>
 <td className="table-body-cell text-xs">{permissionLabel(r.permission)}</td>
 <td className="table-body-cell text-[11px] text-[var(--color-text-main)]">
 {r.method} {r.route}
 </td>
 <td className="table-body-cell text-xs">{r.count}</td>
 <td className="table-body-cell text-[11px] text-[var(--color-text-main)]">{fmt(r.lastSeen)}</td>
 </tr>
 ))}
 </>
 );
}
