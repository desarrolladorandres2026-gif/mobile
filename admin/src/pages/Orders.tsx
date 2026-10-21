import { useLiveReload } from '../hooks/useLiveReload';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { FICHA_CHANGED_EVENT, useFicha } from '../lib/entityLinks';

/**
 * Lo que el listado necesita de cada pedido. El detalle completo (líneas,
 * dirección, dinero, reembolsos, códigos, notas) vive en la ficha del pedido,
 * que se abre con `?ficha=order:<id>`.
 */
interface OrderType {
 _id: string;
 orderNumber?: string;
 businessId?: { _id?: string; name: string };
 /** Un mandado no tiene comercio de origen. */
 kind?: 'delivery' | 'errand';
 errand?: { pickupAddress: string };
 clientId?: { _id?: string; name: string };
 /** `_id` es el del `Driver`, que es lo que abre su ficha. */
 driverId?: { _id?: string; userId?: { name: string } };
 total: number;
 paymentMethod: string;
 paymentStatus?: string;
 status: string;
 createdAt: string;
}

/**
 * Estado del cobro, no del pedido.
 *
 * Son dos ejes distintos y hasta ahora el panel solo mostraba uno: un
 * pedido entregado cuyo efectivo el domiciliario declaró no haber
 * recibido se veía exactamente igual que uno cobrado sin incidencias.
 * `cash_not_received` es justamente el caso que alguien tiene que ver.
 */
const paymentStatusMap: Record<string, { label: string; text: string }> = {
 pending: { label: 'Pago pendiente', text: 'text-[var(--color-warning)]' },
 pending_cash: { label: 'Cobra al entregar', text: 'text-[var(--color-text-main)]' },
 cash_received: { label: 'Efectivo recibido', text: 'text-[var(--color-success)]' },
 paid: { label: 'Pagado', text: 'text-[var(--color-success)]' },
 cash_not_received: { label: 'Efectivo no recibido', text: 'text-[var(--color-danger)]' },
 failed: { label: 'Cobro fallido', text: 'text-[var(--color-danger)]' },
 refunded: { label: 'Reembolsado', text: 'text-[var(--color-text-main)]' },
};

// El estado es la palabra en su color, sin píldoras ni puntos: pendiente en
// ámbar, entregado en verde, cancelado en rojo y el resto en el color de texto.
const statusMap: Record<string, { label: string; text: string }> = {
 pending: { label: 'Pendiente', text: 'text-[var(--color-warning)]' },
 accepted: { label: 'Aceptado', text: 'text-[var(--color-text-main)]' },
 preparing: { label: 'Preparando', text: 'text-[var(--color-text-main)]' },
 ready: { label: 'Listo', text: 'text-[var(--color-text-main)]' },
 picked_up: { label: 'En camino', text: 'text-[var(--color-text-main)]' },
 on_way: { label: 'En camino', text: 'text-[var(--color-text-main)]' },
 delivered: { label: 'Entregado', text: 'text-[var(--color-success)]' },
 cancelled: { label: 'Cancelado', text: 'text-[var(--color-danger)]' },
};

// El cliente y el comercio hablan de `orderNumber`, y es por lo que busca el servidor.
const orderLabel = (o: Pick<OrderType, '_id' | 'orderNumber'>) =>
 o.orderNumber || o._id.slice(-8).toUpperCase();

const filterOptions = [
 { key: 'all', label: 'Todos los pedidos' },
 { key: 'pending', label: 'Pendientes' },
 { key: 'preparing', label: 'En preparación' },
 { key: 'ready', label: 'Listos' },
 { key: 'on_way', label: 'En camino' },
 { key: 'delivered', label: 'Entregados' },
 { key: 'cancelled', label: 'Cancelados' },
];

