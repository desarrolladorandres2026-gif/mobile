import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, Eye, Store, AlertCircle, Check } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import { useActiveOrders } from '../hooks/useActiveOrders';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useTrailingCallback } from '../hooks/useTrailingCallback';
import OrderDetailPanel from '../components/OrderDetailPanel';
import Pagination from '../components/Pagination';
import OrderBoard from '../components/OrderBoard';
import RejectOrderDialog from '../components/RejectOrderDialog';
import {
  ORDER_STATUS, statusStyle, money, shortId, dateTime, isActive,
  type OrderStatus,
  type BusinessOrder,
  type OrderItem,
} from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';

/**
 * Pedidos: comandas activas + historial, en una sola pantalla.
 *
 * Antes la cola de comandas activas (aceptar, cocinar, marcar listo,
 * traspaso al repartidor) vivía en el Dashboard —montado en "/"— y esta
 * pantalla solo tenía el historial de solo lectura. El Dashboard era una
 * segunda entrada duplicada al recargar el panel ("Resumen general"
 * reaparecía aunque la barra lateral ya no lo enlazara), así que la
 * gestión de pedidos se trae aquí y "/" pasa a ser el Resumen del día.
 *
 * Comparte con la cola el vocabulario de estados (`lib/orderFlow`) y la
 * misma ficha de detalle. Antes tenía copias propias de las dos cosas, y
 * ya habían divergido: el mismo pedido se llamaba distinto en cada
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

  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'active' | 'history'>('active');

  // "Ver pedido" del aviso llega como `/orders?pedido=<id>`: hay que estar en
  // las activas para que el tablero pueda enseñarlo. Se ajusta durante el
  // render (y no en un efecto) para no pintar primero el historial.
  const focusId = useSearchParams()[0].get('pedido');
  const [seenFocus, setSeenFocus] = useState<string | null>(null);
  if (focusId && focusId !== seenFocus) {
    setSeenFocus(focusId);
    setTab('active');
  }

  // ── Historial ──
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  // ── Comandas activas ──
  const [queueSearch, setQueueSearch] = useState('');
  const [rejecting, setRejecting] = useState<BusinessOrder | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  // Sube en cada evento del traspaso: el pedido sigue en "listo" cuando el
  // domiciliario llega, así que nada más cambia para que `PickupHandoff`
  // sepa que debe volver a pedir el código.
  const [handoffTick, setHandoffTick] = useState(0);

  const [detailOrder, setDetailOrder] = useState<BusinessOrder | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  useEffect(() => { setPage(1); }, [filter]);

  const activeFilterLabel = FILTERS.find((option) => option.value === filter)?.label;

  // La misma consulta que lee la alarma global (hooks/useActiveOrders): el
  // tablero y el timbre nunca discrepan sobre qué pedidos esperan.
  const queueQuery = useActiveOrders(businessId);
  const queue = useMemo(() => queueQuery.data ?? [], [queueQuery.data]);
  const queueLoading = !!businessId && queueQuery.isPending;
  const queueError = queueQuery.isError ? 'No pudimos cargar las comandas activas.' : '';

  // El estado se filtra en el servidor: traer cien pedidos para esconder
  // noventa en el navegador desperdicia la consulta y deja fuera justo los
  // que el filtro debería encontrar.
  //
  // `placeholderData` deja la página anterior en pantalla mientras llega la
  // siguiente, en vez de vaciar la tabla en cada cambio de página o filtro.
  const ordersQuery = useQuery({
    queryKey: qk.orders(businessId, 'history', filter, page),
    enabled: !!businessId,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get(`/orders/business/${businessId}`, {
        params: { page, limit: PAGE_SIZE, ...(filter === 'all' ? {} : { status: filter }) },
      });
      return {
        orders: data.data as BusinessOrder[],
        meta: (data.meta ?? { total: 0, totalPages: 1, limit: PAGE_SIZE }) as { total: number; totalPages: number; limit: number },
      };
    },
  });

  const orders = useMemo(() => ordersQuery.data?.orders ?? [], [ordersQuery.data]);
  const meta = ordersQuery.data?.meta ?? { total: 0, totalPages: 1, limit: PAGE_SIZE };
  const loading = !!businessId && ordersQuery.isPending;
  const error = ordersQuery.isError ? 'No pudimos cargar el historial de pedidos.' : '';

  const load = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.orders(businessId) });
    void queryClient.invalidateQueries({ queryKey: qk.activeOrders(businessId) });
  }, [queryClient, businessId]);
  const loadSoon = useTrailingCallback(load, 1000);

  // Esta pantalla no tenía tiempo real para el historial: un pedido que se
  // entregaba mientras estaba abierta seguía apareciendo "en camino" hasta
  // que alguien pulsaba Actualizar. La cola de comandas sí lo necesita
  // siempre: un pedido pendiente que nadie ve no se acepta a tiempo.
  // La llegada de pedidos nuevos al tablero ya no se maneja aquí: la
  // alarma global (`useActiveOrdersLiveSync`, montada en el Layout) mantiene
  // el caché al día en todas las pantallas, no solo en esta.
  useBusinessEvent('order:status:changed', () => {
    loadSoon();
    setLiveTick((tick) => tick + 1);
  });
  useBusinessEvent('order:driver:assigned', loadSoon);
  useBusinessEvent('order:driver:arrived', () => setHandoffTick((tick) => tick + 1));

  const updateStatus = async (orderId: string, status: string, cancellationReason?: string) => {
    try {
      setActionError('');
      setBusyOrderId(orderId);
      await api.patch(`/orders/${orderId}/status`, { status, cancellationReason });
      load();
    } catch (err) {
      // El mensaje del servidor es el que explica de verdad qué pasó
      // ("este pedido es de pago en línea y aún no está pagado"), así que
      // se muestra tal cual en vez de un error genérico.
      setActionError(apiMessage(err, 'No pudimos actualizar el pedido.'));
    } finally {
      setBusyOrderId(null);
    }
  };

  const filteredQueue = useMemo(() => {
    const term = queueSearch.trim().toLowerCase();
    const active = queue.filter((order) => isActive(order.status));
    if (!term) return active;
    return active.filter((order) => {
      const detail = (order.items ?? []).map((item) => item.productName).join(' ');
      return [order.orderNumber, order.clientId?.name, detail, order.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [queue, queueSearch]);

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
    <div className="space-y-10 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pedidos</h1>
          <p className="page-subtitle">Gestiona lo que está en cocina y consulta el historial de tu local</p>
        </div>
        <button
          onClick={load}
          className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5 text-[var(--color-primary)]" />
          Actualizar
        </button>
      </div>

      {(actionError || queueError) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="text-xs font-semibold text-[var(--color-danger)]">{actionError || queueError}</p>
        </div>
      )}

      {/* ── Pestañas ── */}
      <div role="tablist" aria-label="Vista de pedidos" className="flex items-end gap-8 border-b border-[var(--color-border)]">
        {([["active", "Activas", filteredQueue.length], ["history", "Historial", null]] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`-mb-px pb-3 text-sm font-bold border-b-2 cursor-pointer transition-colors ${
              tab === value
                ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
            }`}
          >
            {label}
            {count !== null && <span className="ml-2 tabular text-xs">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "active" && (
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Arrastra un pedido a la columna siguiente o usa su botón.
          </p>
          <label className="flex h-10 w-full sm:w-72 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-[var(--color-text-secondary)] focus-within:border-[var(--color-primary)]">
            <Search className="w-4 h-4 shrink-0" />
            <input
              value={queueSearch}
              onChange={(event) => setQueueSearch(event.target.value)}
              placeholder="Buscar en la cocina…"
              className="w-full bg-transparent text-xs text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-secondary)]"
            />
          </label>
        </div>

        {queueLoading ? (
          <p className="p-12 text-center text-xs font-semibold text-[var(--color-text-secondary)]">Cargando comandas…</p>
        ) : (
          <OrderBoard
            orders={filteredQueue}
            focusId={focusId}
            busyOrderId={busyOrderId}
            handoffTick={handoffTick}
            onAdvance={(order, status) => updateStatus(order._id, status)}
            onReject={setRejecting}
            onOpen={setDetailOrder}
          />
        )}
      </section>
      )}


      {tab === "history" && (
      <section className="space-y-4">

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
            <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
            <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>
          </div>
        )}

        <div className="cols3" style={{ height: 'auto' }}>
          <div className="space-y-5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-secondary)]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por número de pedido o cliente…"
                aria-label="Buscar pedidos"
                className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-secondary)] outline-none focus:border-[var(--color-primary)] transition-colors"
              />
            </div>
            <div>
              <h3 className="col-title">Estado</h3>
              <div role="radiogroup" aria-label="Filtrar por estado" className="divide-y divide-[var(--color-border)]">
                {FILTERS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={filter === option.value}
                    onClick={() => setFilter(option.value)}
                    className={`w-full flex items-center justify-between py-2 text-xs font-semibold cursor-pointer transition-colors hover:text-[var(--color-primary)] ${
                      filter === option.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-main)]'
                    }`}
                  >
                    {option.label}
                    {filter === option.value && <Check className="w-3.5 h-3.5" />}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-[var(--color-text-secondary)] tabular">
              {meta.total.toLocaleString('es-CO')} pedidos{filter !== 'all' ? ` · ${activeFilterLabel}` : ''}
            </p>
          </div>

          <div className="span2">
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
                        <td colSpan={8} className="table-body-cell text-center text-[var(--color-text-secondary)] py-12">
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
                            <td className="table-body-cell text-[var(--color-text-secondary)] tabular">
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
          </div>
        </div>
      </section>
      )}

      {detailOrder && businessId && (
        <OrderDetailPanel
          order={detailOrder}
          businessId={businessId}
          refreshKey={liveTick}
          onClose={() => setDetailOrder(null)}
        />
      )}

      {rejecting && (
        <RejectOrderDialog
          order={rejecting}
          onCancel={() => setRejecting(null)}
          onConfirm={async (reason) => {
            await updateStatus(rejecting._id, 'cancelled', reason);
            setRejecting(null);
          }}
        />
      )}
    </div>
  );
}
