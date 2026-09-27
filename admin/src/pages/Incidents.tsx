import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
 AlertTriangle, ShieldAlert, Banknote, MessageSquareWarning, Clock,
 RotateCw, ArrowRight, ShieldCheck, Scale, FileWarning, Megaphone, Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import SosPanel from '../components/SosPanel';
import EntityLink from '../components/EntityLink';
import { useAdminSocketEvents } from '../hooks/useAdminSocket';

/**
 * Aviso sonoro de una emergencia nueva.
 *
 * Sin archivo de audio: dos tonos generados con Web Audio son suficientes
 * para que quien está mirando otra pestaña levante la vista, y no dependen
 * de un asset que alguien podría olvidar copiar al desplegar.
 */
function playSosBeep() {
 try {
 const Ctx =
 window.AudioContext ||
 (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
 const ctx = new Ctx();
 [880, 660].forEach((freq, i) => {
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();
 osc.frequency.value = freq;
 osc.type = 'square';
 gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.28);
 gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.28 + 0.25);
 osc.connect(gain).connect(ctx.destination);
 osc.start(ctx.currentTime + i * 0.28);
 osc.stop(ctx.currentTime + i * 0.28 + 0.26);
 });
 } catch {
 // Sin audio disponible (política de autoplay, navegador sin soporte):
 // el aviso visual del banner y la fila resaltada siguen sirviendo.
 }
}

/**
 * Centro de incidentes.
 *
 * Nada de lo que aparece aquí es nuevo. Las emergencias, las alertas de
 * fraude, los faltantes de efectivo, los reclamos y los pedidos detenidos ya
 * existían — pero cada uno en su pantalla. Nadie mira cinco pantallas a la
 * vez, así que en la práctica se miraba una y las otras cuatro acumulaban.
 *
 * El orden lo decide el servidor: primero por gravedad y, dentro de la misma
 * gravedad, lo más antiguo primero. Es deliberado que las emergencias vayan
 * arriba aunque acaben de entrar: es la única categoría donde lo que está en
 * juego es una persona y no dinero.
 */

type Severity = 'critical' | 'high' | 'medium';

/**
 * `kind` es texto libre a propósito: el servidor puede sumar tipos nuevos
 * (los mismos que llegan a la bandeja de alertas) sin que esta pantalla se
 * rompa. Los que no conoce se pintan con la etiqueta por defecto.
 */
interface Incident {
 kind: string;
 severity: Severity;
 id: string;
 /** Presente en los tipos nuevos: `kind:id:stage`. */
 key?: string;
 title: string;
 detail: string;
 at: string;
 userId?: string;
 orderId?: string;
 businessId?: string;
 driverId?: string;
}

interface Summary {
 activeSos: number;
 openFraud: number;
 openCash: number;
 openClaims: number;
 blockedUsers: number;
 legalOverduePqrs?: number;
 legalOverdueDataRequests?: number;
}

const KIND: Record<string, { label: string; icon: LucideIcon }> = {
 sos: { label: 'Emergencia', icon: ShieldAlert },
 fraud: { label: 'Fraude', icon: AlertTriangle },
 cash: { label: 'Efectivo', icon: Banknote },
 complaint: { label: 'Reclamo', icon: MessageSquareWarning },
 stalled_order: { label: 'Pedido detenido', icon: Clock },
 pqrs_legal: { label: 'Plazo legal PQRS', icon: Scale },
 data_request_legal: { label: 'Datos personales', icon: Scale },
 clawback_overdue: { label: 'Saldo en contra', icon: Banknote },
 unassigned_order: { label: 'Pedido sin domiciliario', icon: Clock },
 cash_overdue: { label: 'Efectivo vencido', icon: Banknote },
 business_document_expiring: { label: 'Documento de comercio por vencer', icon: FileWarning },
 driver_document_expiring: { label: 'Documento de domiciliario por vencer', icon: FileWarning },
 ad_uninvoiced: { label: 'Publicidad sin facturar', icon: Megaphone },
 refund_failed: { label: 'Reembolso fallido', icon: Undo2 },
};

/** Un tipo que esta pantalla aún no conoce: se ve, con una etiqueta neutra. */
const DEFAULT_KIND: { label: string; icon: LucideIcon } = { label: 'Alerta', icon: AlertTriangle };
const kindOf = (kind: string) => KIND[kind] ?? DEFAULT_KIND;

