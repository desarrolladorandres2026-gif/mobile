import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { money } from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';
import BigStats from '../components/BigStats';
import type { SummaryItem } from '../components/SummaryGrid';
import { usePermissions } from '../hooks/usePermissions';
import { CloseRegisterButton, ShiftClosingsList } from '../components/ShiftClosings';

/**
 * La portada de quien no es el dueño.
 *
 * El cierre del día (`DailySummary`) enseña neto y comisiones de ZIPP, y
 * eso es solo del propietario. Aquí cada papel ve lo suyo, con la forma que
 * decide el backend por sus permisos (`kind`): el administrador el día
 * operativo, el cajero las ventas del turno y el operador la cola de
 * pedidos. Nunca llega un campo financiero, así que no hay nada que
 * esconder en el navegador.
 */

// Espejo de backend/src/services/businessRoleSummary.service.ts
interface Queue {
  pending: number;
  preparing: number;
  ready: number;
  onTheWay: number;
}

interface OperationalDay {
  date: string;
  ordersCreated: number;
  ordersDelivered: number;
  ordersCancelled: number;
  sales: number;
  avgTicket: number;
  avgPrepMinutes: number;
  reviewsCount: number;
  avgRating: number;
  lowRatingsCount: number;
}

/** Lo que quien está en el mostrador tiene que tener presente. */
interface Attention {
  oldestPendingMinutes: number | null;
  scheduled: { today: number; next: string | null };
  unavailable: { count: number; names: string[] };
}

type RoleSummaryData =
  | {
      kind: 'operations';
      date: string;
      generatedAt: string;
      today: OperationalDay;
      baseline: OperationalDay;
      queue: Queue;
      topProducts: Array<{ productId: string; name: string; quantity: number; sales: number }>;
      cancelReasons: Array<{ reason: string; count: number }>;
    }
  | {
      kind: 'shift';
      date: string;
      generatedAt: string;
      attention: Attention;
      queue: Queue;
      ordersDelivered: number;
      ordersCancelled: number;
      sales: number;
      byPaymentMethod: Array<{ method: 'cash_on_delivery' | 'online'; orders: number; sales: number }>;
      pendingOrders: number;
      pendingSales: number;
    }
  | {
      kind: 'kitchen';
      date: string;
      generatedAt: string;
      attention: Attention;
      queue: Queue;
      ordersDelivered: number;
      ordersCancelled: number;
    };

const num = (v: number) => (v ?? 0).toLocaleString('es-CO');
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

const longDate = (dateStr: string) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
};

const TITLES: Record<RoleSummaryData['kind'], { title: string; subtitle: string }> = {
  operations: {
    title: 'Resumen del día',
    subtitle: 'Cómo va la operación hoy. Liquidaciones y neto los ve el propietario.',
  },
  shift: {
    title: 'Resumen del día',
    subtitle: 'Lo vendido hoy en productos, sin domicilio ni propina, y lo que sigue abierto.',
  },
  kitchen: {
    title: 'Hoy en cocina',
    subtitle: 'Cuántos pedidos hay en cada paso ahora mismo.',
  },
};

/** A partir de cuántos minutos un pedido nuevo sin aceptar ya es una queja en camino. */
const LATE_PENDING_MINUTES = 5;

function queueItems(queue: Queue, attention?: Attention): SummaryItem[] {
  const wait = attention?.oldestPendingMinutes;
  return [
    {
      label: 'Nuevos',
      value: num(queue.pending),
      // Dorado mientras hay nuevos; rojo cuando el más viejo ya espera demasiado.
      strong: queue.pending > 0,
      alert: wait != null && wait >= LATE_PENDING_MINUTES,
      hint: attention ? (wait == null ? 'Nada por aceptar' : `El más antiguo espera ${wait} min`) : undefined,
      to: '/orders',
    },
    { label: 'Preparando', value: num(queue.preparing), to: '/orders' },
    {
      label: 'Listos',
      value: num(queue.ready),
      hint: attention && queue.ready > 0 ? 'Esperando al domiciliario' : undefined,
      to: '/orders',
    },
    { label: 'En camino', value: num(queue.onTheWay), to: '/orders' },
  ];
}

const clockFmt = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });

