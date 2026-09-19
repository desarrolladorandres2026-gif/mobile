import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Store, RefreshCw, Play, Check, Eye, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useTrailingCallback } from '../hooks/useTrailingCallback';
import { useAuthStore } from '../stores/authStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import { useBusinessEvent, useRealtime } from '../hooks/realtimeContext';
import {
  PackageIllustration, CashIllustration, WalletIllustration, PrepTimeIllustration,
} from '../components/illustrations';
import PickupHandoff from '../components/PickupHandoff';
import OrderDetailPanel from '../components/OrderDetailPanel';
import RejectOrderDialog from '../components/RejectOrderDialog';
import {
  statusStyle, isActive, nextBusinessStep, money, signedMoney, shortId, clock,
  ACTIVE_STATUSES,
  type BusinessOrder,
  type OrderItem,
} from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';

/**
 * La pantalla de cocina del comercio.
 *
 * Dos fuentes y ninguna mezcla:
 *
 *  · **La cola** (`/orders/business/:id`) es operación — qué hay que
 *    cocinar ahora. Se cuenta en el navegador porque son los pedidos que
 *    están abiertos en esta pantalla.
 *  · **El dinero** (`/businesses/:id/statement`) llega ya calculado. Antes
 *    se sumaba aquí, recorriendo la lista de pedidos; como esa lista viene
 *    paginada, "tu ganancia neta" era en realidad la suma de los pedidos
 *    que cupieron en la primera página. Un panel que enseña un número
 *    menor del que se te debe es peor que uno que no lo enseña.
 */

interface Totals {
  orderCount: number;
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  reversedAmount: number;
  netAmount: number;
}

interface Statement {
  outstanding: number;
  settled: number;
  nextSettlement: Totals;
  weeks: Array<Totals & { periodStart: string }>;
}

