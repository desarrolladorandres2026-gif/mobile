import { useCallback, useEffect, useState } from 'react';
import { X, AlertTriangle, CheckCircle, Ban, PlayCircle, Eye, EyeOff, Camera } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from './ConfirmDialog';
import DriverFichaTabs, { FichaHeader } from './DriverFichaTabs';
import type { DriverFicha } from '../lib/driverFicha';
import { PermissionGate } from './PermissionGate';
import type { NoteView, ProfileView } from '../lib/fichaTypes';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import { apiMessage } from '../lib/apiError';
import { Facts } from './fichas/ui';
import {
 accountStateStyles,
 availabilityStyles,
 driverAccountState,
 relativeTime,
 type DriverListItem,
} from '../lib/drivers';

/**
 * Ficha completa de un domiciliario.
 *
 * Reúne en un solo lugar lo que ya vivía disperso (documentos, pedidos,
 * calificaciones, pagos, alertas SOS, auditoría) para contestar la pregunta
 * de operaciones:"¿a este repartidor le confío la próxima entrega?".
 * Se abre como panel lateral y no como ruta propia para no perder los
 * filtros del listado desde el que se llegó.
 */

interface DriverDetail extends Omit<DriverListItem, 'userId' | 'baseFund' | 'currentFund'> {
 userId?: NonNullable<DriverListItem['userId']> & {
 /** Sin `users:view_sensitive` no llega el número completo, solo los 4 últimos. */
 documentNumberLast4?: string;
 };
 /** Ausentes sin `finance:view`. */
 baseFund?: number;
 currentFund?: number;
 emergencyContact?: { name: string; phone: string; relationship?: string };
 batteryLevel?: number;
 totalEarnings?: number;
}

export interface Profile360 {
 /** Identidad, vehículo, operación, seguridad, cuenta e historial (`driverFicha.service`). */
 ficha: DriverFicha;
 driver: DriverDetail;
 documents: Array<{
 _id: string;
 type: string;
 /** Sin `users:view_sensitive` llega reducida a los 4 últimos caracteres. */
 reference?: string;
 expiresAt?: string;
 status: string;
 reviewedAt?: string;
 /** La foto no viaja: se abre con "Ver", por el endpoint del expediente. */
 hasFile?: boolean;
 }>;
 /** null sin permiso de notas. */
 notes?: NoteView[] | null;
 /** 'masked' por defecto; 'full' solo con `?view=full` y `users:view_sensitive`. */
 view: ProfileView;
 masked?: { finance?: boolean; sensitive?: boolean };
 activity: {
 totals: { delivered: number; cancelled: number };
 recentOrders: Array<{
 _id: string;
 orderNumber?: string;
 status: string;
 total: number;
 createdAt: string;
 }>;
 reviews: Array<{ _id: string; rating: number; comment?: string; createdAt: string }>;
 coverageZones: Array<{ zone: string; count: number }>;
 };
 /** null sin `finance:view`: la sección no se pinta. */
 finance: {
 baseFund?: number;
 currentFund?: number;
 totalEarnings?: number;
 earningsLast30Days: number;
 payouts: Array<{ _id: string; amount: number; status: string; createdAt: string }>;
 settlements: Array<{ _id: string; periodStart: string; periodEnd: string; netAmount: number }>;
 pendingDebts: {
 count: number;
 total: number;
 items: Array<{ _id: string; amount: number; createdAt: string }>;
 };
 } | null;
 incidents: {
 sos: Array<{ _id: string; status: string; note?: string; createdAt: string; resolution?: string }>;
 sanctions: Array<{ _id: string; action: string; description?: string; createdAt: string; actorName?: string }>;
 pqrs: Array<{ _id: string; subject?: string; status: string; createdAt: string }>;
 };
}

const onboardingStages: Record<string, { label: string; hint: string }> = {
 in_review: { label: 'En revisión', hint: 'Tiene documentos esperando revisión.' },
 ready_to_approve: { label: 'Listo para aprobar', hint: 'Todos sus documentos están aprobados: falta aprobarlo.' },
 rejected_stuck: { label: 'Rechazado sin reenviar', hint: 'Tiene documentos rechazados o vencidos y ninguno en revisión: hay que escribirle.' },
 no_documents: { label: 'Sin documentos', hint: 'Creó el perfil pero no ha subido ningún documento.' },
};

