import { Search, RotateCw, Eye, AlertCircle } from 'lucide-react';
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
 pending: { label: 'Pago pendiente', text: 'text-[#B45309]' },
 pending_cash: { label: 'Cobra al entregar', text: 'text-[var(--color-chart-purple)]' },
 cash_received: { label: 'Efectivo recibido', text: 'text-[#047857]' },
 paid: { label: 'Pagado', text: 'text-[#047857]' },
 cash_not_received: { label: 'Efectivo NO recibido', text: 'text-[#B91C1C]' },
 failed: { label: 'Cobro fallido', text: 'text-[#B91C1C]' },
 refunded: { label: 'Reembolsado', text: 'text-[var(--color-text-main)]' },
};

// Espejo del esquema `orderStatus` de mobile/theme/tokens.ts: espera/cocina en
// ámbar, aceptado/listo en oro claro, en-camino en oro, entregado en esmeralda
// (señal de cierre distinta) y cancelado en coral. El texto usa el tono
// hermano más oscuro para legibilidad sobre el chip pálido.
const statusMap: Record<string, { label: string; text: string; dot: string }> = {
 pending: { label: 'Pendiente', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
 accepted: { label: 'Aceptado', text: 'text-[var(--color-chart-purple)]', dot: 'bg-[var(--color-primary-light)]' },
 preparing: { label: 'Preparando', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
 ready: { label: 'Listo', text: 'text-[var(--color-chart-purple)]', dot: 'bg-[var(--color-primary-light)]' },
 picked_up: { label: 'En camino', text: 'text-[#8A5D08]', dot: 'bg-[var(--color-primary)]' },
 on_way: { label: 'En camino', text: 'text-[#8A5D08]', dot: 'bg-[var(--color-primary)]' },
 delivered: { label: 'Entregado', text: 'text-[#047857]', dot: 'bg-[var(--color-success)]' },
 cancelled: { label: 'Cancelado', text: 'text-[var(--color-danger)]', dot: 'bg-[var(--color-danger)]' },
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
 <div className="space-y-3 animate-fade-in">
 {/* Header */}
 <div className="page-header">
 <div>
 <h1 className="page-title">Monitoreo de Pedidos</h1>
 <p className="page-subtitle">Historial en tiempo real de todas las solicitudes procesadas</p>
 </div>
 <button
 onClick={fetchOrders}
 className="px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xs"
 >
 <RotateCw className="w-4 h-4 text-[var(--color-primary)]" />
 <span>Actualizar lista</span>
 </button>
 </div>

 {/* Filter & Search Bar */}
 <div className="flex flex-col md:flex-row gap-2.5 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
 {/* Search */}
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por número de pedido..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
 />
 </div>

 {/* Filter Pills */}
 <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
 {filterOptions.map((f) => (
 <button
 key={f.key}
 onClick={() => setStatusFilter(f.key)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${
 statusFilter === f.key
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {f.label}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4 shrink-0" /> {error}
 </p>
 )}

 {/* Table */}
 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
 Cargando listado de pedidos...
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="w-full">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">ID Pedido</th>
 <th className="table-header-cell">Negocio</th>
 <th className="table-header-cell">Cliente</th>
 <th className="table-header-cell">Domiciliario</th>
 <th className="table-header-cell">Total</th>
 <th className="table-header-cell">Pago</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-[var(--color-border-light)]">
 {orders.map((o) => {
 const sc = statusMap[o.status] || { label: o.status, text: 'text-gray-900', dot: 'bg-gray-400' };
 return (
 <tr
 key={o._id}
 onClick={() => openFicha('order', o._id)}
 className="cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
 >
 <td className="table-body-cell font-mono text-[var(--color-primary)] font-bold text-xs">
 <EntityLink type="order" id={o._id}>#{orderLabel(o)}</EntityLink>
 </td>
 <td className="table-body-cell font-semibold text-[var(--color-text-main)]">
 {o.kind === 'errand' ? (
 `Mandado · ${o.errand?.pickupAddress ?? ''}`
 ) : (
 <EntityLink type="business" id={o.businessId?._id}>
 {o.businessId?.name || 'Establecimiento'}
 </EntityLink>
 )}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)] text-xs">
 <EntityLink type="user" id={o.clientId?._id}>{o.clientId?.name || 'Cliente'}</EntityLink>
 </td>
 <td className="table-body-cell text-[var(--color-text-main)] text-xs">
 {o.driverId?.userId?.name ? (
 <EntityLink type="driver" id={o.driverId._id}>{o.driverId.userId.name}</EntityLink>
 ) : (
 'Sin asignar'
 )}
 </td>
 <td className="table-body-cell font-bold text-[var(--color-text-main)]">
 ${(o.total || 0).toLocaleString('es-CO')}
 </td>
 <td className="table-body-cell">
 <span className={`text-[10px] font-bold uppercase ${
 o.paymentMethod === 'online' ? 'text-[var(--color-primary)]' : 'text-[var(--color-warning)]'
 }`}>
 {o.paymentMethod === 'online' ? 'Digital' : 'Efectivo'}
 </span>
 {o.paymentStatus && paymentStatusMap[o.paymentStatus] ? (
 <p className={`text-[10px] font-bold ${paymentStatusMap[o.paymentStatus].text}`}>
 {paymentStatusMap[o.paymentStatus].label}
 </p>
 ) : null}
 </td>
 <td className="table-body-cell">
 <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${sc.text}`}>
 <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} flex-shrink-0`} />
 {sc.label}
 </span>
 </td>
 <td className="table-body-cell">
 <button
 onClick={(e) => {
 e.stopPropagation();
 openFicha('order', o._id);
 }}
 className="p-1.5 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-primary)] transition-all cursor-pointer"
 title="Ver detalle del pedido"
 >
 <Eye className="w-4 h-4" />
 </button>
 </td>
 </tr>
 );
 })}
 {orders.length === 0 && (
 <tr>
 <td colSpan={8} className="px-6 py-12 text-center text-[var(--color-text-main)] text-xs font-medium">
 No hay pedidos que coincidan con el filtro seleccionado.
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

