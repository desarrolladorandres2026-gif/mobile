import { useLiveReload } from '../hooks/useLiveReload';
import { useCallback, useEffect, useState } from 'react';
import {
 Inbox, UserCheck, Send, CheckCircle2, AlertTriangle, Timer, Scale, Paperclip,
} from 'lucide-react';
import api from '../services/api';
import SupportMacros from './SupportMacros';
import Incidents from './Incidents';
import { Permission } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import { PermissionGate } from '../components/PermissionGate';
import EntityLink from '../components/EntityLink';
import InternalNotes from '../components/InternalNotes';
import { apiMessage } from '../lib/apiError';

/**
 * Bandeja de soporte al estilo de un cliente de correo: una fila por caso
 * (remitente, asunto y extracto en una sola línea, fecha a la derecha) y, al
 * hacer clic, la fila da paso a la vista completa del caso — igual que un
 * correo se abre reemplazando la lista, no al lado de ella.
 *
 * La cola llega ordenada por vencimiento y no por antigüedad: en comida a
 * domicilio, un reclamo de ayer ya no tiene arreglo.
 */

interface Ticket {
 _id: string;
 type: 'petition' | 'complaint' | 'claim' | 'suggestion';
 subject: string;
 detail: string;
 status: 'received' | 'in_review' | 'answered' | 'closed';
 priority: 'low' | 'normal' | 'high' | 'urgent';
 dueAt?: string | null;
 /** Plazo legal en días hábiles; distinto del SLA interno (`dueAt`). */
 legalDueAt?: string | null;
 legalOverdue?: boolean;
 legalDueSoon?: boolean;
 firstResponseAt?: string | null;
 assignedTo?: { _id: string; name?: string } | string | null;
 userId?: { _id?: string; name?: string; phone?: string } | string;
 orderId?: { _id: string; orderNumber?: string; status?: string } | null;
 businessId?: { _id: string; name?: string } | null;
 driverId?: { _id: string; userId?: { _id: string; name?: string } } | null;
 requesterRole?: 'customer' | 'business' | 'driver';
 /** Lo que eligió el comercio al abrirlo; el tipo ya viene derivado de esto. */
 reason?: keyof typeof REASON_LABEL | null;
 /** Adjuntos del solicitante; se abren con una URL firmada que queda en auditoría. */
 evidence?: Array<{ _id: string; name: string; uploadedAt: string }>;
 reopenCount?: number;
 resolvedByRequester?: boolean;
 refundRequest?: { status: 'pending' | 'done' | 'rejected'; reason: string; resolutionNote?: string } | null;
 responses?: Array<{ message: string; from?: 'staff' | 'requester'; createdAt: string }>;
 createdAt: string;
}

interface Macro {
 _id: string;
 title: string;
 body: string;
 appliesTo: Ticket['type'][];
}

interface Metrics {
 open: number;
 overdue: number;
 unassigned: number;
 legalOverdue: number;
 legalDueSoon: number;
 refundRequests: number;
 averageFirstResponseMinutes: number;
 averageResolutionHours: number;
}

const PAGE = 100;

const REFUND_STATE: Record<'pending' | 'done' | 'rejected', string> = {
 pending: 'pendiente con Finanzas',
 done: 'atendido por Finanzas',
 rejected: 'rechazado por Finanzas',
};

const shortDate = (iso: string) =>
 new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

const TYPE_LABEL: Record<Ticket['type'], string> = {
 petition: 'Petición',
 complaint: 'Queja',
 claim: 'Reclamo',
 suggestion: 'Sugerencia',
};

const REASON_LABEL = {
 driver_no_show: 'El domiciliario no llegó',
 order_issue: 'Problema con el pedido',
 customer_unreachable: 'El cliente no responde',
 payment: 'Cobro o liquidación',
 account: 'Cuenta o local',
} as const;

const REQUESTER_LABEL: Record<NonNullable<Ticket['requesterRole']>, string> = {
 customer: 'Cliente',
 business: 'Comercio',
 driver: 'Domiciliario',
};

/** Sustituye las variables de una respuesta predefinida con los datos del caso. */
function fillMacro(body: string, ticket: Ticket, agent?: string): string {
 const client = typeof ticket.userId === 'object' ? ticket.userId?.name : undefined;
 return body
 .replace(/\{\{cliente\}\}/g, client ?? '')
 .replace(/\{\{pedido\}\}/g, ticket.orderId ? `#${ticket.orderId.orderNumber ?? ticket.orderId._id.slice(-8)}` : '')
 .replace(/\{\{agente\}\}/g, agent ?? '');
}

