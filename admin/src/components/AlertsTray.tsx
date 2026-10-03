import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, X } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { useFicha } from '../lib/entityLinks';
import type { FichaType } from '../lib/entityLinks';
import type { AdminAlertItem, AdminAlertsResponse, AlertSeverity } from '../lib/apiTypes';
import { useAdminSocketEvents, useTrailingCallback } from '../hooks/useAdminSocket';

/**
 * Bandeja de alertas de la cabecera.
 *
 * El servidor las calcula (no se guardan): cuando el dominio resuelve algo,
 * la alerta desaparece sola. Lo único que se persiste es qué alertas vio esta
 * persona. La lista se refresca por el evento `alerts:changed` de la sala
 * `admin:alerts` —que no lleva datos, solo avisa— y con un sondeo de 60 s
 * para lo que depende del reloj (vencimientos), que solo corre con la
 * pestaña visible.
 */

const LIMIT = 50;
const SEEN_BATCH = 100;

const SEVERITY: Record<AlertSeverity, { label: string; text: string; dot: string }> = {
 critical: { label: 'Crítico', text: 'text-[var(--color-danger)]', dot: 'bg-[var(--color-danger)]' },
 high: { label: 'Alto', text: 'text-[var(--color-text-main)]', dot: 'bg-[var(--color-warning)]' },
 medium: { label: 'Medio', text: 'text-[var(--color-text-main)]', dot: 'bg-[var(--color-border-strong)]' },
};

/** Adónde ir cuando la alerta no trae ninguna ficha a la que enlazar. */
const KIND_ROUTE: Record<string, string> = {
 fraud: '/security',
 cash: '/financials',
 cash_overdue: '/financials',
 clawback_overdue: '/financials',
 refund_failed: '/financials',
 payment_review: '/incidents',
 order_unaccepted: '/orders',
 complaint: '/support',
 pqrs_legal: '/support',
 data_request_legal: '/legal',
 stalled_order: '/orders',
 unassigned_order: '/orders',
 business_document_expiring: '/business-approvals',
 driver_document_expiring: '/driver-documents',
 ad_uninvoiced: '/campaigns',
};

function ago(iso: string): string {
 const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
 if (minutes < 1) return 'ahora';
 if (minutes < 60) return `hace ${minutes} min`;
 const hours = Math.round(minutes / 60);
 if (hours < 24) return `hace ${hours} h`;
 return `hace ${Math.round(hours / 24)} d`;
}

/** Primera ficha disponible: el pedido manda, porque es donde se resuelve casi todo. */
function firstFicha(links: AdminAlertItem['links']): { type: FichaType; id: string } | null {
 if (links.orderId) return { type: 'order', id: links.orderId };
 if (links.businessId) return { type: 'business', id: links.businessId };
 if (links.driverId) return { type: 'driver', id: links.driverId };
 if (links.userId) return { type: 'user', id: links.userId };
 return null;
}

