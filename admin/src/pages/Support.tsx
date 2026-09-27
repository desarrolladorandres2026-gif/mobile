import { useCallback, useEffect, useState } from 'react';
import {
 Inbox, RotateCw, UserCheck, Send, CheckCircle2, AlertTriangle, Timer, Scale,
} from 'lucide-react';
import api from '../services/api';
import { Link } from 'react-router-dom';
import { Permission } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import { PermissionGate } from '../components/PermissionGate';
import EntityLink from '../components/EntityLink';
import { apiMessage } from '../lib/apiError';

/**
 * Bandeja de soporte.
 *
 * `Pqrs` ya guardaba tipo, estado, evidencias y respuestas: era una lista.
 * Lo que la convierte en una cola de trabajo son las tres cosas que aquí se
 * pintan y se pueden cambiar — quién lo tiene, cuándo vence y cuánto se
 * tardó en contestar.
 *
 * La cola llega ordenada por vencimiento y no por antigüedad, que es la
 * diferencia entre atender lo urgente y atender lo que llegó primero: en
 * comida a domicilio, un reclamo de ayer ya no tiene arreglo.
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
 responses?: Array<{ message: string; createdAt: string }>;
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
 averageFirstResponseMinutes: number;
 legalOverdue?: number;
 legalDueSoon?: number;
}

const shortDate = (iso: string) =>
 new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

const TYPE_LABEL: Record<Ticket['type'], string> = {
 petition: 'Petición',
 complaint: 'Queja',
 claim: 'Reclamo',
 suggestion: 'Sugerencia',
};

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

const PRIORITY: Record<Ticket['priority'], { label: string; chip: string }> = {
 urgent: { label: 'Urgente', chip: 'bg-[var(--color-danger)] text-white' },
 high: { label: 'Alta', chip: 'bg-[var(--color-warning)] text-white' },
 normal: { label: 'Normal', chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-main)]' },
 low: { label: 'Baja', chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-main)]' },
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

const nameOf = (value: Ticket['userId'] | Ticket['assignedTo']): string | null => {
 if (!value || typeof value === 'string') return null;
 return value.name ?? null;
};

export default function Support() {
 const [tickets, setTickets] = useState<Ticket[]>([]);
 const [metrics, setMetrics] = useState<Metrics | null>(null);
 const [loading, setLoading] = useState(true);
 const [onlyOverdue, setOnlyOverdue] = useState(false);
 const [onlyLegalOverdue, setOnlyLegalOverdue] = useState(false);
 const [openId, setOpenId] = useState<string | null>(null);
 const [view, setView] = useState<'open' | 'answered'>('open');
 const [type, setType] = useState('');
 const [requester, setRequester] = useState('');
 const [search, setSearch] = useState('');
 const [term, setTerm] = useState('');
 const [macros, setMacros] = useState<Macro[]>([]);
 const agentName = useAuthStore((state) => state.user?.name);
 const [reply, setReply] = useState('');
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 const params: Record<string, string> = {};
 if (onlyOverdue) params.overdue = 'true';
 if (onlyLegalOverdue) params.legalOverdue = 'true';
 if (view === 'answered') params.view = 'answered';
 if (type) params.type = type;
 if (requester) params.requesterRole = requester;
 if (term) params.q = term;
 const [queue, totals] = await Promise.all([
 api.get('/pqrs/support/queue', { params }),
 api.get('/pqrs/support/metrics'),
 ]);
 setTickets(queue.data.data ?? []);
 setMetrics(totals.data.data ?? null);
 } catch (err) {
 console.error(err);
 setError(apiMessage(err, 'No se pudo cargar la bandeja de soporte.'));
 } finally {
 setLoading(false);
 }
 }, [onlyOverdue, onlyLegalOverdue, view, type, requester, term]);

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

 const changePriority = (id: string, priority: string) =>
 run(() => api.patch(`/pqrs/${id}/classify`, { priority }));

 const assignToMe = (id: string) => run(() => api.patch(`/pqrs/${id}/assign`, {}));

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
 setOpenId(null);
 });

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Soporte</h1>
 <p className="page-subtitle">
 PQRS de clientes, comercios y domiciliarios en una sola bandeja. Primero lo que vence por ley, luego por SLA interno
 </p>
 </div>
 <button
 onClick={load}
 className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)] shadow-xs transition-all hover:bg-[var(--color-bg)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" />
 <span>Actualizar</span>
 </button>
 </div>

 {metrics ? (
 <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
 {[
 { label: 'Abiertos', value: metrics.open, tone: '' },
 { label: 'Plazo legal vencido', value: metrics.legalOverdue ?? 0, tone: 'text-[var(--color-danger)]' },
 { label: 'Vence por ley ≤ 3 días', value: metrics.legalDueSoon ?? 0, tone: 'text-[var(--color-warning)]' },
 { label: 'SLA interno vencido', value: metrics.overdue, tone: 'text-[var(--color-danger)]' },
 { label: 'Sin asignar', value: metrics.unassigned, tone: 'text-[var(--color-warning)]' },
 {
 label: 'Primera respuesta (min)',
 value: Math.round(metrics.averageFirstResponseMinutes || 0),
 tone: '',
 },
 ].map((kpi) => (
 <div key={kpi.label}>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 {kpi.label}
 </p>
 <p className={`text-2xl font-bold ${kpi.tone || 'text-[var(--color-text-main)]'}`}>
 {kpi.value}
 </p>
 </div>
 ))}
 </div>
 ) : null}

 <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
 <div className="flex gap-4 border-b border-[var(--color-border-light)]">
 {([['open', 'Por responder'], ['answered', 'Respondidos']] as const).map(([key, label]) => (
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
 </button>
 ))}
 </div>
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
 placeholder="Buscar en asunto o detalle"
 className="w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-text-main)]"
 />
 <Link to="/support-macros" className="text-xs font-semibold text-[var(--color-primary)] underline">
 Respuestas predefinidas
 </Link>
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
 <p className="flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : null}

 {loading && tickets.length === 0 ? (
 <p className="text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : tickets.length === 0 ? (
 <div className="flex flex-col items-center gap-2 border-y border-[var(--color-border-light)] py-10">
 <Inbox className="h-8 w-8 text-[var(--color-success)]" />
 <p className="font-semibold text-[var(--color-text-main)]">La bandeja está vacía</p>
 </div>
 ) : (
 <ul className="space-y-2">
 {tickets.map((ticket) => {
 const due = dueLabel(ticket.dueAt);
 const agent = nameOf(ticket.assignedTo);
 const isOpen = openId === ticket._id;

 return (
 <li
 key={ticket._id}
 className="border-b border-[var(--color-border-light)] pb-4"
 >
 <div className="flex flex-wrap items-start gap-3">
 <div className="min-w-0 flex-1">
 <div className="flex flex-wrap items-center gap-2">
 <p className="font-bold text-[var(--color-text-main)]">{ticket.subject}</p>
 <span
 className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
 PRIORITY[ticket.priority].chip
 }`}
 >
 {PRIORITY[ticket.priority].label}
 </span>
 {ticket.legalDueAt ? (
 <span
 className={`flex items-center gap-1 text-[11px] font-bold ${
 ticket.legalOverdue
 ? 'text-[var(--color-danger)]'
 : ticket.legalDueSoon
 ? 'text-[var(--color-warning)]'
 : 'text-[var(--color-text-main)]'
 }`}
 >
 <Scale className="h-3 w-3" />
 {ticket.legalOverdue ? 'Plazo legal vencido el ' : 'Plazo legal: '}
 {shortDate(ticket.legalDueAt)}
 </span>
 ) : null}
 {due ? (
 <span
 className={`flex items-center gap-1 text-[11px] font-semibold ${
 due.overdue
 ? 'text-[var(--color-danger)]'
 : 'text-[var(--color-text-main)]'
 }`}
 >
 <Timer className="h-3 w-3" /> SLA {due.text}
 </span>
 ) : null}
 </div>
 <p className="text-[11px] uppercase tracking-wider text-[var(--color-text-main)]">
 {TYPE_LABEL[ticket.type]} · {REQUESTER_LABEL[ticket.requesterRole ?? 'customer']} ·{' '}
 <EntityLink type="user" id={userIdOf(ticket.userId)}>{nameOf(ticket.userId) ?? 'Usuario'}</EntityLink> ·{' '}
 {agent ? `lo lleva ${agent}` : 'sin asignar'}
 </p>
 {(ticket.orderId || ticket.businessId || ticket.driverId) && (
 <p className="text-xs text-[var(--color-text-main)]">
 {ticket.orderId ? (
 <EntityLink type="order" id={ticket.orderId._id}>
 Pedido #{ticket.orderId.orderNumber ?? ticket.orderId._id.slice(-8)}
 </EntityLink>
 ) : null}
 {ticket.businessId?.name ? (
 <>
 {' · '}
 <EntityLink type="business" id={ticket.businessId._id}>{ticket.businessId.name}</EntityLink>
 </>
 ) : null}
 {ticket.driverId?.userId?.name ? (
 <>
 {' · domiciliario '}
 <EntityLink type="driver" id={ticket.driverId._id}>{ticket.driverId.userId.name}</EntityLink>
 </>
 ) : null}
 </p>
 )}
 </div>

 <EntityLink
 type="user"
 id={userIdOf(ticket.userId)}
 hideWhenDenied
 className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] hover:no-underline"
 >
 Ver cuenta
 </EntityLink>
 {!agent ? (
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => assignToMe(ticket._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 <UserCheck className="h-3.5 w-3.5" /> Asignármelo
 </button>
 </PermissionGate>
 ) : null}
 <button
 onClick={() => {
 setOpenId(isOpen ? null : ticket._id);
 setReply('');
 setError('');
 }}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
 >
 {isOpen ? 'Cerrar detalle' : 'Abrir'}
 </button>
 </div>

 {isOpen ? (
 <div className="mt-3 space-y-3 border-t border-[var(--color-border-light)] pt-3">
 <p className="whitespace-pre-wrap text-sm text-[var(--color-text-main)]">
 {ticket.detail}
 </p>

 {ticket.responses?.length ? (
 <ul className="space-y-1.5">
 {ticket.responses.map((r, index) => (
 <li
 key={index}
 className="border-l-2 border-[var(--color-primary)] pl-3 text-sm text-[var(--color-text-main)]"
 >
 {r.message}
 <span className="ml-2 text-[11px] text-[var(--color-text-main)]">
 {new Date(r.createdAt).toLocaleString('es-CO')}
 </span>
 </li>
 ))}
 </ul>
 ) : null}

 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <div className="flex flex-wrap items-center gap-3">
 <select
 value=""
 onChange={(e) => {
 const macro = macros.find((m) => m._id === e.target.value);
 if (macro) setReply(fillMacro(macro.body, ticket, agentName));
 }}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 <option value="">Insertar respuesta predefinida…</option>
 {macros
 .filter((m) => m.appliesTo.length === 0 || m.appliesTo.includes(ticket.type))
 .map((m) => <option key={m._id} value={m._id}>{m.title}</option>)}
 </select>
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Prioridad
 <select
 value={ticket.priority}
 disabled={busy}
 onChange={(e) => changePriority(ticket._id, e.target.value)}
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text-main)]"
 >
 {Object.entries(PRIORITY).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
 </select>
 </label>
 </div>
 </PermissionGate>

 <textarea
 value={reply}
 onChange={(e) => setReply(e.target.value)}
 rows={3}
 placeholder="Lamentamos lo ocurrido. Ya le reembolsamos el pedido completo."
 className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]"
 />

 <div className="flex justify-end gap-2">
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => respond(ticket._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
 >
 <Send className="h-3.5 w-3.5" /> Responder
 </button>
 </PermissionGate>
 <button
 onClick={() => close(ticket._id)}
 disabled={busy}
 className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-success)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
 >
 <CheckCircle2 className="h-3.5 w-3.5" /> Responder y cerrar
 </button>
 </div>
 </div>
 ) : null}
 </li>
 );
 })}
 </ul>
 )}

 </div>
 );
}
