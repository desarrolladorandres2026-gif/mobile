import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw, Scale } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Solicitudes de datos personales (Ley 1581).
 *
 * Las PQRS ya no se responden aquí: viven en Soporte, en una sola bandeja
 * con su plazo legal. Dos pantallas respondiendo el mismo caso por rutas
 * distintas era la forma de que dos personas contestaran sin verse.
 */

interface DataRequest {
 _id: string;
 type: 'access' | 'rectify' | 'update' | 'delete' | 'revoke';
 status: 'received' | 'in_review' | 'resolved' | 'rejected';
 detail?: string;
 response?: string;
 createdAt?: string;
 legalDueAt?: string | null;
 extendedAt?: string | null;
 extensionReason?: string;
 legalOverdue?: boolean;
 legalDueSoon?: boolean;
 userId?: { _id?: string; name?: string; email?: string } | string;
}

const TYPE_LABEL: Record<DataRequest['type'], string> = {
 access: 'Consulta de datos',
 rectify: 'Rectificación',
 update: 'Actualización',
 delete: 'Supresión',
 revoke: 'Revocar autorización',
};

const STATUS_LABEL: Record<DataRequest['status'], string> = {
 received: 'Recibida',
 in_review: 'En revisión',
 resolved: 'Resuelta',
 rejected: 'Rechazada',
};

const day = (iso?: string | null) =>
 iso ? new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

type Pending = { request: DataRequest; status: 'resolved' | 'rejected'; anonymize: boolean };

/** Días hábiles que la ley permite añadir una sola vez: 5 a la consulta, 8 al reclamo. */
const EXTENSION_DAYS: Record<DataRequest['type'], number> = { access: 5, rectify: 8, update: 8, delete: 8, revoke: 8 };