export default function AlertsTray() {
 const navigate = useNavigate();
 const { open: openFicha } = useFicha();
 const rootRef = useRef<HTMLDivElement>(null);

 const [data, setData] = useState<AdminAlertsResponse | null>(null);
 const [error, setError] = useState('');
 const [isOpen, setIsOpen] = useState(false);
 // Las que estaban sin ver al abrir el menú: se marcan vistas de inmediato,
 // pero mientras el menú siga abierto se distinguen de las que ya se conocían.
 const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
 const knownKeys = useRef<Set<string> | null>(null);
 const [banner, setBanner] = useState<AdminAlertItem | null>(null);

 const load = useCallback(async () => {
 try {
 const res = await api.get('/admin/alerts', { params: { limit: LIMIT } });
 setData((res.data.data ?? res.data) as AdminAlertsResponse);
 setError('');
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las alertas.'));
 }
 }, []);

 useEffect(() => {
 void load();
  const onVisible = () => {
 if (document.visibilityState === 'visible') void load();
 };
 document.addEventListener('visibilitychange', onVisible);
 return () => {
 document.removeEventListener('visibilitychange', onVisible);
 };
 }, [load]);

 // Varias alertas seguidas (un SOS y un fraude a la vez) son una sola recarga.
 const reloadSoon = useTrailingCallback(() => void load(), 400);
 useAdminSocketEvents({ 'alerts:changed': () => reloadSoon() });

 // La primera carga solo establece la línea de base: no debemos anunciar
 // como "nuevos" los incidentes que ya estaban abiertos al iniciar sesión.
 useEffect(() => {
 const keys = new Set((data?.items ?? []).map((item) => item.key));
 if (!knownKeys.current) {
 knownKeys.current = keys;
 return;
 }
 const incoming = (data?.items ?? []).find((item) => !knownKeys.current?.has(item.key));
 knownKeys.current = keys;
 if (!incoming) return;
 setBanner(incoming);
 const timer = setTimeout(() => setBanner(null), 10_000);
 return () => clearTimeout(timer);
 }, [data]);

 useEffect(() => {
 if (!isOpen) return;
 const onDown = (e: MouseEvent) => {
 if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false);
 };
 const onKey = (e: KeyboardEvent) => {
 if (e.key === 'Escape') setIsOpen(false);
 };
 document.addEventListener('mousedown', onDown);
 document.addEventListener('keydown', onKey);
 return () => {
 document.removeEventListener('mousedown', onDown);
 document.removeEventListener('keydown', onKey);
 };
 }, [isOpen]);

 const markSeen = useCallback(
 async (keys: string[]) => {
 if (keys.length === 0) return;
 const marked = new Set(keys);
 setData((d) =>
 d
 ? {
 ...d,
 unseen: Math.max(0, d.unseen - keys.length),
 items: d.items.map((i) => (marked.has(i.key) ? { ...i, seen: true } : i)),
 }
 : d,
 );
 try {
 for (let i = 0; i < keys.length; i += SEEN_BATCH) {
 await api.post('/admin/alerts/seen', { keys: keys.slice(i, i + SEEN_BATCH) });
 }
 } catch {
 // No se pudo guardar: se vuelve a lo que diga el servidor.
 void load();
 }
 },
 [load],
 );

 const toggle = () => {
 if (isOpen) {
 setIsOpen(false);
 return;
 }
 const unseenKeys = (data?.items ?? []).filter((i) => !i.seen).map((i) => i.key);
 setFresh(new Set(unseenKeys));
 setIsOpen(true);
 // Primero se guarda lo visto y después se recarga: al revés, la respuesta
 // podía llegar antes que el guardado y volver a pintarlas como nuevas.
 void markSeen(unseenKeys).then(() => load());
 };

 const goTo = (item: AdminAlertItem) => {
 setIsOpen(false);
 const ficha = firstFicha(item.links);
 if (ficha) {
 openFicha(ficha.type, ficha.id);
 return;
 }
 navigate(KIND_ROUTE[item.kind] ?? '/incidents');
 };

 const items = data?.items ?? [];
 const unseen = data?.unseen ?? 0;

 return (
 <div ref={rootRef} className="relative">
 {banner ? (
 <div role="alert" className="fixed right-4 top-20 z-[60] flex w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-2xl border border-[var(--color-warning)]/40 bg-[var(--color-surface)] p-4 shadow-2xl animate-fade-in">
 <span className="rounded-xl bg-[var(--color-warning)]/15 p-2 text-[var(--color-text-main)]"><BellRing className="h-5 w-5" /></span>
 <button type="button" onClick={() => goTo(banner)} className="min-w-0 flex-1 cursor-pointer text-left">
 <span className="block text-sm font-bold text-[var(--color-text-main)]">Nueva alerta: {banner.title}</span>
 <span className="mt-1 block text-xs text-[var(--color-text-main)]">{banner.detail}</span>
 <span className="mt-2 block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Abrir y gestionar</span>
 </button>
 <button type="button" onClick={() => setBanner(null)} aria-label="Cerrar aviso" className="cursor-pointer rounded-lg p-1 text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)]"><X className="h-4 w-4" /></button>
 </div>
 ) : null}
 <button
 type="button"
 onClick={toggle}
 title="Alertas"
 aria-label={unseen > 0 ? `Alertas: ${unseen} sin ver` : 'Alertas'}
 aria-expanded={isOpen}
 className="relative cursor-pointer rounded-lg p-2 text-[var(--color-text-main)] transition-colors hover:bg-[var(--color-bg-alt)]"
 >
 <Bell className="h-4 w-4" />
 {unseen > 0 ? (
 <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[9px] font-bold leading-none text-white">
 {unseen > 99 ? '99+' : unseen}
 </span>
 ) : null}
 </button>

 {isOpen ? (
 <div className="zipp-modal absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl shadow-xl animate-fade-in">
 <div className="flex items-center justify-between px-4 py-3">
 <p className="text-xs font-bold text-[var(--color-text-main)]">Alertas</p>
 </div>

 {error ? (
 <p role="alert" className="border-t border-[var(--color-border-light)] px-4 py-3 text-xs font-semibold text-[var(--color-danger)]">
 {error} Lo que ves puede estar desactualizado.
 </p>
 ) : null}

 <div className="max-h-[60vh] overflow-y-auto">
 {items.length === 0 && !error ? (
 <p className="border-t border-[var(--color-border-light)] px-4 py-6 text-center text-xs text-[var(--color-text-main)]">
 {data ? 'No hay nada abierto ahora mismo.' : 'Cargando…'}
 </p>
 ) : null}

 {items.map((item) => {
 const severity = SEVERITY[item.severity] ?? SEVERITY.medium;
 const isNew = fresh.has(item.key);
 return (
 <button
 key={item.key}
 type="button"
 onClick={() => goTo(item)}
 className="flex w-full cursor-pointer items-start gap-3 border-t border-[var(--color-border-light)] px-4 py-3 text-left transition-colors hover:text-[var(--color-text-main)]"
 >
 <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${severity.dot}`} />
 <span className="min-w-0 flex-1">
 <span
 className={`block text-xs text-[var(--color-text-main)] ${
 isNew || !item.seen ? 'font-bold' : 'font-medium'
 }`}
 >
 {item.title}
 </span>
 <span className="block break-words text-[11px] text-[var(--color-text-main)]">
 {item.detail}
 </span>
 <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-main)]">
 <span className={severity.text}>{severity.label}</span> · {ago(item.at)}
 </span>
 </span>
 </button>
 );
 })}
 </div>

 <div className="border-t border-[var(--color-border-light)] px-4 py-3">
 {data?.truncated ? (
 <p className="pb-2 text-[11px] text-[var(--color-text-main)]">
 Hay más alertas de las que caben aquí.
 </p>
 ) : null}
 <button
 type="button"
 onClick={() => {
 setIsOpen(false);
 navigate('/incidents');
 }}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)] hover:underline"
 >
 Abrir el centro de incidentes
 </button>
 </div>
 </div>
 ) : null}
 </div>
 );
}
