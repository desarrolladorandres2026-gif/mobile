import { Search, RotateCw, Eye, X, ShoppingBag, MapPin, User, Store, Truck, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import RefundPanel from '../components/RefundPanel';
import Pagination from '../components/Pagination';
import { PermissionGate } from '../components/PermissionGate';

interface OrderItem {
  name: string;
  quantity: number;
  price: number;
}

interface OrderType {
  _id: string;
  orderNumber?: string;
  businessId?: { name: string; address?: string };
  /** Un mandado no tiene comercio de origen. */
  kind?: 'delivery' | 'errand';
  errand?: {
    description: string;
    pickupAddress: string;
    estimatedCost: number;
    maxCost: number;
    actualCost?: number;
  };
  clientId?: { name: string; phone: string };
  driverId?: { userId?: { name: string; phone?: string } };
  deliveryAddress?: { address: string; notes?: string };
  items?: OrderItem[];
  subtotal?: number;
  deliveryFee?: number;
  total: number;
  paymentMethod: string;
  /** Solo en efectivo: si el cliente avisó que paga con un billete que necesita vuelto. */
  cashPayment?: { needsChange: boolean; payingWith?: number };
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
const paymentStatusMap: Record<string, { label: string; bg: string; text: string }> = {
  pending:           { label: 'Pago pendiente',   bg: 'bg-[var(--color-warning-bg)] border-[var(--color-warning-bg)]', text: 'text-[#B45309]' },
  pending_cash:      { label: 'Cobra al entregar', bg: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)]', text: 'text-[var(--color-chart-purple)]' },
  cash_received:     { label: 'Efectivo recibido', bg: 'bg-[var(--color-success-bg)] border-[var(--color-success-bg)]', text: 'text-[#047857]' },
  paid:              { label: 'Pagado',           bg: 'bg-[var(--color-success-bg)] border-[var(--color-success-bg)]', text: 'text-[#047857]' },
  cash_not_received: { label: 'Efectivo NO recibido', bg: 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)]', text: 'text-[#B91C1C]' },
  failed:            { label: 'Cobro fallido',    bg: 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)]', text: 'text-[#B91C1C]' },
  refunded:          { label: 'Reembolsado',      bg: 'bg-[var(--color-bg-alt)] border-[var(--color-border)]', text: 'text-[var(--color-text-muted)]' },
};

// Espejo del esquema `orderStatus` de mobile/theme/tokens.ts: espera/cocina en
// ámbar, aceptado/listo en oro claro, en-camino en oro, entregado en esmeralda
// (señal de cierre distinta) y cancelado en coral. El texto usa el tono
// hermano más oscuro para legibilidad sobre el chip pálido.
const statusMap: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  pending:   { label: 'Pendiente',  bg: 'bg-[var(--color-warning-bg)] border-[var(--color-warning-bg)]', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
  accepted:  { label: 'Aceptado',   bg: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)]', text: 'text-[var(--color-chart-purple)]', dot: 'bg-[var(--color-primary-light)]' },
  preparing: { label: 'Preparando', bg: 'bg-[var(--color-warning-bg)] border-[var(--color-warning-bg)]', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
  ready:     { label: 'Listo',      bg: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)]', text: 'text-[var(--color-chart-purple)]', dot: 'bg-[var(--color-primary-light)]' },
  picked_up: { label: 'En camino',  bg: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)]', text: 'text-[#8A5D08]', dot: 'bg-[var(--color-primary)]' },
  on_way:    { label: 'En camino',  bg: 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)]', text: 'text-[#8A5D08]', dot: 'bg-[var(--color-primary)]' },
  delivered: { label: 'Entregado',  bg: 'bg-[var(--color-success-bg)] border-[var(--color-success-bg)]', text: 'text-[#047857]', dot: 'bg-[var(--color-success)]' },
  cancelled: { label: 'Cancelado',  bg: 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)]', text: 'text-[var(--color-danger)]', dot: 'bg-[var(--color-danger)]' },
};