export default function Dashboard() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const { connected } = useRealtime();
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [detailOrder, setDetailOrder] = useState<BusinessOrder | null>(null);
  const [rejecting, setRejecting] = useState<BusinessOrder | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  /**
   * Sube en cada evento del traspaso. El pedido sigue en "listo" cuando el
   * domiciliario llega, así que nada más en esta pantalla cambia para que
   * `PickupHandoff` sepa que debe volver a pedir el código.
   */
  const [handoffTick, setHandoffTick] = useState(0);

  // Antes se traían los últimos 100 pedidos de CUALQUIER estado
  // (entregados, cancelados, activos, todo mezclado) y se filtraba
  // aquí con `isActive`. Un negocio muy movido podía acumular más de
  // 100 pedidos recientes de cualquier estado, y un pedido activo
  // antiguo quedaba fuera de esos 100 sin que nadie lo notara: el
  // domiciliario nunca llegaba a verlo como pendiente. Ahora el
  // filtro de estado va en el servidor — se pide la lista de
  // estados activos tal cual, no "los últimos N para adivinar
  // cuáles siguen abiertos". El límite sigue siendo generoso, pero
  // ya es solo defensivo: la corrección real es el filtro, no el
  // tamaño de la página.
  //
  // Con react-query, volver a esta pantalla desde otra pinta al instante
  // la última cola conocida y la refresca por detrás.
  const ordersQuery = useQuery({
    queryKey: qk.activeOrders(businessId),
    enabled: !!businessId,
    queryFn: async () =>
      (await api.get(`/orders/business/${businessId}`, { params: { status: ACTIVE_STATUSES.join(','), limit: 500 } }))
        .data.data as BusinessOrder[],
  });
  const statementQuery = useQuery({
    queryKey: qk.statement(businessId),
    enabled: !!businessId,
    queryFn: async () => (await api.get(`/businesses/${businessId}/statement`)).data.data as Statement,
  });

  const orders = ordersQuery.data ?? [];
  const statement = statementQuery.data ?? null;
  const loading = !!businessId && ordersQuery.isPending;
  const loadError = ordersQuery.isError || statementQuery.isError
    ? 'No pudimos cargar los pedidos del negocio.'
    : '';

  const load = useCallback(async () => {
    setError('');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.activeOrders(businessId) }),
      queryClient.invalidateQueries({ queryKey: qk.statement(businessId) }),
    ]);
  }, [queryClient, businessId]);

  // Varios cambios de estado seguidos (hora pico) se resuelven con una
  // sola recarga cuando se calman.
  const loadSoon = useTrailingCallback(() => { void load(); }, 1000);

  // ── Tiempo real ──
  //
  // La conexión la mantiene `RealtimeProvider`, una sola para todo el
  // panel. Aquí solo se dice qué hacer con cada aviso.

  useBusinessEvent('order:incoming', (incoming) => {
    // `businessId` llega poblado (un objeto) cuando el pedido viene entero
    // por socket, y como cadena en el resto de eventos. Comparar sin
    // normalizar dejaba fuera todos los pedidos nuevos.
    const ref = incoming?.businessId;
    const from = typeof ref === 'object' && ref !== null ? ref._id : ref;
    if (!from || String(from) !== businessId) return;
    // El interruptor del menú lateral silencia esto de verdad; antes solo
    // cambiaba su propio icono.
    if (soundEnabled) playChime();
    queryClient.setQueryData<BusinessOrder[]>(qk.activeOrders(businessId), (previous = []) =>
      // Un pedido puede llegar dos veces si el socket reconecta justo
      // después de crearse; insertarlo sin comprobar duplicaría la fila.
      previous.some((order) => order._id === incoming._id)
        ? previous
        : [incoming, ...previous]
    );
  });

  useBusinessEvent('order:status:changed', loadSoon);
  useBusinessEvent('order:driver:assigned', loadSoon);
  useBusinessEvent('order:driver:arrived', () => setHandoffTick((tick) => tick + 1));

  const updateStatus = async (orderId: string, status: string, cancellationReason?: string) => {
    try {
      setError('');
      setBusyOrderId(orderId);
      await api.patch(`/orders/${orderId}/status`, { status, cancellationReason });
      await load();
    } catch (err) {
      // El mensaje del servidor es el que explica de verdad qué pasó
      // ("este pedido es de pago en línea y aún no está pagado"), así que
      // se muestra tal cual en vez de un error genérico.
      setError(apiMessage(err, 'No pudimos actualizar el pedido.'));
    } finally {
      setBusyOrderId(null);
    }
  };

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

  const queue = orders.filter((order) => isActive(order.status));
  const readyCount = queue.filter((order) => order.status === 'ready').length;
  const week = statement?.weeks?.[0];
  const next = statement?.nextSettlement;

  const kpis = [
    {
      title: 'Comandas activas',
      value: String(queue.length),
      detail: `${readyCount} listas para recoger`,
      Illustration: PrepTimeIllustration,
    },
    {
      title: 'Ventas de la semana',
      value: money(week?.productSubtotal),
      detail: `${week?.orderCount ?? 0} pedido(s) facturados`,
      Illustration: CashIllustration,
    },
    {
      title: 'Neto de la semana',
      value: money(week?.netAmount),
      detail: 'Descontada la comisión ZIPP',
      Illustration: PackageIllustration,
    },
    {
      title: 'Próxima liquidación',
      value: money(next?.netAmount),
      detail: `${next?.orderCount ?? 0} venta(s) acumuladas`,
      Illustration: WalletIllustration,
    },
  ];

  return (
    <div className="space-y-7 animate-fade-in">
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`w-2 h-2 rounded-full ${
                connected
                  ? 'bg-[var(--color-success)] animate-pulse'
                  : 'bg-[var(--color-text-muted)]'
              }`}
            />
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary)]">
              {connected ? 'Conectado en vivo' : 'Sin conexión en vivo'}
            </span>
          </div>
          <h1 className="page-title">{selectedBusiness.name}</h1>
          <p className="page-subtitle">Comandas, cocina y ventas del día</p>
        </div>

        <button
          onClick={load}
          className="px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-semibold text-[var(--color-text-main)] transition-colors cursor-pointer flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5 text-[var(--color-primary)]" />
          Refrescar
        </button>
      </div>

      {(error || loadError) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] p-3.5">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 text-xs font-semibold text-[var(--color-danger)]">{error || loadError}</p>
        </div>
      )}

      {/* ── Cifras ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[var(--color-border-light)] border-y border-[var(--color-border-light)]">
        {kpis.map((kpi) => (
          <div key={kpi.title} className="py-4 px-1 sm:px-5 flex items-start justify-between gap-3">
            <span className="w-11 h-11 shrink-0 rounded-xl bg-[var(--color-bg)] flex items-center justify-center">
              <kpi.Illustration size={34} />
            </span>
            <div className="text-right min-w-0">
              <p className="text-xs font-semibold text-[var(--color-text-secondary)]">{kpi.title}</p>
              {loading ? (
                <span className="block h-7 w-24 ml-auto mt-1 rounded bg-[var(--color-bg-alt)] animate-pulse" />
              ) : (
                <p className="kpi-value text-2xl mt-0.5 truncate">{kpi.value}</p>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{kpi.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Liquidación ── */}
      <section>
        <h2 className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--color-text-main)] border-b border-[var(--color-border-light)] pb-2.5">
          <span>Tu próxima liquidación</span>
          <Link
            to="/settlements"
            className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline flex items-center gap-1"
          >
            Ver el detalle <ArrowUpRight className="w-3 h-3" />
          </Link>
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10">
          <dl className="divide-y divide-[var(--color-border-light)]">
            <MoneyRow label="Venta de productos" value={money(next?.productSubtotal)} />
            {(next?.merchantFundedDiscount ?? 0) > 0 && (
              <MoneyRow
                label="Descuentos que asumes"
                value={signedMoney(-(next?.merchantFundedDiscount ?? 0))}
                tone="warning"
              />
            )}
            <MoneyRow
              label="Comisión ZIPP"
              value={signedMoney(-(next?.merchantCommission ?? 0))}
              tone="warning"
            />
            <MoneyRow label="Neto a consignar" value={money(next?.netAmount)} strong />
          </dl>

          <dl className="divide-y divide-[var(--color-border-light)]">
            <MoneyRow
              label="Pendiente por consignar"
              hint="Incluye ventas que ZIPP aún no ha cobrado"
              value={money(statement?.outstanding)}
              tone="warning"
            />
            <MoneyRow
              label="Histórico ya consignado"
              hint="Transferencias realizadas a tu cuenta"
              value={money(statement?.settled)}
            />
          </dl>
        </div>
      </section>

      {/* ── Cola de cocina ── */}
      <section className="table-container">
        <header className="px-5 py-4 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-[var(--color-text-main)]">
            Comandas activas
          </h2>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            {queue.length} en curso
          </span>
        </header>

        {loading ? (
          <p className="p-12 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
            Cargando comandas…
          </p>
        ) : queue.length === 0 ? (
          <p className="p-10 text-center text-xs font-semibold text-[var(--color-text-muted)]">
            No hay comandas activas en este momento.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-light)]">
            {queue.map((order) => {
              const style = statusStyle(order.status);
              const step = nextBusinessStep(order.status);
              const busy = busyOrderId === order._id;

              return (
                <li
                  key={order._id}
                  className="px-5 py-4 hover:bg-[var(--color-surface-hover)] transition-colors flex flex-col md:flex-row md:items-center gap-4"
                >
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="text-xs font-bold tabular text-[var(--color-primary)]">
                        {order.orderNumber ?? shortId(order._id)}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-muted)] tabular">
                        {clock(order.createdAt)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${style.chip}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        {style.label}
                      </span>
                    </div>

                    <p className="text-sm font-bold text-[var(--color-text-main)]">
                      {order.clientId?.name ?? 'Cliente'}
                    </p>
                    <p className="text-xs font-medium text-[var(--color-text-secondary)] truncate">
                      {(order.items ?? [])
                        .map((item: OrderItem) => `${item.quantity}× ${item.productName}`)
                        .join(' · ')}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 justify-between md:justify-end shrink-0">
                    <span className="kpi-value text-base tabular">{money(order.total)}</span>

                    {order.status === 'ready' ? (
                      <PickupHandoff order={order} refreshKey={handoffTick} />
                    ) : null}

                    <div className="flex items-center gap-2">
                      {order.status === 'pending' && (
                        <button
                          onClick={() => setRejecting(order)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger-bg)] border border-[var(--color-danger)]/30 hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
                        >
                          Rechazar
                        </button>
                      )}

                      {step && (
                        <button
                          onClick={() => updateStatus(order._id, step.status)}
                          disabled={busy}
                          className="px-3.5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-white bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {order.status === 'accepted' && <Play className="w-3.5 h-3.5" />}
                          {order.status === 'preparing' && <Check className="w-3.5 h-3.5" />}
                          {busy ? 'Un momento…' : step.label}
                        </button>
                      )}

                      <button
                        onClick={() => setDetailOrder(order)}
                        aria-label={`Ver el detalle del pedido ${order.orderNumber ?? ''}`}
                        className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {detailOrder && businessId && (
        <OrderDetailPanel
          order={detailOrder}
          businessId={businessId}
          refreshKey={handoffTick}
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

/**
 * Aviso sonoro del pedido nuevo.
 *
 * Envuelto porque los navegadores bloquean el audio hasta que alguien
 * interactúa con la página, y esa excepción no puede tumbar la llegada
 * del pedido: el sonido es un extra, la comanda no.
 */
function playChime() {
  try {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-84.wav');
    audio.play().catch(() => {});
  } catch {
    /* sin sonido, el pedido igual aparece */
  }
}

function MoneyRow({
  label, value, hint, tone = 'normal', strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'normal' | 'warning';
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="min-w-0">
        <span
          className={`text-xs ${
            strong
              ? 'font-bold text-[var(--color-primary)]'
              : 'font-medium text-[var(--color-text-secondary)]'
          }`}
        >
          {label}
        </span>
        {hint && (
          <span className="block text-[10px] text-[var(--color-text-muted)]">{hint}</span>
        )}
      </dt>
      <dd
        className={`kpi-value text-sm tabular shrink-0 ${
          strong
            ? 'text-[var(--color-primary)]'
            : tone === 'warning'
              ? 'text-[var(--color-warning)]'
              : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
