import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Eye, Store, AlertCircle } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import api from '../services/api';
import OrderDetailPanel from '../components/OrderDetailPanel';
import Pagination from '../components/Pagination';
import {
  ORDER_STATUS, statusStyle, money, shortId, dateTime, type OrderStatus,
  type BusinessOrder,
  type OrderItem,
} from '../lib/orderFlow';

/**
 * Historial de ventas del comercio.
 *
 * Comparte con el Dashboard el vocabulario de estados (`lib/orderFlow`) y
 * la misma ficha de detalle. Antes tenía copias propias de las dos cosas,
 * y ya habían divergido: el mismo pedido se llamaba distinto en cada
 * pantalla y esta ficha leía `item.price`, un campo que el pedido no
 * tiene, así que cada línea mostraba $0.
 */

const FILTERS: Array<{ value: OrderStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'delivered', label: ORDER_STATUS.delivered.label },
  { value: 'on_way', label: ORDER_STATUS.on_way.label },
  { value: 'ready', label: ORDER_STATUS.ready.label },
  { value: 'preparing', label: ORDER_STATUS.preparing.label },
  { value: 'pending', label: ORDER_STATUS.pending.label },
  { value: 'cancelled', label: ORDER_STATUS.cancelled.label },
];

export default function Orders() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const [orders, setOrders] = useState<BusinessOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');
  const [detailOrder, setDetailOrder] = useState<BusinessOrder | null>(null);
  const [liveTick, setLiveTick] = useState(0);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
  const PAGE_SIZE = 25;

  useEffect(() => { setPage(1); }, [filter]);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      setError('');
      // El estado se filtra en el servidor: traer cien pedidos para
      // esconder noventa en el navegador desperdicia la consulta y deja
      // fuera justo los que el filtro debería encontrar.
      const { data } = await api.get(`/orders/business/${businessId}`, {
        params: { page, limit: PAGE_SIZE, ...(filter === 'all' ? {} : { status: filter }) },
      });
      setOrders(data.data);
      if (data.meta) setMeta(data.meta);
    } catch (err) {
      console.error(err);
      setError('No pudimos cargar el historial de pedidos.');
    } finally {
      setLoading(false);
    }
  }, [businessId, filter, page]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // Esta pantalla no tenía tiempo real: un pedido que se entregaba
  // mientras estaba abierta seguía apareciendo "en camino" hasta que
  // alguien pulsaba Actualizar.
  useBusinessEvent('order:status:changed', () => {
    load();
    setLiveTick((tick) => tick + 1);
  });
  useBusinessEvent('order:driver:assigned', () => load());
  useBusinessEvent('order:driver:arrived', () => setLiveTick((tick) => tick + 1));

  // El backend de `/orders/business/:id` no acepta un filtro de texto
  // (ver `order.service.ts` → `getByBusiness`): esta búsqueda sigue
  // siendo del navegador, sobre la página de 25 pedidos ya cargada, no
  // sobre todo el historial. Cambiar de página resetea lo que se ve.
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return orders;
    return orders.filter((order) =>
      [order.orderNumber, order._id, order.clientId?.name]
        // `.filter(Boolean)` quita los vacíos en tiempo de ejecución pero
        // no estrecha el tipo: hace falta el predicado para que el
        // `.toLowerCase()` de abajo no sea una promesa sin respaldo.
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(term))
    );
  }, [orders, search]);

  if (!selectedBusiness) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
        <p className="font-bold text-[var(--color-text-main)] text-base">
          Sin establecimiento seleccionado
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Elige un negocio en el menú lateral.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pedidos</h1>
          <p className="page-subtitle">Registro cronológico de todo lo que ha pasado por tu local</p>
        </div>
        <button
          onClick={load}
          className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5 text-[var(--color-primary)]" />
          Actualizar
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por número de pedido o cliente…"
            aria-label="Buscar pedidos"
            className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-primary)] transition-colors"
          />
        </div>

        {/* Filtros como pestañas y no como un desplegable: son siete y el
            comercio alterna entre dos o tres todo el día. */}
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors cursor-pointer border ${
                filter === option.value
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-container">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className="table-header-cell">Pedido</th>
                <th className="table-header-cell">Cliente</th>
                <th className="table-header-cell">Productos</th>
                <th className="table-header-cell text-right">Total</th>
                <th className="table-header-cell">Pago</th>
                <th className="table-header-cell">Estado</th>
                <th className="table-header-cell">Fecha</th>
                <th className="table-header-cell sr-only">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="table-body-cell text-center text-[var(--color-text-secondary)] py-12">
                    Cargando historial…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="table-body-cell text-center text-[var(--color-text-muted)] py-12">
                    {search
                      ? 'Ningún pedido coincide con la búsqueda.'
                      : 'Todavía no hay pedidos con ese estado.'}
                  </td>
                </tr>
              ) : (
                visible.map((order) => {
                  const style = statusStyle(order.status);
                  return (
                    <tr
                      key={order._id}
                      className="hover:bg-[var(--color-surface-hover)] transition-colors"
                    >
                      <td className="table-body-cell tabular font-bold text-[var(--color-primary)]">
                        {order.orderNumber ?? shortId(order._id)}
                      </td>
                      <td className="table-body-cell font-bold text-[var(--color-text-main)]">
                        {order.clientId?.name ?? 'Cliente'}
                      </td>
                      <td className="table-body-cell text-[var(--color-text-secondary)] max-w-xs truncate">
                        {(order.items ?? [])
                          .map((item: OrderItem) => `${item.quantity}× ${item.productName}`)
                          .join(', ')}
                      </td>
                      <td className="table-body-cell text-right tabular font-bold text-[var(--color-text-main)]">
                        {money(order.total)}
                      </td>
                      <td className="table-body-cell">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                            order.paymentMethod === 'online'
                              ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-[var(--color-primary)]/40'
                              : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning)]/40'
                          }`}
                        >
                          {order.paymentMethod === 'online' ? 'Digital' : 'Efectivo'}
                        </span>
                      </td>
                      <td className="table-body-cell">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${style.chip}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${style.dot} shrink-0`} />
                          {style.label}
                        </span>
                      </td>
                      <td className="table-body-cell text-[var(--color-text-muted)] tabular">
                        {dateTime(order.createdAt)}
                      </td>
                      <td className="table-body-cell">
                        <button
                          onClick={() => setDetailOrder(order)}
                          aria-label={`Ver el detalle del pedido ${order.orderNumber ?? ''}`}
                          className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
      </div>

      {detailOrder && businessId && (
        <OrderDetailPanel
          order={detailOrder}
          businessId={businessId}
          refreshKey={liveTick}
          onClose={() => setDetailOrder(null)}
        />
      )}
    </div>
  );
}
