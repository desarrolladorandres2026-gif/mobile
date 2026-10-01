import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ShoppingBag, User, Store, Truck, Ticket, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';
import { apiMessage, apiStatus } from '../lib/apiError';
import { useFicha } from '../lib/entityLinks';
import type { FichaType } from '../lib/entityLinks';
import type { AdminSearchResults } from '../lib/apiTypes';

/**
 * Búsqueda global del panel: pedidos, clientes, comercios, domiciliarios y
 * cupones desde cualquier pantalla.
 *
 * El servidor decide qué tipos consulta según el permiso y la forma de lo
 * escrito (un número, un celular, un correo, una placa, un nombre), así que
 * aquí solo se manda `q`. Espera 300 ms sin teclear, cancela la petición
 * anterior y no busca con menos de dos caracteres. Un 429 se enseña con el
 * mensaje del servidor: sin eso, el límite se leería como"no hay nada".
 */

const MIN_CHARS = 2;
const WAIT_MS = 300;

type HitKind = FichaType | 'coupon';

interface Hit {
 kind: HitKind;
 id: string;
 /** Lo que se navega para cupones (no tienen ficha). */
 code?: string;
 title: ReactNode;
 detail: string;
}

interface Group {
 kind: HitKind;
 label: string;
 Icon: LucideIcon;
 hits: Hit[];
 /** Posición del primer resultado del grupo en la lista plana (para el teclado). */
 offset: number;
}

const ORDER_STATUS: Record<string, string> = {
 pending: 'Pendiente',
 accepted: 'Aceptado',
 preparing: 'Preparando',
 ready: 'Listo',
 picked_up: 'En camino',
 on_way: 'En camino',
 delivered: 'Entregado',
 cancelled: 'Cancelado',
};

const ROLE: Record<string, string> = {
 client: 'Cliente',
 business: 'Comercio',
 driver: 'Domiciliario',
 admin: 'Administrador',
};

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('es-CO') : '');
const join = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' · ');

function buildGroups(results: AdminSearchResults): Group[] {
 const groups: Group[] = [];

 if (results.orders?.length) {
 groups.push({
 kind: 'order',
 label: 'Pedidos',
 Icon: ShoppingBag,
 offset: 0,
 hits: results.orders.map((o) => ({
 kind: 'order',
 id: o._id,
 title: `#${o.orderNumber}`,
 detail: join(
 o.kind === 'errand' ? 'Mandado' : o.businessName,
 ORDER_STATUS[o.status] ?? o.status,
 day(o.createdAt),
 ),
 })),
 });
 }
 if (results.users?.length) {
 groups.push({
 kind: 'user',
 label: 'Clientes y usuarios',
 Icon: User,
 offset: 0,
 hits: results.users.map((u) => ({
 kind: 'user',
 id: u._id,
 title: u.name,
 detail: join(ROLE[u.role] ?? u.role, u.phoneMasked, u.emailMasked, !u.isActive && 'Inactivo'),
 })),
 });
 }
 if (results.businesses?.length) {
 groups.push({
 kind: 'business',
 label: 'Comercios',
 Icon: Store,
 offset: 0,
 hits: results.businesses.map((b) => ({
 kind: 'business',
 id: b._id,
 title: b.name,
 detail: join(
 b.city,
 b.isArchived && 'Archivado',
 b.isSuspended && 'Suspendido',
 !b.isApproved && 'Sin aprobar',
 ),
 })),
 });
 }
 if (results.drivers?.length) {
 groups.push({
 kind: 'driver',
 label: 'Domiciliarios',
 Icon: Truck,
 offset: 0,
 hits: results.drivers.map((d) => ({
 kind: 'driver',
 id: d._id,
 title: d.name,
 detail: join(d.licensePlate, d.status, !d.isApproved && 'Sin aprobar'),
 })),
 });
 }
 if (results.coupons?.length) {
 groups.push({
 kind: 'coupon',
 label: 'Cupones',
 Icon: Ticket,
 offset: 0,
 hits: results.coupons.map((c) => ({
 kind: 'coupon',
 id: c._id,
 code: c.code,
 title: <span className="font-mono">{c.code}</span>,
 detail: join(c.isActive ? 'Activo' : 'Inactivo', c.validUntil && `hasta ${day(c.validUntil)}`),
 })),
 });
 }
 let offset = 0;
 for (const group of groups) {
 group.offset = offset;
 offset += group.hits.length;
 }
 return groups;
}