export default function LegalOps() {
 const [requests, setRequests] = useState<DataRequest[]>([]);
 const [error, setError] = useState('');
 const [loading, setLoading] = useState(true);
 const [pending, setPending] = useState<Pending | null>(null);
 const [extending, setExtending] = useState<DataRequest | null>(null);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/legal/admin/data-requests');
 setRequests(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No fue posible cargar las solicitudes de datos.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { load(); }, [load]);

 const answer = async (response?: string) => {
 if (!pending || !response) return;
 const { request, status, anonymize } = pending;
 setPending(null);
 try {
 setError('');
 await api.patch(`/legal/admin/data-requests/${request._id}`, { status, response, anonymize });
 await load();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo responder la solicitud.'));
 }
 };

 const act = async (action: () => Promise<unknown>, fallback: string) => {
 try {
 setError('');
 await action();
 await load();
 } catch (err) {
 setError(apiMessage(err, fallback));
 }
 };

 const extend = (reason?: string) => {
 const request = extending;
 setExtending(null);
 if (!request || !reason) return;
 act(() => api.patch(`/legal/admin/data-requests/${request._id}/extend`, { reason }), 'No se pudo ampliar el plazo.');
 };

 const open = requests.filter((r) => r.status === 'received' || r.status === 'in_review');
 const closed = requests.filter((r) => r.status === 'resolved' || r.status === 'rejected');
 const overdue = open.filter((r) => r.legalOverdue).length;

 const headClass = 'px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)] whitespace-nowrap';
 const cellClass = 'px-3 py-3.5 text-xs align-top border-t border-[var(--color-border-light)] text-[var(--color-text-main)]';

 const row = (r: DataRequest) => {
 const user = typeof r.userId === 'object' ? r.userId : null;
 const isOpen = r.status === 'received' || r.status === 'in_review';
 return (
 <tr key={r._id}>
 <td className={cellClass}>
 <p className="font-bold">{TYPE_LABEL[r.type] ?? r.type}</p>
 <p className="text-[var(--color-text-main)]">{user?.name ?? 'Usuario'}{user?.email ? ` · ${user.email}` : ''}</p>
 </td>
 <td className={`${cellClass} max-w-md`}>
 <p className="text-[var(--color-text-main)] whitespace-pre-wrap">{r.detail}</p>
 {r.response && <p className="mt-2 border-l-2 border-[var(--color-primary)] pl-3">{r.response}</p>}
 </td>
 <td className={`${cellClass} whitespace-nowrap`}>
 <p>Recibida {day(r.createdAt)}</p>
 {r.extendedAt && (
 <p className="text-[10px] font-semibold text-[var(--color-text-main)]">Plazo ampliado {day(r.extendedAt)}</p>
 )}
 {isOpen && r.legalDueAt && (
 <p
 className={`flex items-center gap-1 font-bold ${
 r.legalOverdue ? 'text-[var(--color-danger)]' : r.legalDueSoon ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-main)]'
 }`}
 >
 <Scale className="h-3 w-3" />
 {r.legalOverdue ? 'Venció ' : 'Vence '}
 {day(r.legalDueAt)}
 </p>
 )}
 </td>
 <td className={cellClass}>
 <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-main)]">
 {STATUS_LABEL[r.status] ?? r.status}
 </p>
 </td>
 <td className={`${cellClass} text-right`}>
 {isOpen && (
 <div className="flex flex-wrap justify-end gap-1.5">
 {r.status === 'received' && (
 <PermissionGate permission={Permission.LEGAL_MANAGE}>
 <button
 onClick={() => act(() => api.patch(`/legal/admin/data-requests/${r._id}/take`), 'No se pudo tomar la solicitud.')}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold"
 >
 Tomar
 </button>
 </PermissionGate>
 )}
 {!r.extendedAt && !r.legalOverdue && (
 <PermissionGate permission={Permission.LEGAL_MANAGE}>
 <button
 onClick={() => setExtending(r)}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold"
 >
 Ampliar plazo
 </button>
 </PermissionGate>
 )}
 <PermissionGate permission={Permission.LEGAL_MANAGE}>
 <button
 onClick={() => setPending({ request: r, status: 'resolved', anonymize: false })}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-[11px] font-bold text-white"
 >
 Responder
 </button>
 </PermissionGate>
 {r.type === 'delete' && (
 <PermissionGate permission={Permission.LEGAL_MANAGE} role="super_admin">
 <button
 onClick={() => setPending({ request: r, status: 'resolved', anonymize: true })}
 className="cursor-pointer rounded-lg border border-[var(--color-danger)] px-3 py-1.5 text-[11px] font-bold text-[var(--color-danger)]"
 >
 Suprimir datos
 </button>
 </PermissionGate>
 )}
 <PermissionGate permission={Permission.LEGAL_MANAGE}>
 <button
 onClick={() => setPending({ request: r, status: 'rejected', anonymize: false })}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-semibold"
 >
 Rechazar
 </button>
 </PermissionGate>
 </div>
 )}
 </td>
 </tr>
 );
 };

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Datos personales</h1>
 <p className="page-subtitle">
 Solicitudes de Habeas Data (Ley 1581) · {open.length} abiertas{overdue ? ` · ${overdue} con plazo legal vencido` : ''}.
 Las PQRS se atienden en <Link to="/support" className="font-semibold text-[var(--color-primary)] underline">Soporte</Link>.
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

 {loading ? (
 <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando solicitudes...</p>
 ) : (
 <div className="overflow-x-auto">
 <table className="data-grid min-w-[860px]">
 <thead>
 <tr>
 <th className={headClass}>Solicitud</th>
 <th className={headClass}>Detalle</th>
 <th className={headClass}>Plazo</th>
 <th className={headClass}>Estado</th>
 <th className={`${headClass} text-right`}>Acciones</th>
 </tr>
 </thead>
 <tbody>
 {[...open, ...closed].map(row)}
 {requests.length === 0 && (
 <tr>
 <td colSpan={5} className="px-6 py-14 text-center text-xs font-semibold text-[var(--color-text-main)]">
 No hay solicitudes de datos personales.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 )}

 {extending && (
 <ConfirmDialog
 title="Ampliar el plazo de la solicitud"
 message={`La ley permite una sola prórroga de ${EXTENSION_DAYS[extending.type]} días hábiles, y hay que avisar al titular antes de que venza. Se le envía el motivo.`}
 confirmLabel="Ampliar y avisar"
 variant="warning"
 reason={{ label: 'Motivo para el titular', placeholder: 'Por qué necesitamos más tiempo', minLength: 10 }}
 onConfirm={extend}
 onCancel={() => setExtending(null)}
 />
 )}

 {pending && (
 <ConfirmDialog
 title={
 pending.anonymize
 ? 'Suprimir datos del titular'
 : pending.status === 'rejected'
 ? 'Rechazar solicitud'
 : 'Responder solicitud'
 }
 message={
 pending.anonymize
 ? 'La cuenta se anonimiza de forma irreversible: nombre, contacto, direcciones y tarjetas guardadas. Los pedidos quedan para la contabilidad sin datos personales.'
 : 'La respuesta queda registrada y la ve el titular.'
 }
 confirmLabel={pending.anonymize ? 'Suprimir y responder' : pending.status === 'rejected' ? 'Rechazar' : 'Enviar respuesta'}
 variant={pending.anonymize || pending.status === 'rejected' ? 'danger' : 'default'}
 reason={{ label: 'Respuesta al titular', placeholder: 'Explica qué se hizo o por qué no procede', minLength: 2 }}
 onConfirm={answer}
 onCancel={() => setPending(null)}
 />
 )}
 </div>
 );
}