const filterOptions = [
  { key: 'all',       label: 'Todos los pedidos' },
  { key: 'pending',   label: 'Pendientes' },
  { key: 'preparing', label: 'En preparación' },
  { key: 'ready',     label: 'Listos' },
  { key: 'on_way',    label: 'En camino' },
  { key: 'delivered', label: 'Entregados' },
  { key: 'cancelled', label: 'Cancelados' },
];

export default function Orders() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<OrderType[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState<OrderType | null>(null);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
  const PAGE_SIZE = 25;

  // La búsqueda se manda al servidor (ahí vive el índice y el `$regex`
  // sobre toda la tabla), no se filtra en el navegador sobre la página
  // actual — si no, "buscar" solo encontraría coincidencias dentro de
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
      const params: Record<string, string | number> = { page, limit: PAGE_SIZE };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (debouncedSearch) params.search = debouncedSearch;
      const { data } = await api.get('/admin/orders', { params });
      setOrders(data.data);
      if (data.meta) setMeta(data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedSearch, page]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  return (
    <div className="space-y-6 animate-fade-in">
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
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
        {/* Search */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
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
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                statusFilter === f.key
                  ? 'bg-[var(--color-primary)] text-white shadow-xs'
                  : 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-border)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
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
                  const sc = statusMap[o.status] || { label: o.status, bg: 'bg-gray-50 border-gray-200', text: 'text-gray-600', dot: 'bg-gray-400' };
                  return (
                    <tr key={o._id} className="hover:bg-[var(--color-bg)] transition-colors">
                      <td className="table-body-cell font-mono text-[var(--color-primary)] font-bold text-xs">
                        #{o._id.slice(-8).toUpperCase()}
                      </td>
                      <td className="table-body-cell font-semibold text-[var(--color-text-main)]">
                        {o.kind === 'errand'
                          ? `Mandado · ${o.errand?.pickupAddress ?? ''}`
                          : o.businessId?.name || 'Establecimiento'}
                      </td>
                      <td className="table-body-cell text-[var(--color-text-secondary)] text-xs">
                        {o.clientId?.name || 'Cliente'}
                      </td>
                      <td className="table-body-cell text-[var(--color-text-muted)] text-xs">
                        {o.driverId?.userId?.name || 'Sin asignar'}
                      </td>
                      <td className="table-body-cell font-bold text-[var(--color-text-main)]">
                        ${(o.total || 0).toLocaleString('es-CO')}
                      </td>
                      <td className="table-body-cell">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase ${
                          o.paymentMethod === 'online' ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-[var(--color-primary-bg)]' : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning-bg)]'
                        }`}>
                          {o.paymentMethod === 'online' ? 'Digital' : 'Efectivo'}
                        </span>
                      </td>
                      <td className="table-body-cell">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${sc.bg} ${sc.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} flex-shrink-0`} />
                          {sc.label}
                        </span>
                      </td>
                      <td className="table-body-cell">
                        <button
                          onClick={() => setSelectedOrder(o)}
                          className="p-1.5 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-all cursor-pointer"
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
                    <td colSpan={8} className="px-6 py-12 text-center text-[var(--color-text-muted)] text-xs font-medium">
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

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-5 relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--color-primary-bg)] text-[var(--color-primary)] flex items-center justify-center">
                  <ShoppingBag className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[var(--color-text-main)]">
                    Pedido #{selectedOrder._id.slice(-8).toUpperCase()}
                  </h3>
                  <p className="text-xs text-[var(--color-text-muted)] font-mono">
                    {new Date(selectedOrder.createdAt).toLocaleString('es-CO')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content Details */}
            <div className="space-y-4 text-xs divide-y divide-[var(--color-border-light)]">
              <div className="grid grid-cols-2 gap-4 pb-4">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Store className="w-3 h-3 text-[var(--color-primary)]" />{' '}
                    {selectedOrder.kind === 'errand' ? 'Recoger en' : 'Negocio'}
                  </span>
                  <p className="font-bold text-[var(--color-text-main)] text-sm">
                    {selectedOrder.kind === 'errand'
                      ? selectedOrder.errand?.pickupAddress
                      : selectedOrder.businessId?.name || 'Comercio'}
                  </p>
                  {selectedOrder.kind === 'errand' ? (
                    <p className="text-[var(--color-text-secondary)]">
                      {selectedOrder.errand?.description}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <User className="w-3 h-3 text-[var(--color-primary)]" /> Cliente
                  </span>
                  <p className="font-bold text-[var(--color-text-main)] text-sm">{selectedOrder.clientId?.name || 'Cliente'}</p>
                  <p className="text-[var(--color-text-secondary)]">{selectedOrder.clientId?.phone || '-'}</p>
                </div>
              </div>

              {/* Delivery info */}
              <div className="space-y-1 py-4">
                <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-[var(--color-primary)]" /> Dirección de Entrega
                </span>
                <p className="font-medium text-[var(--color-text-main)]">{selectedOrder.deliveryAddress?.address || 'Sin dirección'}</p>
                {selectedOrder.deliveryAddress?.notes && (
                  <p className="text-[var(--color-text-secondary)] italic">Notas: {selectedOrder.deliveryAddress.notes}</p>
                )}
              </div>

              {/* Driver info */}
              <div className="space-y-1 py-4">
                <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                  <Truck className="w-3 h-3 text-[var(--color-warning)]" /> Domiciliario Asignado
                </span>
                <p className="font-bold text-[var(--color-text-main)]">{selectedOrder.driverId?.userId?.name || 'Por asignar'}</p>
              </div>

              {/*
                Los reembolsos van aquí, pegados al pedido y no en una
                pantalla aparte: se deciden mirando quién pidió y qué
                pagó. El backend reparte el coste por línea; desde aquí
                solo se decide cuánto y por qué.
              */}
              <PermissionGate permission="finance:manage">
                <RefundPanel
                  orderId={selectedOrder._id}
                  orderTotal={selectedOrder.total || 0}
                  onDone={fetchOrders}
                />
              </PermissionGate>

              {/* Total summary */}
              <div className="pt-4 flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase font-bold text-[var(--color-text-muted)] tracking-wider">Total a pagar</p>
                  <p className="text-xl font-bold text-[var(--color-text-main)]">${(selectedOrder.total || 0).toLocaleString('es-CO')}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-[var(--color-primary)] text-white uppercase tracking-wider">
                    {selectedOrder.paymentMethod === 'online' ? 'Pago Digital' : 'Efectivo'}
                  </span>
                  {selectedOrder.paymentStatus && paymentStatusMap[selectedOrder.paymentStatus] ? (
                    <span
                      className={`px-2.5 py-1 rounded-md text-[11px] font-bold border ${
                        paymentStatusMap[selectedOrder.paymentStatus].bg
                      } ${paymentStatusMap[selectedOrder.paymentStatus].text}`}
                    >
                      {paymentStatusMap[selectedOrder.paymentStatus].label}
                    </span>
                  ) : null}
                </div>
              </div>

              {selectedOrder.paymentMethod === 'cash_on_delivery' ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {selectedOrder.cashPayment?.needsChange && selectedOrder.cashPayment.payingWith
                    ? `Paga con $${selectedOrder.cashPayment.payingWith.toLocaleString('es-CO')} · dar $${(selectedOrder.cashPayment.payingWith - (selectedOrder.total || 0)).toLocaleString('es-CO')} de vuelto`
                    : 'Entrega el valor exacto, sin cambio'}
                </p>
              ) : null}
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                onClick={() => setSelectedOrder(null)}
                className="px-4 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-text-main)] border border-[var(--color-border)] cursor-pointer transition-colors"
              >
                Cerrar
              </button>
              <button
                onClick={() => navigate(`/evidences?orderId=${selectedOrder._id}`)}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-xs font-bold text-white cursor-pointer transition-colors flex items-center gap-1.5"
              >
                <ShieldCheck className="w-3.5 h-3.5" /> Ver códigos y evidencias
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