/** Sin foco en un campo de texto, `/` enfoca la búsqueda como en GitHub o Linear. */
function isTyping(target: EventTarget | null): boolean {
 if (!(target instanceof HTMLElement)) return false;
 return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** El 429 trae su propio mensaje (cuántas por minuto): mejor que el genérico. */
function searchError(err: unknown): string {
 if (apiStatus(err) === 429) {
 const body = (err as { response?: { data?: { message?: string } } }).response?.data;
 return body?.message || apiMessage(err);
 }
 return apiMessage(err, 'No se pudo buscar.');
}

export default function GlobalSearch() {
 const navigate = useNavigate();
 const { open: openFicha } = useFicha();
 const inputRef = useRef<HTMLInputElement>(null);
 const rootRef = useRef<HTMLDivElement>(null);

 const [query, setQuery] = useState('');
 const [results, setResults] = useState<AdminSearchResults | null>(null);
 const [searchedFor, setSearchedFor] = useState('');
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const [isOpen, setIsOpen] = useState(false);
 const [cursor, setCursor] = useState(-1);

 const term = query.trim();
 const ready = term.length >= MIN_CHARS;

 useEffect(() => {
 if (!ready) return;
 const controller = new AbortController();
 const timer = setTimeout(async () => {
 setLoading(true);
 try {
 const { data } = await api.get('/admin/search', {
 params: { q: term },
 signal: controller.signal,
 });
 setResults((data.data ?? data).results ?? {});
 setSearchedFor(term);
 setError('');
 setCursor(-1);
 } catch (err) {
 if (controller.signal.aborted) return;
 setError(searchError(err));
 } finally {
 if (!controller.signal.aborted) setLoading(false);
 }
 }, WAIT_MS);
 return () => {
 clearTimeout(timer);
 controller.abort();
 };
 }, [term, ready]);

 // `/` y Ctrl/Cmd+K enfocan desde cualquier pantalla.
 useEffect(() => {
 const onKey = (e: globalThis.KeyboardEvent) => {
 const shortcut = (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey);
 const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target);
 if (!shortcut && !slash) return;
 e.preventDefault();
 inputRef.current?.focus();
 inputRef.current?.select();
 setIsOpen(true);
 };
 window.addEventListener('keydown', onKey);
 return () => window.removeEventListener('keydown', onKey);
 }, []);

 useEffect(() => {
 if (!isOpen) return;
 const onDown = (e: MouseEvent) => {
 if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false);
 };
 document.addEventListener('mousedown', onDown);
 return () => document.removeEventListener('mousedown', onDown);
 }, [isOpen]);

 // Lo que se pinta es lo de la última respuesta, pero solo mientras haya
 // algo escrito: al borrar el campo la lista no se queda colgada.
 const groups = useMemo(() => (ready && results ? buildGroups(results) : []), [ready, results]);
 const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

 const choose = (hit: Hit) => {
 setIsOpen(false);
 setQuery('');
 setResults(null);
 inputRef.current?.blur();
 if (hit.kind === 'coupon') {
 navigate(`/coupons?search=${encodeURIComponent(hit.code ?? '')}`);
 return;
 }
 openFicha(hit.kind, hit.id);
 };

 const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
 if (e.key === 'Escape') {
 setIsOpen(false);
 inputRef.current?.blur();
 return;
 }
 if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
 if (flat.length === 0) return;
 e.preventDefault();
 setIsOpen(true);
 const step = e.key === 'ArrowDown' ? 1 : -1;
 setCursor((c) => (c + step + flat.length) % flat.length);
 return;
 }
 if (e.key === 'Enter') {
 const hit = flat[cursor] ?? flat[0];
 if (hit) {
 e.preventDefault();
 choose(hit);
 }
 }
 };

 const showPanel = isOpen && ready;
 // Con resultados de una búsqueda anterior a la vista, se marca que se está actualizando.
 const stale = loading && searchedFor !== term;

 return (
 <div ref={rootRef} className="relative w-full max-w-2xl">
 <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--color-text-secondary)]" />
 <input
 ref={inputRef}
 type="text"
 role="combobox"
 aria-expanded={showPanel}
 aria-controls="global-search-results"
 aria-label="Buscar en el panel"
 autoComplete="off"
 value={query}
 onChange={(e) => {
 setQuery(e.target.value);
 setIsOpen(true);
 }}
 onFocus={() => setIsOpen(true)}
 onKeyDown={onKeyDown}
 placeholder="¿Qué quieres encontrar?"
 className="h-12 w-full rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-12 pr-14 text-sm font-medium text-[var(--color-text-main)] placeholder:text-[var(--color-text-secondary)] transition-all focus:border-[#D69E26] focus:ring-2 focus:ring-[#D69E26]/20 focus:outline-none"
 />
 {loading ? (
 <RefreshCw className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[var(--color-text-main)]" />
 ) : (
 <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-[10px] font-semibold text-[var(--color-text-main)] sm:block">
 Ctrl K
 </kbd>
 )}

 {showPanel ? (
 <div
 id="global-search-results"
 role="listbox"
 className="zipp-modal absolute left-0 top-full z-50 mt-2 max-h-[70vh] w-full min-w-[20rem] overflow-y-auto rounded-xl shadow-xl animate-fade-in"
 >
 {error ? (
 <p role="alert" className="px-4 py-3 text-xs font-semibold text-[var(--color-danger)]">
 {error}
 </p>
 ) : null}

 {!error && flat.length === 0 && !loading && searchedFor === term ? (
 <p className="px-4 py-3 text-xs text-[var(--color-text-main)]">
 Nada coincide con “{term}”.
 </p>
 ) : null}

 {!error && flat.length === 0 && (loading || searchedFor !== term) ? (
 <p className="px-4 py-3 text-xs text-[var(--color-text-main)]">Buscando…</p>
 ) : null}

 {groups.map((group, gi) => (
 <div
 key={group.kind}
 className={`${gi > 0 ? 'border-t border-[var(--color-border-light)]' : ''} ${stale ? 'opacity-60' : ''}`}
 >
 <p className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 <group.Icon className="h-3 w-3 text-[var(--color-text-main)]" /> {group.label}
 </p>
 {group.hits.map((hit, hi) => {
 const index = group.offset + hi;
 const selected = index === cursor;
 return (
 <button
 key={`${hit.kind}:${hit.id}`}
 type="button"
 role="option"
 aria-selected={selected}
 onMouseEnter={() => setCursor(index)}
 onClick={() => choose(hit)}
 className={`flex w-full cursor-pointer flex-col items-start px-4 py-2 text-left transition-colors ${
 selected ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'
 }`}
 >
 <span className={`text-xs font-bold ${selected ? 'underline underline-offset-2' : ''}`}>
 {hit.title}
 </span>
 {hit.detail ? (
 <span className="text-[11px] text-[var(--color-text-main)]">{hit.detail}</span>
 ) : null}
 </button>
 );
 })}
 </div>
 ))}
 </div>
 ) : null}
 </div>
 );
}