export default function Orders() {
 const { current, open: openFicha } = useFicha();
 const [orders, setOrders] = useState<OrderType[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [search, setSearch] = useState('');
 const [statusFilter, setStatusFilter] = useState('all');
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const PAGE_SIZE = 25;
 const [filterOpen, setFilterOpen] = useState(false);
 const filterRef = useRef<HTMLDivElement>(null);
 useEffect(() => {
 if (!filterOpen) return;
 const close = (e: MouseEvent) => {
 if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
 };
 document.addEventListener('mousedown', close);
 return () => document.removeEventListener('mousedown', close);
 }, [filterOpen]);

 // La búsqueda se manda al servidor (ahí vive el índice y el `$regex`
 // sobre toda la tabla), no se filtra en el navegador sobre la página
 // actual — si no,"buscar" solo encontraría coincidencias dentro de
 // los 25 pedidos ya cargados. El backend sólo busca por `orderNumber`,
 // no por el `_id` crudo ni por nombre de negocio/cliente como hacía
 // antes el filtro del navegador.
 const [debouncedSearch, setDebouncedSearch] = useState('');
 useEffect(() => {
 const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
 return () => clearTimeout(t);
 }, [search]);
 useEffect(() => { setPage(1); }, [statusFilter, debouncedSearch]);

 // `useCallback` con sus dependencias de verdad, y el efecto colgando de
 // ella. Antes la función se recreaba en cada render y el efecto
 // dependía de [statusFilter] a mano: la lista tenía que mantenerse
 // sincronizada con lo que la función lee por dentro, y cuando dejaba
 // de estarlo el panel se quedaba pidiendo datos del filtro anterior.
 const fetchOrders = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const params: Record<string, string | number> = { page, limit: PAGE_SIZE };
 if (statusFilter !== 'all') params.status = statusFilter;
 if (debouncedSearch) params.search = debouncedSearch;
 const { data } = await api.get('/admin/orders', { params });
 setOrders(data.data);
 if (data.meta) setMeta(data.meta);
 } catch (err) {
 console.error(err);
 setError(apiMessage(err, 'No se pudieron cargar los pedidos.'));
 } finally {
 setLoading(false);
 }
 }, [statusFilter, debouncedSearch, page]);

 useLiveReload(['orders'], fetchOrders);
 useEffect(() => {
 fetchOrders();
 }, [fetchOrders]);

 // Enlaces viejos (`/orders?orderId=X`) siguen funcionando: se traducen a la
 // ficha (`?ficha=order:X`) sin dejar la entrada antigua en el historial.
 const [searchParams, setSearchParams] = useSearchParams();
 const linkedOrderId = searchParams.get('orderId');
 useEffect(() => {
 if (!linkedOrderId) return;
 setSearchParams(
 (prev) => {
 const next = new URLSearchParams(prev);
 next.delete('orderId');
 next.set('ficha', `order:${linkedOrderId}`);
 return next;
 },
 { replace: true },
 );
 }, [linkedOrderId, setSearchParams]);

 // La ficha permite reembolsar, cancelar o reasignar: al cerrarla, el
 // listado se pone al día. También si la propia ficha avisa de un cambio.
 const wasOpen = useRef(false);
 useEffect(() => {
 if (wasOpen.current && !current) fetchOrders();
 wasOpen.current = current !== null;
 }, [current, fetchOrders]);
 useEffect(() => {
 window.addEventListener(FICHA_CHANGED_EVENT, fetchOrders);
 return () => window.removeEventListener(FICHA_CHANGED_EVENT, fetchOrders);
 }, [fetchOrders]);

 return (
 <div className="space-y-3">
 <div className="page-header">
 <div>
 <h1 className="page-title">Pedidos</h1>
 <p className="page-subtitle">Historial en tiempo real de todas las solicitudes procesadas</p>
 </div>
 </div>

 <div className="flex flex-col md:flex-row gap-2 justify-between items-center pb-3 border-b border-[var(--color-border)]">
 <div className="w-full md:w-80">
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por número de pedido…"
 aria-label="Buscar por número de pedido"
 className="field"
 />
 </div>

 <div ref={filterRef} className="relative w-full md:w-auto">
 <button
 onClick={() => setFilterOpen((v) => !v)}
 aria-haspopup="menu"
 aria-expanded={filterOpen}
 className="btn btn-secondary w-full md:w-auto"
 >
 Filtros{statusFilter !== 'all' ? `: ${filterOptions.find((f) => f.key === statusFilter)?.label}` : ''}
 </button>
 {filterOpen && (
 <div role="menu" className="absolute right-0 top-full mt-1 z-20 min-w-52 py-1 bg-[var(--color-surface)] border border-[var(--dialog-border)] rounded">
 {filterOptions.map((f) => (
 <button
 key={f.key}
 role="menuitem"
 onClick={() => { setStatusFilter(f.key); setFilterOpen(false); }}
 className={`w-full text-left h-8 px-3 text-sm cursor-pointer text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] ${
 statusFilter === f.key ? 'font-semibold' : 'font-normal'
 }`}
 >
 {f.label}
 </button>
 ))}
 </div>
 )}
 </div>
 </div>

 {error && (
 <p className="state-line state-line-error">
 {error}{' '}
 <button onClick={fetchOrders} className="btn btn-text">Reintentar</button>
 </p>
 )}

 {loading ? (
 <p className="state-line min-h-32">Cargando…didos…</p>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">ID pedido</th>
 <th className="table-header-cell">Negocio</th>
 <th className="table-header-cell">Cliente</th>
 <th className="table-header-cell">Domiciliario</th>
 <th className="table-header-cell num">Total</th>
 <th className="table-header-cell">Pago</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {orders.map((o) => {
 const sc = statusMap[o.status] || { label: o.status, text: 'text-[var(--color-text-main)]' };
 const selected = current?.type === 'order' && current.id === o._id;
 return (
 <tr
 key={o._id}
 aria-selected={selected}
 onClick={() => openFicha('order', o._id)}
 className="cursor-pointer"
 >
 <td className="table-body-cell font-semibold text-[var(--color-text-main)]">
 <EntityLink type="order" id={o._id}>#{orderLabel(o)}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {o.kind === 'errand' ? (
 `Mandado · ${o.errand?.pickupAddress ?? ''}`
 ) : (
 <EntityLink type="business" id={o.businessId?._id}>
 {o.businessId?.name || 'Establecimiento'}
 </EntityLink>
 )}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 <EntityLink type="user" id={o.clientId?._id}>{o.clientId?.name || 'Cliente'}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {o.driverId?.userId?.name ? (
 <EntityLink type="driver" id={o.driverId._id}>{o.driverId.userId.name}</EntityLink>
 ) : (
 'Sin asignar'
 )}
 </td>
 <td className="table-body-cell num text-[var(--color-text-main)]">
 $ {(o.total || 0).toLocaleString('es-CO')}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">
 {o.paymentMethod === 'online' ? 'Digital' : 'Efectivo'}
 {o.paymentStatus && paymentStatusMap[o.paymentStatus] ? (
 <span className={`ml-2 font-semibold ${paymentStatusMap[o.paymentStatus].text}`}>
 {paymentStatusMap[o.paymentStatus].label}
 </span>
 ) : null}
 </td>
 <td className="table-body-cell">
 <span className={`font-semibold ${sc.text}`}>{sc.label}</span>
 </td>
 <td className="table-body-cell">
 <button
 onClick={(e) => {
 e.stopPropagation();
 openFicha('order', o._id);
 }}
 className="btn btn-text"
 >
 Ver detalle
 </button>
 </td>
 </tr>
 );
 })}
 {orders.length === 0 && (
 <tr>
 <td colSpan={8} className="state-line">
 No hay pedidos con estos filtros.{' '}
 <button
 onClick={() => { setSearch(''); setStatusFilter('all'); }}
 className="btn btn-text"
 >
 Limpiar filtros
 </button>
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </div>
 )}
 </div>
 );
}