/** "3:40 pm", y con el día cuando no es hoy: "mié 3:40 pm". */
function when(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? clockFmt.format(at) : `${at.toLocaleDateString('es-CO', { weekday: 'short' })} ${clockFmt.format(at)}`;
}

/** Lo que conviene tener a la vista además de la cola: programados, agotados y si el local recibe pedidos. */
function presentItems(attention: Attention, store: { isActive?: boolean; isSuspended?: boolean; reopenAt?: string | null } | null): SummaryItem[] {
  const { scheduled, unavailable } = attention;
  const shown = unavailable.names.join(', ');
  const hidden = unavailable.count - unavailable.names.length;

  let local = { value: 'Abierto', hint: 'Recibiendo pedidos', alert: false };
  if (store?.isSuspended) local = { value: 'Suspendido', hint: 'ZIPP lo suspendió: no recibe pedidos', alert: true };
  else if (store?.isActive === false) {
    local = {
      value: 'Cerrado',
      hint: store.reopenAt ? `Se abre solo a las ${clockFmt.format(new Date(store.reopenAt))}` : 'No recibe pedidos',
      alert: true,
    };
  }

  return [
    {
      label: 'Programados',
      value: scheduled.today > 0 ? `${num(scheduled.today)} hoy` : 'Ninguno hoy',
      hint: scheduled.next ? `Próximo: ${when(scheduled.next)}` : 'Nada en espera',
      to: '/scheduled',
    },
    {
      label: 'Agotados',
      value: num(unavailable.count),
      hint: unavailable.count === 0 ? 'Todo disponible' : `${shown}${hidden > 0 ? ` y ${hidden} más` : ''}`,
      alert: unavailable.count > 0,
      to: '/menu',
    },
    { label: 'Local', value: local.value, hint: local.hint, alert: local.alert },
  ];
}

/** El mismo día de la semana pasada: la referencia mínima para leer un número suelto. */
const vsLastWeek = (value: string) => `Hace una semana: ${value}`;

