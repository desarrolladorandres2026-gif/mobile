import { useCallback, useEffect, useState } from 'react';
import { X, AlertTriangle, CheckCircle, Ban, PlayCircle, Eye, EyeOff, Camera } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from './ConfirmDialog';
import EntityLink from './EntityLink';
import InternalNotes from './InternalNotes';
import { PermissionGate } from './PermissionGate';
import type { NoteView, ProfileView } from '../lib/fichaTypes';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import { apiMessage } from '../lib/apiError';
import {
 accountStateStyles,
 availabilityStyles,
 dateTime,
 day,
 driverAccountState,
 money,
 relativeTime,
 vehicleLabel,
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

interface Profile360 {
 driver: DriverDetail;
 documents: Array<{
 _id: string;
 type: string;
 /** Sin `users:view_sensitive` llega reducida a los 4 últimos caracteres. */
 reference?: string;
 expiresAt?: string;
 status: string;
 reviewedAt?: string;
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

const documentTypeLabels: Record<string, string> = {
 identity: 'Documento de identidad',
 license: 'Licencia de conducción',
 soat: 'SOAT',
 technical_review: 'Revisión técnico-mecánica',
 vehicle_registration: 'Tarjeta de propiedad',
};

const documentStatusStyles: Record<string, { label: string; text: string }> = {
 pending: { label: 'Por revisar', text: 'text-[var(--color-warning)]' },
 approved: { label: 'Aprobado', text: 'text-[#047857]' },
 rejected: { label: 'Rechazado', text: 'text-[var(--color-danger)]' },
 expired: { label: 'Vencido', text: 'text-[var(--color-danger)]' },
};

const sosStatusLabels: Record<string, string> = {
 active: 'Activa',
 acknowledged: 'Atendida',
 resolved: 'Resuelta',
 false_alarm: 'Falsa alarma',
};

const sanctionLabels: Record<string, string> = {
 DRIVER_APPROVED: 'Aprobado',
 DRIVER_SUSPENDED: 'Suspendido',
 DRIVER_REACTIVATED: 'Reactivado',
};

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
 return (
 <section className="space-y-5 border-t border-[var(--color-border-light)] py-7">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h3>
 {children}
 </section>
 );
}

function Sub({ title, empty, children }: { title: string; empty?: string; children?: React.ReactNode }) {
 return (
 <div className="space-y-2">
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{title}</p>
 {children ?? <p className="text-[var(--color-text-main)]">{empty ?? 'Nada por aquí.'}</p>}
 </div>
 );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
 return (
 <div className="min-w-0">
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 <p className="truncate text-sm font-semibold text-[var(--color-text-main)]">{value || '—'}</p>
 </div>
 );
}

function Row({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
 return (
 <li className="flex justify-between gap-3">
 <span className="min-w-0 text-[var(--color-text-main)]">{left}</span>
 {right !== undefined && (
 <span className="shrink-0 font-semibold text-[var(--color-text-main)]">{right}</span>
 )}
 </li>
 );
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

 const runAction = async (path: string, fallback: string) => {
 try {
 setActionError('');
 await api.patch(path);
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
 <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
 <div
 className="h-full w-full max-w-2xl overflow-y-auto bg-[var(--color-surface)] p-7"
 onClick={(e) => e.stopPropagation()}
 >
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
 className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]"
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
 className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-main)]"
 >
 <X className="h-4 w-4" />
 </button>
 </div>

 {error ? (
 <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : !data || !d || !account ? (
 <p className="mt-6 text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <div className="mt-5 text-xs">
 <div className="flex flex-wrap items-center gap-2.5 pb-6">
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
 : 'border-[var(--color-primary)] text-[var(--color-primary)]'
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

 {account === 'pending' && (
 <Section title="Alta">
 {(() => {
 const stage = onboardingStages[onboardingStage(data.documents)];
 const count = (status: string) => data.documents.filter((doc) => doc.status === status).length;
 return (
 <>
 <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
 <Fact label="Etapa" value={stage.label} />
 <Fact
 label="Documentos"
 value={`${count('approved')} aprobados · ${count('pending')} en revisión · ${count('rejected') + count('expired')} rechazados o vencidos`}
 />
 <Fact label="Registrado" value={relativeTime(d.createdAt)} />
 </div>
 <p className="text-[var(--color-text-main)]">{stage.hint}</p>
 </>
 );
 })()}
 </Section>
 )}

 <Section title="Identidad, documentos y vehículo">
 <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
 <Fact
 label="Documento"
 value={[
 d.userId?.documentType,
 d.userId?.documentNumber ?? (d.userId?.documentNumberLast4 ? `•••• ${d.userId.documentNumberLast4}` : ''),
 ]
 .filter(Boolean)
 .join(' ')}
 />
 <Fact label="Teléfono" value={d.userId?.phone} />
 <Fact label="Correo" value={d.userId?.email} />
 <Fact label="Vehículo" value={vehicleLabel(d.vehicleType)} />
 <Fact label="Placa" value={d.licensePlate} />
 <Fact label="Registro" value={day(d.createdAt)} />
 <Fact label="Cuenta" value={d.userId?.isBlocked ? 'Bloqueada' : 'Activa'} />
 <Fact label="Última conexión" value={relativeTime(d.lastLocationAt ?? d.userId?.lastLoginAt)} />
 <Fact label="Batería" value={d.batteryLevel != null ? `${d.batteryLevel}%` : undefined} />
 </div>

 <Sub
 title="Contacto de emergencia"
 empty="No registró contacto de emergencia."
 >
 {d.emergencyContact ? (
 <p className="text-[var(--color-text-main)]">
 {d.emergencyContact.name}
 {d.emergencyContact.relationship ? ` (${d.emergencyContact.relationship})` : ''} ·{' '}
 {d.emergencyContact.phone}
 </p>
 ) : undefined}
 </Sub>

 <Sub title="Documentos" empty="Aún no ha subido documentos.">
 {data.documents.length ? (
 <ul className="space-y-1.5">
 {data.documents.map((doc) => {
 const st = documentStatusStyles[doc.status] ?? { label: doc.status, text: '' };
 return (
 <Row
 key={doc._id}
 left={
 <>
 {documentTypeLabels[doc.type] ?? doc.type}
 {doc.reference ? ` · ${doc.reference}` : ''}
 {doc.expiresAt ? ` · vence ${day(doc.expiresAt)}` : ''}
 </>
 }
 right={<span className={st.text}>{st.label}</span>}
 />
 );
 })}
 </ul>
 ) : undefined}
 </Sub>
 </Section>

 <Section title="Actividad y desempeño">
 <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
 <Fact label="Entregas" value={String(d.totalDeliveries ?? 0)} />
 <Fact label="Entregados" value={String(data.activity.totals.delivered)} />
 <Fact label="Cancelados" value={String(data.activity.totals.cancelled)} />
 <Fact
 label="Calificación"
 value={`${d.rating > 0 ? d.rating.toFixed(1) : 'S/V'} (${d.totalReviews ?? 0})`}
 />
 </div>

 <Sub title="Zonas habituales (aproximado)" empty="Aún sin suficientes entregas.">
 {data.activity.coverageZones.length ? (
 <ul className="space-y-1.5">
 {data.activity.coverageZones.map((z) => (
 <Row key={z.zone} left={z.zone} right={`${z.count} pedidos`} />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="Últimos pedidos" empty="Sin pedidos todavía.">
 {data.activity.recentOrders.length ? (
 <ul className="space-y-1.5">
 {data.activity.recentOrders.map((o) => (
 <Row
 key={o._id}
 left={
 <>
 <EntityLink type="order" id={o._id}>
 {o.orderNumber ?? 'Pedido'}
 </EntityLink>
 {` · ${o.status} · ${day(o.createdAt)}`}
 </>
 }
 right={money(o.total)}
 />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="Calificaciones de clientes" empty="Sin calificaciones todavía.">
 {data.activity.reviews.length ? (
 <ul className="space-y-1.5">
 {data.activity.reviews.map((r) => (
 <Row
 key={r._id}
 left={`${day(r.createdAt)}${r.comment ? ` — ${r.comment}` : ''}`}
 right={`${r.rating}★`}
 />
 ))}
 </ul>
 ) : undefined}
 </Sub>
 </Section>

 {data.finance && (
 <Section title="Finanzas">
 <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
 {d.baseFund != null && <Fact label="Fondo base" value={money(d.baseFund)} />}
 {d.currentFund != null && <Fact label="Fondo actual" value={money(d.currentFund)} />}
 <Fact label="Deuda pendiente" value={money(data.finance.pendingDebts.total)} />
 <Fact label="Ganancias 30 días" value={money(data.finance.earningsLast30Days)} />
 {(data.finance.totalEarnings ?? d.totalEarnings) != null && (
 <Fact label="Ganancias acumuladas" value={money(data.finance.totalEarnings ?? d.totalEarnings)} />
 )}
 </div>

 <Sub title="Pagos al domiciliario" empty="Sin pagos registrados.">
 {data.finance.payouts.length ? (
 <ul className="space-y-1.5">
 {data.finance.payouts.map((p) => (
 <Row key={p._id} left={`${day(p.createdAt)} · ${p.status}`} right={money(p.amount)} />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="Liquidaciones" empty="Sin liquidaciones.">
 {data.finance.settlements.length ? (
 <ul className="space-y-1.5">
 {data.finance.settlements.map((s) => (
 <Row
 key={s._id}
 left={`${day(s.periodStart)} – ${day(s.periodEnd)}`}
 right={money(s.netAmount)}
 />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="Deudas de efectivo pendientes" empty="No tiene deudas pendientes.">
 {data.finance.pendingDebts.items.length ? (
 <ul className="space-y-1.5">
 {data.finance.pendingDebts.items.map((debt) => (
 <Row key={debt._id} left={day(debt.createdAt)} right={money(debt.amount)} />
 ))}
 </ul>
 ) : undefined}
 </Sub>
 </Section>
 )}

 <Section title="Incidencias y soporte">
 <Sub title="Alertas SOS" empty="Sin alertas SOS.">
 {data.incidents.sos.length ? (
 <ul className="space-y-1.5">
 {data.incidents.sos.map((s) => (
 <Row
 key={s._id}
 left={`${dateTime(s.createdAt)}${s.note ? ` — ${s.note}` : ''}`}
 right={sosStatusLabels[s.status] ?? s.status}
 />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="Aprobaciones y suspensiones" empty="Sin movimientos registrados.">
 {data.incidents.sanctions.length ? (
 <ul className="space-y-1.5">
 {data.incidents.sanctions.map((s) => (
 <Row
 key={s._id}
 left={`${dateTime(s.createdAt)}${s.actorName ? ` · ${s.actorName}` : ''}`}
 right={sanctionLabels[s.action] ?? s.action}
 />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 <Sub title="PQRS de sus pedidos" empty="Sin PQRS relacionadas.">
 {data.incidents.pqrs.length ? (
 <ul className="space-y-1.5">
 {data.incidents.pqrs.map((p) => (
 <Row key={p._id} left={`${p.subject ?? 'PQRS'} · ${day(p.createdAt)}`} right={p.status} />
 ))}
 </ul>
 ) : undefined}
 </Sub>

 </Section>

 {data.notes !== null && (
 <Section title="Notas internas">
 <InternalNotes entityType="driver" entityId={driverId} />
 </Section>
 )}
 </div>
 )}
 </div>

 {confirmSuspend && d && (
 // El diálogo cuelga del fondo que cierra el panel: sin esto, pulsar
 //"Cancelar" o"Confirmar" cerraba también la ficha.
 <div onClick={(e) => e.stopPropagation()}>
 <ConfirmDialog
 title={d.isActive ? 'Suspender domiciliario' : 'Reactivar domiciliario'}
 message={
 d.isActive
 ? `¿Suspender a ${d.userId?.name}? No podrá recibir asignaciones. Si tiene un pedido en curso, la suspensión se rechaza.`
 : `¿Reactivar la cuenta de ${d.userId?.name}?`
 }
 confirmLabel={d.isActive ? 'Suspender' : 'Reactivar'}
 variant={d.isActive ? 'danger' : 'default'}
 onConfirm={() => {
 setConfirmSuspend(false);
 runAction(
 `/admin/drivers/${d._id}/${d.isActive ? 'suspend' : 'reactivate'}`,
 'No se pudo actualizar al domiciliario.'
 );
 }}
 onCancel={() => setConfirmSuspend(false)}
 />
 </div>
 )}
 </div>
 );
}