const PRIORITY: Record<Ticket['priority'], { label: string; tone: string }> = {
 urgent: { label: 'Urgente', tone: 'text-[var(--color-danger)]' },
 high: { label: 'Alta', tone: 'text-[var(--color-text-main)]' },
 normal: { label: 'Normal', tone: 'text-[var(--color-text-main)]' },
 low: { label: 'Baja', tone: 'text-[var(--color-text-main)]' },
};

/** Cuánto queda o cuánto lleva vencido. El signo es el dato. */
function dueLabel(dueAt?: string | null): { text: string; overdue: boolean } | null {
 if (!dueAt) return null;
 const diff = new Date(dueAt).getTime() - Date.now();
 const minutes = Math.round(Math.abs(diff) / 60000);
 const human = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
 return diff < 0 ? { text: `vencido hace ${human}`, overdue: true } : { text: `vence en ${human}`, overdue: false };
}

/** Id del usuario cuando el ticket llega con `userId` poblado. */
const userIdOf = (value: Ticket['userId']): string | undefined =>
 value && typeof value === 'object' ? value._id : undefined;

const phoneOf = (value: Ticket['userId']): string | null =>
 value && typeof value === 'object' && value.phone ? value.phone : null;

const nameOf = (value: Ticket['userId'] | Ticket['assignedTo']): string | null => {
 if (!value || typeof value === 'string') return null;
 return value.name ?? null;
};