/** Lista en el diseño de la orden: cabecera dorada y la última columna a la derecha. */
function ListTable({ head, rows }: { head: [string, string]; rows: Array<[string, string]> }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="bg-[var(--color-primary-dark)] text-[var(--color-surface)]">
            <th className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide">{head[0]}</th>
            <th className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide">{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}>
              <td className="px-4 py-2.5">{a}</td>
              <td className="px-4 py-2.5 text-right font-bold tabular">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RoleSummary() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const { can } = usePermissions(businessId);
  const store = useAuthStore((s) => s.selectedBusiness);

  const query = useQuery({
    queryKey: qk.roleSummary(businessId),
    enabled: !!businessId,
    // La cola cambia sola durante el día; un minuto basta para una portada.
    refetchInterval: 60_000,
    queryFn: async () => (await api.get(`/businesses/${businessId}/role-summary`)).data.data as RoleSummaryData,
  });
  const data = query.data;

  if (!businessId) {
    return (
      <div className="py-20 text-center space-y-2">
        <p className="font-semibold text-[var(--color-text-main)] text-base">Sin establecimiento seleccionado</p>
        <p className="text-xs text-[var(--color-text-secondary)]">Elige un negocio en el menú lateral.</p>
      </div>
    );
  }

  const heading = data ? TITLES[data.kind] : { title: 'Resumen del día', subtitle: '' };

  return (
    <div className="flex flex-1 flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b-[3px] border-[var(--color-primary-dark)] pb-4">
        <div className="min-w-0">
          <p className="pt-1 text-xl font-bold text-[var(--color-primary-dark)]">{store?.name ?? 'Comercio'}</p>
          <div className="mt-3 flex items-center gap-3">
          {data?.kind === 'shift' && can('shift:close') && (
            <CloseRegisterButton businessId={businessId} date={data.date} />
          )}
          <button
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Actualizar"
            title="Actualizar"
            className="p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:cursor-wait"
          >
            <RefreshCw className={`w-4 h-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          </button>
          <Link
            to="/orders"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] hover:underline underline-offset-2"
          >
            Ir a Pedidos
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          </div>
        </div>
        <div className="text-right">
          <h1 className="text-3xl font-extrabold uppercase tracking-tight text-[var(--color-text-main)]">{heading.title}</h1>
          <p className="mt-1 text-sm font-semibold capitalize text-[var(--color-primary-dark)]">{data ? longDate(data.date) : 'Cargando…'}</p>
          <p className="text-xs text-[var(--color-text-secondary)]">{heading.subtitle}</p>
        </div>
      </div>

      {query.isError && (
        <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
          {apiMessage(query.error, 'No pudimos cargar el resumen.')}
        </p>
      )}

      {!data ? (
        query.isPending && <BigStats items={queueItems({ pending: 0, preparing: 0, ready: 0, onTheWay: 0 }).map((i) => ({ ...i, loading: true }))} />
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Pedidos abiertos ahora</h2>
            <BigStats items={queueItems(data.queue, data.kind === 'operations' ? undefined : data.attention)} />
          </section>

          {data.kind !== 'operations' && (
            <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
              <section>
                <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Tenlo presente</h2>
                <BigStats items={presentItems(data.attention, store)} />
              </section>

              {data.kind === 'kitchen' && (
                <section>
                  <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Cerrados hoy</h2>
                  <BigStats
                    items={[
                      { label: 'Completados', value: num(data.ordersDelivered) },
                      { label: 'Cancelados', value: num(data.ordersCancelled) },
                    ]}
                  />
                </section>
              )}

              {data.kind === 'shift' && (
                <section>
                  <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Ventas de hoy</h2>
                  <BigStats
                    items={[
                      { label: 'Vendido', value: money(data.sales), hint: plural(data.ordersDelivered, 'pedido entregado', 'pedidos entregados'), strong: true },
                      ...data.byPaymentMethod.map((row) => ({
                        label: row.method === 'cash_on_delivery' ? 'Efectivo' : 'Pago en línea',
                        value: money(row.sales),
                        hint: plural(row.orders, 'pedido', 'pedidos'),
                      })),
                      { label: 'Pendiente', value: money(data.pendingSales), hint: plural(data.pendingOrders, 'pedido abierto', 'pedidos abiertos') },
                      { label: 'Cancelados', value: num(data.ordersCancelled) },
                    ]}
                  />
                </section>
              )}
            </div>
          )}

          {data.kind === 'shift' && <ShiftClosingsList businessId={businessId} date={data.date} />}

          {data.kind === 'operations' && (
            <>
              <section>
                <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">El día</h2>
                <BigStats
                  items={[
                    { label: 'Recibidos', value: num(data.today.ordersCreated), hint: vsLastWeek(num(data.baseline.ordersCreated)) },
                    { label: 'Entregados', value: num(data.today.ordersDelivered), hint: vsLastWeek(num(data.baseline.ordersDelivered)) },
                    { label: 'Cancelados', value: num(data.today.ordersCancelled), hint: vsLastWeek(num(data.baseline.ordersCancelled)) },
                    { label: 'Ventas', value: money(data.today.sales), hint: vsLastWeek(money(data.baseline.sales)), strong: true },
                    { label: 'Ticket promedio', value: money(data.today.avgTicket), hint: vsLastWeek(money(data.baseline.avgTicket)) },
                    { label: 'Preparación', value: `${num(data.today.avgPrepMinutes)} min`, hint: vsLastWeek(`${num(data.baseline.avgPrepMinutes)} min`) },
                    {
                      label: 'Reseñas',
                      value: data.today.reviewsCount ? `${data.today.avgRating} de 5` : 'Sin reseñas',
                      hint: data.today.lowRatingsCount
                        ? plural(data.today.lowRatingsCount, 'baja', 'bajas')
                        : plural(data.today.reviewsCount, 'reseña', 'reseñas'),
                    },
                  ]}
                />
              </section>

              <div className="grid gap-8 lg:grid-cols-2">
                <section className="space-y-2">
                  <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Lo más vendido</h2>
                  {data.topProducts.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-secondary)]">Todavía no se entrega nada hoy.</p>
                  ) : (
                    <ListTable head={['Producto', 'Cant. · Ventas']} rows={data.topProducts.map((p) => [p.name, `${num(p.quantity)} · ${money(p.sales)}`])} />
                  )}
                </section>
                <section className="space-y-2">
                  <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">Motivos de cancelación</h2>
                  {data.cancelReasons.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-secondary)]">Ningún pedido cancelado hoy.</p>
                  ) : (
                    <ListTable head={['Motivo', 'Pedidos']} rows={data.cancelReasons.map((r) => [r.reason, num(r.count)])} />
                  )}
                </section>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