const SEVERITY: Record<Severity, { label: string; bar: string; chip: string }> = {
 critical: {
 label: 'Crítico',
 bar: 'bg-[var(--color-danger)]',
 chip: 'bg-[var(--color-danger)] text-white',
 },
 high: {
 label: 'Alto',
 bar: 'bg-[var(--color-warning)]',
 chip: 'bg-[var(--color-warning)] text-white',
 },
 medium: {
 label: 'Medio',
 bar: 'bg-[var(--color-border)]',
 chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-main)]',
 },
};

/** Cuánto lleva esperando, que es lo que decide a qué se atiende antes. */
function waitingFor(iso: string): string {
 const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
 if (minutes < 60) return `hace ${minutes} min`;
 const hours = Math.round(minutes / 60);
 if (hours < 24) return `hace ${hours} h`;
 return `hace ${Math.round(hours / 24)} d`;
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
 return (
 <div>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 {label}
 </p>
 <p className={`text-2xl font-bold ${tone ?? 'text-[var(--color-text-main)]'}`}>{value}</p>
 </div>
 );
}

export default function Incidents() {
 const navigate = useNavigate();
 const [incidents, setIncidents] = useState<Incident[]>([]);
 const [summary, setSummary] = useState<Summary | null>(null);
 const [loading, setLoading] = useState(true);
 const [loadError, setLoadError] = useState('');
 const [filter, setFilter] = useState<string>('all');
 const [openAlertId, setOpenAlertId] = useState<string | null>(null);
 const [justArrived, setJustArrived] = useState<{ id: string; detail: string } | null>(null);

 // El spinner solo cubre la primera carga (`loading` arranca en true): en
 // los refrescos de fondo la lista ya está en pantalla y parpadearla cada
 // medio minuto solo distrae.
 const load = useCallback(async () => {
 try {
 const [list, totals] = await Promise.all([
 api.get('/security/incidents'),
 api.get('/security/incidents/summary'),
 ]);
 setIncidents(list.data.data ?? []);
 setSummary(totals.data.data ?? null);
 setLoadError('');
 } catch (err) {
 console.error(err);
 // Una cola vacía por error se lee como"no pasa nada": aquí eso es lo peor.
 setLoadError(apiMessage(err, 'No se pudo actualizar el centro de incidentes.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 load();
 // Un centro de incidentes que hay que refrescar a mano deja de ser un
 // centro de incidentes en cuanto alguien se distrae. Medio minuto es
 // suficiente: son consultas de conteo, no de listado pesado.
 // Con la pestaña oculta no se pide nada; al volver se refresca de una.
 const timer = setInterval(() => {
 if (document.visibilityState === 'visible') load();
 }, 30_000);
 const onVisible = () => {
 if (document.visibilityState === 'visible') load();
 };
 document.addEventListener('visibilitychange', onVisible);
 return () => {
 clearInterval(timer);
 document.removeEventListener('visibilitychange', onVisible);
 };
 }, [load]);

 // Una emergencia no puede depender del refresco de 30 segundos: llega por
 // socket a la sala `admin` (el backend mete ahí a todo administrador al
 // conectar) y refresca la lista al instante, con tono y aviso propios.
 useAdminSocketEvents({
 'sos:triggered': (payload: { alertId: string; driverId: string }) => {
 playSosBeep();
 setJustArrived({ id: payload.alertId, detail: 'Nueva emergencia' });
 load();
 },
 'sos:updated': () => load(),
 });

 const shown = filter === 'all' ? incidents : incidents.filter((i) => i.kind === filter);

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Centro de incidentes</h1>
 <p className="page-subtitle">
 Todo lo que está abierto ahora mismo, en un solo sitio y por gravedad
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

 {justArrived ? (
 <button
 onClick={() => { setOpenAlertId(justArrived.id); setJustArrived(null); }}
 className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger)] px-4 py-3 text-left text-white shadow-lg animate-fade-in"
 >
 <ShieldAlert className="h-5 w-5 shrink-0 animate-pulse" />
 <span className="flex-1 text-sm font-bold">
 {justArrived.detail}: un domiciliario acaba de activar el botón de pánico
 </span>
 <span className="shrink-0 text-xs font-bold underline">Atender ahora</span>
 </button>
 ) : null}

 {loadError ? (
 <p className="flex items-center gap-2 text-sm font-bold text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError} Lo que ves puede estar desactualizado.
 </p>
 ) : null}

 {summary ? (
 <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
 <Kpi label="Emergencias" value={summary.activeSos} tone="text-[var(--color-danger)]" />
 <Kpi label="Fraude" value={summary.openFraud} />
 <Kpi label="Efectivo" value={summary.openCash} />
 <Kpi label="Reclamos" value={summary.openClaims} />
 <Kpi
 label="Plazos legales vencidos"
 value={(summary.legalOverduePqrs ?? 0) + (summary.legalOverdueDataRequests ?? 0)}
 tone="text-[var(--color-danger)]"
 />
 <Kpi label="Cuentas bloqueadas" value={summary.blockedUsers} />
 </div>
 ) : null}

 <div className="flex flex-wrap gap-2 border-b border-[var(--color-border-light)] pb-4">
 {['all', ...Object.keys(KIND)].map((key) => (
 <button
 key={key}
 onClick={() => setFilter(key)}
 className={`cursor-pointer px-3 py-1.5 text-xs font-semibold transition-colors border-b-2 ${
 filter === key
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {key === 'all' ? 'Todo' : KIND[key].label}
 </button>
 ))}
 </div>

 {loading && incidents.length === 0 ? (
 <p className="text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : shown.length === 0 ? (
 <div className="flex flex-col items-center gap-2 border-y border-[var(--color-border-light)] py-10">
 <ShieldCheck className="h-8 w-8 text-[var(--color-success)]" />
 <p className="font-semibold text-[var(--color-text-main)]">No hay nada abierto</p>
 <p className="text-sm text-[var(--color-text-main)]">
 Ni emergencias, ni faltantes, ni pedidos detenidos.
 </p>
 </div>
 ) : (
 <ul className="space-y-2">
 {shown.map((incident) => {
 const kind = kindOf(incident.kind);
 const severity = SEVERITY[incident.severity];
 const Icon = kind.icon;

 return (
 <li
 key={incident.key ?? `${incident.kind}:${incident.id}`}
 className="flex items-stretch overflow-hidden border-b border-[var(--color-border-light)]"
 >
 {/* La gravedad se lee antes que el texto: es una barra de
 color, no una etiqueta que haya que ir a buscar. */}
 <div className={`w-1 shrink-0 ${severity.bar}`} />

 <div className="flex flex-1 flex-wrap items-center gap-3 p-4">
 <Icon className="h-5 w-5 shrink-0 text-[var(--color-text-main)]" />

 <div className="min-w-0 flex-1">
 <div className="flex flex-wrap items-center gap-2">
 <p className="font-bold text-[var(--color-text-main)]">{incident.title}</p>
 <span
 className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${severity.chip}`}
 >
 {severity.label}
 </span>
 </div>
 <p className="break-words text-sm text-[var(--color-text-main)]">
 {incident.detail}
 </p>
 <p className="text-[11px] text-[var(--color-text-main)]">
 {kind.label} · {waitingFor(incident.at)}
 </p>
 {/* Un incidente sin a dónde ir es una notificación. Las
 fichas se abren aquí mismo; quien no tiene el permiso
 de ver ese tipo no ve el enlace. */}
 <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-[var(--color-primary)]">
 <EntityLink type="order" id={incident.orderId} hideWhenDenied>Ver pedido</EntityLink>
 <EntityLink type="user" id={incident.userId} hideWhenDenied>Ver usuario</EntityLink>
 <EntityLink type="business" id={incident.businessId} hideWhenDenied>Ver comercio</EntityLink>
 <EntityLink type="driver" id={incident.driverId} hideWhenDenied>Ver domiciliario</EntityLink>
 </p>
 </div>

 {incident.kind === 'sos' ? (
 <div className="flex shrink-0 gap-2">
 <button
 onClick={() => navigate('/fleet')}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Ver en el mapa
 </button>
 <button
 onClick={() => setOpenAlertId(incident.id)}
 className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-danger)] px-3 py-1.5 text-xs font-bold text-white"
 >
 Atender <ArrowRight className="h-3.5 w-3.5" />
 </button>
 </div>
 ) : null}
 {incident.kind === 'clawback_overdue' ? (
 <button
 onClick={() => navigate('/financials')}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Abrir finanzas <ArrowRight className="h-3.5 w-3.5" />
 </button>
 ) : null}
 {incident.kind === 'data_request_legal' ? (
 <button
 onClick={() => navigate('/legal')}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Abrir datos personales <ArrowRight className="h-3.5 w-3.5" />
 </button>
 ) : null}
 {incident.kind === 'complaint' || incident.kind === 'pqrs_legal' ? (
 <button
 onClick={() => navigate('/support')}
 className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Abrir en soporte <ArrowRight className="h-3.5 w-3.5" />
 </button>
 ) : null}
 </div>
 </li>
 );
 })}
 </ul>
 )}

 {openAlertId ? (
 <SosPanel
 alertId={openAlertId}
 onClose={() => setOpenAlertId(null)}
 onChanged={load}
 />
 ) : null}
 </div>
 );
}