export default function Support() {
 const [tickets, setTickets] = useState<Ticket[]>([]);
 const [loading, setLoading] = useState(true);
 const [onlyOverdue, setOnlyOverdue] = useState(false);
 const [onlyLegalOverdue, setOnlyLegalOverdue] = useState(false);
 const [selectedId, setSelectedId] = useState<string | null>(null);
 const [view, setView] = useState<'open' | 'answered' | 'closed'>('open');
 const [scope, setScope] = useState<'all' | 'mine' | 'unassigned' | 'refund'>('all');
 const [limit, setLimit] = useState(PAGE);
 const [metrics, setMetrics] = useState<Metrics | null>(null);
 const [refundReason, setRefundReason] = useState('');
 const myId = useAuthStore((state) => state.user?._id);
 const [type, setType] = useState('');
 const [requester, setRequester] = useState('');
 const [search, setSearch] = useState('');
 const [term, setTerm] = useState('');
 const [macros, setMacros] = useState<Macro[]>([]);
 const [panel, setPanel] = useState<'macros' | 'incidents' | null>(null);
 const agentName = useAuthStore((state) => state.user?.name);
 const [reply, setReply] = useState('');
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 const params: Record<string, string> = { limit: String(limit) };
 if (onlyOverdue) params.overdue = 'true';
 if (onlyLegalOverdue) params.legalOverdue = 'true';
 if (view !== 'open') params.view = view;
 if (scope === 'mine' && myId) params.assignedTo = myId;
 if (scope === 'unassigned') params.unassigned = 'true';
 if (scope === 'refund') params.refundRequested = 'true';
 if (type) params.type = type;
 if (requester) params.requesterRole = requester;
 if (term) params.q = term;
 const [queue, stats] = await Promise.all([
 api.get('/pqrs/support/queue', { params }),
 api.get('/pqrs/support/metrics').catch(() => null),
 ]);
 setTickets(queue.data.data ?? []);
 if (stats) setMetrics(stats.data.data ?? null);
 setError('');
 } catch (err) {
 console.error(err);
 setError(apiMessage(err, 'No se pudo cargar la bandeja de soporte.'));
 } finally {
 setLoading(false);
 }
 }, [onlyOverdue, onlyLegalOverdue, view, scope, limit, myId, type, requester, term]);

 useLiveReload(['support'], load);
 useEffect(() => {
 load();
 }, [load]);

 // La búsqueda espera a que se deje de teclear: una consulta por letra es ruido.
 useEffect(() => {
 const t = setTimeout(() => setTerm(search.trim()), 350);
 return () => clearTimeout(t);
 }, [search]);

 useEffect(() => {
 api.get('/pqrs/macros').then((r) => setMacros(r.data.data ?? [])).catch(() => setMacros([]));
 }, []);

 // Si el filtro cambia y el caso abierto ya no está en la lista, cierra el detalle.
 useEffect(() => {
 if (selectedId && !tickets.some((t) => t._id === selectedId)) setSelectedId(null);
 }, [tickets, selectedId]);

 const selected = tickets.find((t) => t._id === selectedId) ?? null;

 /** Envuelve una acción para que el error se vea en la pantalla, no en la consola. */
 const run = async (action: () => Promise<unknown>) => {
 setError('');
 setBusy(true);
 try {
 await action();
 await load();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo completar la acción.'));
 } finally {
 setBusy(false);
 }
 };

 /** Abre un adjunto: la URL se firma al pedirla y cada consulta queda en auditoría. */
 const openEvidence = async (ticketId: string, evidenceId: string) => {
 // La pestaña se abre antes de la espera: tras un `await` el navegador la bloquearía.
 const tab = window.open('about:blank', '_blank');
 if (tab) tab.opener = null;
 try {
 const { data } = await api.get(`/pqrs/support/${ticketId}/evidence/${evidenceId}/url`);
 if (tab) tab.location.href = data.data.url;
 } catch (err) {
 tab?.close();
 setError(apiMessage(err, 'No se pudo abrir el adjunto.'));
 }
 };

 const openTicket = (id: string) => {
 setSelectedId(id === selectedId ? null : id);
 setReply('');
 setError('');
 };

 const changePriority = (id: string, priority: string) =>
 run(() => api.patch(`/pqrs/${id}/classify`, { priority }));

 const assignToMe = (id: string) => run(() => api.patch(`/pqrs/${id}/assign`, {}));

 const reopen = (id: string) => run(() => api.patch(`/pqrs/${id}/reopen`, {}));

 const requestRefund = (id: string) =>
 run(async () => {
 if (refundReason.trim().length < 5) throw { response: { data: { message: 'Explica por qué se debe reembolsar (mínimo 5 caracteres).' } } };
 await api.patch(`/pqrs/${id}/refund-request`, { reason: refundReason.trim() });
 setRefundReason('');
 });

 const respond = (id: string) =>
 run(async () => {
 if (reply.trim().length < 2) throw { response: { data: { message: 'Escribe la respuesta.' } } };
 await api.patch(`/pqrs/${id}/respond`, { message: reply.trim() });
 setReply('');
 });

 const close = (id: string) =>
 run(async () => {
 await api.patch(`/pqrs/${id}/close`, reply.trim() ? { message: reply.trim() } : {});
 setReply('');
 setSelectedId(null);
 });

 if (panel) {
 return (
 <div className="animate-fade-in space-y-3">
 <button
 onClick={() => setPanel(null)}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)] underline"
 >
 ← Volver a la bandeja
 </button>
 {panel === 'macros' ? <SupportMacros /> : <Incidents />}
 </div>
 );
 }

 if (selected) {
 return (
 <div className="animate-fade-in space-y-4">
 <button
 onClick={() => setSelectedId(null)}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)] hover:text-[var(--color-text-main)]"
 >
 ‹ Volver a la bandeja
 </button>

 {error ? (
 <p className="flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : null}

 <div className="max-w-2xl space-y-4">
 <div className="space-y-1.5">
 <div className="flex flex-wrap items-center gap-2">
 <h2 className="text-lg font-bold text-[var(--color-text-main)]">{selected.subject}</h2>
 <span className={`text-[11px] font-bold uppercase tracking-wider ${PRIORITY[selected.priority].tone}`}>
 {PRIORITY[selected.priority].label}
 </span>
 </div>
 <p className="text-xs uppercase tracking-wider text-[var(--color-text-main)] opacity-70">
 {TYPE_LABEL[selected.type]}{selected.reason ? ` (${REASON_LABEL[selected.reason]})` : ''} · {REQUESTER_LABEL[selected.requesterRole ?? 'customer']} ·{' '}
 <EntityLink type="user" id={userIdOf(selected.userId)}>{nameOf(selected.userId) ?? 'Usuario'}</EntityLink> ·{' '}
 {nameOf(selected.assignedTo) ? `lo lleva ${nameOf(selected.assignedTo)}` : 'sin asignar'}
 </p>
 <div className="flex flex-wrap items-center gap-3 text-xs">
 {selected.legalDueAt ? (
 <span
 className={`flex items-center gap-1 font-bold ${
 selected.legalOverdue
 ? 'text-[var(--color-danger)]'
 : selected.legalDueSoon
 ? 'text-[var(--color-text-main)]'
 : 'text-[var(--color-text-main)]'
 }`}
 >
 <Scale className="h-3.5 w-3.5" />
 {selected.legalOverdue ? 'Plazo legal vencido el ' : 'Plazo legal: '}
 {shortDate(selected.legalDueAt)}
 </span>
 ) : null}
 {dueLabel(selected.dueAt) ? (
 <span
 className={`flex items-center gap-1 font-semibold ${
 dueLabel(selected.dueAt)!.overdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'
 }`}
 >
 <Timer className="h-3.5 w-3.5" /> SLA {dueLabel(selected.dueAt)!.text}
 </span>
 ) : null}
 </div>
 {selected.resolvedByRequester ? (
 <p className="text-xs font-semibold text-[var(--color-success)]">El solicitante confirmó que quedó resuelto.</p>
 ) : null}
 {selected.reopenCount ? (
 <p className="text-xs font-semibold text-[var(--color-text-main)]">
 Reabierto por el solicitante {selected.reopenCount} {selected.reopenCount === 1 ? 'vez' : 'veces'}: el problema siguió.
 </p>
 ) : null}
 {phoneOf(selected.userId) ? (
 <p className="text-xs text-[var(--color-text-main)]">
 Teléfono:{' '}
 <a href={`tel:${phoneOf(selected.userId)}`} className="font-semibold underline">{phoneOf(selected.userId)}</a>
 </p>
 ) : null}
 {(selected.orderId || selected.businessId || selected.driverId) && (
 <p className="text-xs text-[var(--color-text-main)]">
 {selected.orderId ? (
 <EntityLink type="order" id={selected.orderId._id}>
 Pedido #{selected.orderId.orderNumber ?? selected.orderId._id.slice(-8)}
 </EntityLink>
 ) : null}
 {selected.businessId?.name ? (
 <>
 {' · '}
 <EntityLink type="business" id={selected.businessId._id}>{selected.businessId.name}</EntityLink>
 </>
 ) : null}
 {selected.driverId?.userId?.name ? (
 <>
 {' · domiciliario '}
 <EntityLink type="driver" id={selected.driverId._id}>{selected.driverId.userId.name}</EntityLink>
 </>
 ) : null}
 </p>
 )}
 </div>

 <div className="flex flex-wrap items-center gap-2 border-y border-[var(--color-border-light)] py-2">
 <EntityLink
 type="user"
 id={userIdOf(selected.userId)}
 hideWhenDenied
 className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] hover:no-underline"
 >
 Ver cuenta
 </EntityLink>
 {typeof selected.assignedTo === 'object' && selected.assignedTo?._id === myId ? null : (
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => assignToMe(selected._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 <UserCheck className="h-3.5 w-3.5" /> {nameOf(selected.assignedTo) ? 'Tomarlo yo' : 'Asignármelo'}
 </button>
 </PermissionGate>
 )}
 {selected.status === 'closed' ? (
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => reopen(selected._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 Reabrir caso
 </button>
 </PermissionGate>
 ) : null}
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Prioridad
 <select
 value={selected.priority}
 disabled={busy}
 onChange={(e) => changePriority(selected._id, e.target.value)}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 {Object.entries(PRIORITY).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
 </select>
 </label>
 </PermissionGate>
 </div>

 <p className="whitespace-pre-wrap text-sm text-[var(--color-text-main)]">
 {selected.detail}
 </p>

 {selected.evidence?.length ? (
 <ul className="space-y-1 text-xs">
 {selected.evidence.map((item) => (
 <li key={item._id} className="flex items-center gap-1.5 text-[var(--color-text-main)]">
 <Paperclip className="h-3.5 w-3.5 shrink-0" />
 <button onClick={() => openEvidence(selected._id, item._id)} className="cursor-pointer truncate underline underline-offset-2">
 {item.name}
 </button>
 </li>
 ))}
 </ul>
 ) : null}

 {selected.responses?.length ? (
 <ul className="space-y-2">
 {selected.responses.map((r, index) => (
 <li
 key={index}
 className={`pl-3 text-sm text-[var(--color-text-main)] ${
 r.from === 'requester' ? 'border-l-2 border-[var(--color-border)]' : 'border-l-2 border-[var(--color-primary)]'
 }`}
 >
 <span className="block text-[11px] font-semibold opacity-70">
 {r.from === 'requester' ? (nameOf(selected.userId) ?? 'Solicitante') : 'ZIPP'} ·{' '}
 {new Date(r.createdAt).toLocaleString('es-CO')}
 </span>
 {r.message}
 </li>
 ))}
 </ul>
 ) : null}

 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-4">
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <select
 value=""
 onChange={(e) => {
 const macro = macros.find((m) => m._id === e.target.value);
 if (macro) setReply(fillMacro(macro.body, selected, agentName));
 }}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="">Insertar respuesta predefinida…</option>
 {macros
 .filter((m) => m.appliesTo.length === 0 || m.appliesTo.includes(selected.type))
 .map((m) => <option key={m._id} value={m._id}>{m.title}</option>)}
 </select>

 <textarea
 value={reply}
 onChange={(e) => setReply(e.target.value)}
 rows={4}
 placeholder="Lamentamos lo ocurrido. Ya le reembolsamos el pedido completo."
 className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]"
 />

 <div className="flex justify-end gap-2">
 <button
 onClick={() => respond(selected._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 <Send className="h-3.5 w-3.5" /> Responder
 </button>
 <button
 onClick={() => close(selected._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-success)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
 >
 <CheckCircle2 className="h-3.5 w-3.5" /> Responder y cerrar
 </button>
 </div>
 </PermissionGate>
 </div>

 {selected.orderId ? (
 <section className="space-y-2 border-t border-[var(--color-border-light)] pt-4">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Reembolso</h3>
 {selected.refundRequest ? (
 <p className="text-xs text-[var(--color-text-main)]">
 Solicitud {REFUND_STATE[selected.refundRequest.status]}: {selected.refundRequest.reason}
 {selected.refundRequest.resolutionNote ? ` — ${selected.refundRequest.resolutionNote}` : ''}
 </p>
 ) : null}
 {selected.refundRequest?.status !== 'pending' && selected.status !== 'closed' ? (
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <p className="text-xs text-[var(--color-text-main)] opacity-70">
 Soporte no reembolsa: la solicitud llega a Finanzas, que decide en la ficha del pedido.
 </p>
 <input
 value={refundReason}
 onChange={(e) => setRefundReason(e.target.value)}
 maxLength={500}
 placeholder="Por qué se debe reembolsar"
 className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-main)]"
 />
 <button
 onClick={() => requestRefund(selected._id)}
 disabled={busy}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 Solicitar reembolso a Finanzas
 </button>
 </PermissionGate>
 ) : null}
 </section>
 ) : null}

 <section className="space-y-2 border-t border-[var(--color-border-light)] pt-4">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Notas internas</h3>
 <InternalNotes entityType="pqrs" entityId={selected._id} />
 </section>
 </div>
 </div>
 );
 }

 return (
 <div className="animate-fade-in space-y-3">
 <div className="page-header">
 <div>
 <h1 className="page-title">Soporte</h1>
 <p className="page-subtitle">
 PQRS de clientes, comercios y domiciliarios en una sola bandeja. Primero lo que vence por ley, luego por SLA interno
 </p>
 </div>
 </div>

 {metrics ? (
 <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--color-text-main)]">
 {([
 ['Abiertos', String(metrics.open), false],
 ['Sin asignar', String(metrics.unassigned), false],
 ['SLA vencido', String(metrics.overdue), metrics.overdue > 0],
 ['Plazo legal vencido', String(metrics.legalOverdue), metrics.legalOverdue > 0],
 ['Reembolsos pedidos', String(metrics.refundRequests), false],
 ['1ª respuesta', `${metrics.averageFirstResponseMinutes} min`, false],
 ['Resolución (aprox.)', `${metrics.averageResolutionHours} h`, false],
 ] as const).map(([label, value, alert]) => (
 <div key={label} className="flex items-baseline gap-1.5">
 <dd className={`text-sm font-bold ${alert ? 'text-[var(--color-danger)]' : ''}`}>{value}</dd>
 <dt className="opacity-70">{label}</dt>
 </div>
 ))}
 </dl>
 ) : null}

 <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--color-border-light)] pb-3">
 <div className="flex gap-4">
 {([['open', 'Por responder'], ['answered', 'Respondidos'], ['closed', 'Cerrados']] as const).map(([key, label]) => (
 <button
 key={key}
 onClick={() => setView(key)}
 className={`cursor-pointer pb-1.5 text-xs font-bold ${
 view === key
 ? 'border-b-2 border-[var(--color-primary)] text-[var(--color-text-main)]'
 : 'text-[var(--color-text-main)]'
 }`}
 >
 {label}
 {view === key && tickets.length > 0 ? (
 <span className="ml-1.5 font-normal text-[var(--color-text-main)] opacity-70">{tickets.length}</span>
 ) : null}
 </button>
 ))}
 </div>
 <select
 value={scope}
 onChange={(e) => { setScope(e.target.value as typeof scope); setLimit(PAGE); }}
 aria-label="De quién son los casos"
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="all">Todos los casos</option>
 <option value="mine">Mis casos</option>
 <option value="unassigned">Sin asignar</option>
 <option value="refund">Reembolso pendiente</option>
 </select>
 <select
 value={type}
 onChange={(e) => setType(e.target.value)}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="">Todos los tipos</option>
 {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
 </select>
 <select
 value={requester}
 onChange={(e) => setRequester(e.target.value)}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="">Quien lo abrió: todos</option>
 {Object.entries(REQUESTER_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
 </select>
 <input
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Asunto, nombre, teléfono o n.º de pedido"
 className="w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-main)]"
 />
 <button
 onClick={() => setPanel('macros')}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)] underline"
 >
 Respuestas predefinidas
 </button>
 <PermissionGate permission={Permission.ADMIN_PANEL}>
 <button
 onClick={() => setPanel('incidents')}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)] underline"
 >
 Incidentes
 </button>
 </PermissionGate>
 <label className="flex w-fit cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 <input
 type="checkbox"
 checked={onlyLegalOverdue}
 onChange={(e) => setOnlyLegalOverdue(e.target.checked)}
 className="cursor-pointer accent-[var(--color-primary)]"
 />
 Solo plazo legal vencido
 </label>
 <label className="flex w-fit cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--color-text-main)]">
 <input
 type="checkbox"
 checked={onlyOverdue}
 onChange={(e) => setOnlyOverdue(e.target.checked)}
 className="cursor-pointer accent-[var(--color-primary)]"
 />
 Solo SLA interno vencido
 </label>
 </div>

 {error ? (
 <p className="mt-2 flex shrink-0 items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : null}

 {loading && tickets.length === 0 ? (
 <p className="mt-3 text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : tickets.length === 0 ? (
 <div className="flex flex-col items-center gap-2 py-16">
 <Inbox className="h-8 w-8 text-[var(--color-success)]" />
 <p className="font-semibold text-[var(--color-text-main)]">La bandeja está vacía</p>
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">De</th>
 <th className="table-header-cell">Asunto</th>
 <th className="table-header-cell">Tipo</th>
 <th className="table-header-cell">Prioridad</th>
 <th className="table-header-cell">Plazo</th>
 <th className="table-header-cell">Asignado</th>
 <th className="table-header-cell">Fecha</th>
 </tr>
 </thead>
 <tbody>
 {tickets.map((ticket) => {
 const due = dueLabel(ticket.dueAt);
 const agent = nameOf(ticket.assignedTo);
 const unanswered = ticket.status === 'received' || ticket.status === 'in_review';
 const from = nameOf(ticket.userId) ?? REQUESTER_LABEL[ticket.requesterRole ?? 'customer'];

 return (
 <tr
 key={ticket._id}
 onClick={() => openTicket(ticket._id)}
 className="cursor-pointer hover:!bg-[var(--color-bg-alt)] transition-colors"
 >
 <td className={`table-body-cell ${unanswered ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}>{from}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{ticket.subject}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{TYPE_LABEL[ticket.type]}</td>
 <td className={`table-body-cell ${PRIORITY[ticket.priority].tone}`}>{PRIORITY[ticket.priority].label}</td>
 <td className={`table-body-cell ${ticket.legalOverdue || due?.overdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {ticket.legalOverdue ? 'Plazo legal vencido' : due?.overdue ? 'SLA vencido' : due?.text ?? '—'}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{agent ?? '—'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{shortDate(ticket.createdAt)}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 {tickets.length >= limit ? (
 <button
 onClick={() => setLimit((n) => n + PAGE)}
 className="w-full cursor-pointer py-3 text-xs font-semibold text-[var(--color-text-main)] underline"
 >
 Ver más casos
 </button>
 ) : null}
 </div>
 )}
 </div>
 );
}