/** Misma regla que `classifyDriver` del backend (embudo de altas). */
function onboardingStage(documents: Array<{ status: string }>): string {
 const n = (status: string) => documents.filter((d) => d.status === status).length;
 if (n('pending') > 0) return 'in_review';
 if (documents.length === 0) return 'no_documents';
 if (n('rejected') > 0 || n('expired') > 0) return 'rejected_stuck';
 return 'ready_to_approve';
}

export default function DriverProfile360({
 driverId,
 onClose,
 onChanged,
}: {
 driverId: string;
 onClose: () => void;
 onChanged: () => void;
}) {
 const [data, setData] = useState<Profile360 | null>(null);
 const [error, setError] = useState('');
 const [actionError, setActionError] = useState('');
 const [confirmSuspend, setConfirmSuspend] = useState(false);
 // El expediente y "Ver documento" son solo para quien aprueba domiciliarios.
 const canSeeDossier = useAuthStore((s) => s.hasPermission(Permission.DRIVERS_APPROVE));
 const canSeeSensitive = useAuthStore((s) => s.hasPermission(Permission.USERS_VIEW_SENSITIVE));
 // Ver los datos completos es un acto deliberado y queda auditado en el servidor.
 const [wantFull, setWantFull] = useState(false);
 const [switching, setSwitching] = useState(false);
 const [viewError, setViewError] = useState('');

 const load = useCallback(() => {
 let cancelled = false;
 setSwitching(true);
 api
 .get(`/admin/drivers/${driverId}/profile-360`, { params: wantFull ? { view: 'full' } : undefined })
 .then((res) => {
 if (cancelled) return;
 setData(res.data.data);
 setError('');
 })
 .catch((err) => {
 if (cancelled) return;
 const message = apiMessage(err, 'No se pudo cargar el perfil del domiciliario.');
 if (wantFull) {
 // Sin permiso o limitado: vuelve a la vista enmascarada y lo explica.
 setViewError(message);
 setWantFull(false);
 } else {
 setError(message);
 }
 })
 .finally(() => {
 if (!cancelled) setSwitching(false);
 });
 return () => {
 cancelled = true;
 };
 }, [driverId, wantFull]);

 useEffect(() => load(), [load]);

 const [actionNote, setActionNote] = useState('');

 /** Pide una selfie en turno: le llega al domiciliario en vivo y queda en la cola de verificaciones. */
 const requestSelfie = async (id: string) => {
 try {
 setActionError('');
 setActionNote('');
 await api.post(`/drivers/${id}/request-verification`, {});
 setActionNote('Selfie solicitada. La revisas en Documentos cuando la envíe.');
 } catch (err) {
 setActionError(apiMessage(err, 'No se pudo pedir la selfie.'));
 }
 };

 const runAction = async (path: string, fallback: string, body?: Record<string, unknown>) => {
 try {
 setActionError('');
 await api.patch(path, body);
 onChanged();
 load();
 } catch (err) {
 setActionError(apiMessage(err, fallback));
 }
 };

 const d = data?.driver;
 const currentView = data?.view ?? 'masked';
 const account = d ? driverAccountState(d) : null;
 const availability = d ? availabilityStyles[d.status] ?? availabilityStyles.offline : null;

 return (
 <>
 {/* Pantalla completa dentro del área de contenido: deja a la vista la
 cabecera (h-20) y la barra lateral (w-30, fija desde lg). */}
 <div className="fixed bottom-0 left-0 right-0 top-20 z-30 lg:left-30">
 <div className="h-full w-full overflow-y-auto bg-[var(--color-bg)] p-6 lg:p-8">
 <div className="flex items-start justify-between gap-4">
 <div className="flex min-w-0 items-center gap-4">
 <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border)] text-lg font-bold uppercase text-[var(--color-text-main)]">
 {d?.userId?.avatar ? (
 <img src={d.userId.avatar} alt="" className="h-full w-full object-cover" />
 ) : (
 d?.userId?.name?.charAt(0) || 'D'
 )}
 </div>
 <div className="min-w-0">
 <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
 {d?.userId?.name ?? 'Perfil del domiciliario'}
 </h2>
 {d && account && availability && (
 <p className="flex flex-wrap items-center gap-x-3 text-[11px] font-bold uppercase tracking-wide">
 <span className={accountStateStyles[account].text}>{accountStateStyles[account].label}</span>
 <span className={`inline-flex items-center gap-1.5 ${availability.text}`}>
 <span className={`h-1.5 w-1.5 rounded-full ${availability.dot}`} />
 {availability.label}
 </span>
 </p>
 )}
 {data && (
 <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
 <span className="font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 {currentView === 'full' ? 'Vista: datos completos' : 'Vista: enmascarada'}
 </span>
 {canSeeSensitive && (
 <button
 type="button"
 onClick={() => {
 setViewError('');
 setWantFull(currentView !== 'full');
 }}
 className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-text-main)]"
 >
 {currentView === 'full' ? (
 <><EyeOff className="h-3 w-3" /> Volver a la vista enmascarada</>
 ) : (
 <><Eye className="h-3 w-3" /> Ver datos completos</>
 )}
 </button>
 )}
 {switching && <span className="text-[var(--color-text-main)]">Cargando…</span>}
 </p>
 )}
 {viewError && (
 <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
 <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {viewError}
 </p>
 )}
 </div>
 </div>
 <button
 onClick={onClose}
 aria-label="Cerrar"
 className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)]"
 >
 <X className="h-4 w-4" /> Volver a domiciliarios
 </button>
 </div>

 {error ? (
 <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : !data || !d || !account ? (
 <p className="mt-6 text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <div className="mt-1 text-xs">
 <FichaHeader data={data} />
 <div className="mt-5 flex flex-wrap items-center gap-2.5 pb-6">
 {account === 'pending' && (
 <PermissionGate permission={Permission.DRIVERS_APPROVE}>
 <button
 onClick={() => runAction(`/drivers/${d._id}/approve`, 'No se pudo aprobar al domiciliario.')}
 className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-white"
 >
 <CheckCircle className="h-4 w-4" /> Aprobar
 </button>
 </PermissionGate>
 )}
 {account !== 'pending' && (
 <PermissionGate permission={Permission.DRIVERS_SUSPEND}>
 <button
 onClick={() => setConfirmSuspend(true)}
 className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-bold uppercase tracking-wider ${
 account === 'active'
 ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
 : 'border-[var(--color-primary)] text-[var(--color-text-main)]'
 }`}
 >
 {account === 'active' ? (
 <><Ban className="h-4 w-4" /> Suspender</>
 ) : (
 <><PlayCircle className="h-4 w-4" /> Reactivar</>
 )}
 </button>
 </PermissionGate>
 )}
 {account === 'active' && (
 <PermissionGate permission={Permission.DRIVERS_APPROVE}>
 <button
 onClick={() => requestSelfie(d._id)}
 className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)]"
 >
 <Camera className="h-4 w-4" /> Pedir selfie
 </button>
 </PermissionGate>
 )}
 {actionNote && <p className="font-semibold text-[var(--color-success)]">{actionNote}</p>}
 {actionError && (
 <p className="flex items-center gap-1.5 font-semibold text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4 shrink-0" /> {actionError}
 </p>
 )}
 </div>

 <DriverFichaTabs
 data={data}
 driverId={driverId}
 canApprove={canSeeDossier}
 onChanged={onChanged}
 alta={
account === 'pending' ? (() => {
 const stage = onboardingStages[onboardingStage(data.documents)];
 const count = (status: string) => data.documents.filter((doc) => doc.status === status).length;
 return (
 <Facts
 title="Alta"
 items={[
 ['Etapa', stage.label],
 ['Documentos', `${count('approved')} aprobados · ${count('pending')} en revisión · ${count('rejected') + count('expired')} rechazados o vencidos`],
 ['Registrado', relativeTime(d.createdAt)],
 ['Qué falta', stage.hint],
 ]}
 />
 );
 })() : undefined
 }
 />
 </div>
 )}
 </div>
 </div>

 {confirmSuspend && d && (
 <div>
 <ConfirmDialog
 title={d.isActive ? 'Suspender domiciliario' : 'Reactivar domiciliario'}
 message={
 d.isActive
 ? `¿Suspender a ${d.userId?.name}? No podrá recibir asignaciones. Si tiene un pedido en curso, la suspensión se rechaza.`
 : `¿Reactivar la cuenta de ${d.userId?.name}?`
 }
 confirmLabel={d.isActive ? 'Suspender' : 'Reactivar'}
 variant={d.isActive ? 'danger' : 'default'}
 reason={{
 label: d.isActive ? 'Motivo de la suspensión' : 'Motivo de la reactivación',
 placeholder: 'Queda en el historial del domiciliario',
 minLength: 5,
 }}
 onConfirm={(reason) => {
 setConfirmSuspend(false);
 runAction(
 `/admin/drivers/${d._id}/${d.isActive ? 'suspend' : 'reactivate'}`,
 'No se pudo actualizar al domiciliario.',
 { reason }
 );
 }}
 onCancel={() => setConfirmSuspend(false)}
 />
 </div>
 )}
 </>
 );
}
