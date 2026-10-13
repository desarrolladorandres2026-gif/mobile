import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Store } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { clock, money, orderTag, type BusinessOrder } from '../lib/orderFlow';

/**
 * Pedidos programados: los que ya están pagados o confirmados pero esperan su
 * hora. La cocina no los ve hasta que faltan unos minutos (ver
 * `activateScheduledOrders` en el backend), así que sin esta lista el comercio
 * no tenía forma de saber qué le viene mañana. Es solo lectura: al llegar la
 * hora pasan solos a Pedidos, donde se aceptan como cualquier otro.
 */

type ScheduledOrder = BusinessOrder & { scheduledFor: string };

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function dayLabel(date: Date, today: Date): string {
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (dayKey(date) === dayKey(today)) return 'Hoy';
  if (dayKey(date) === dayKey(tomorrow)) return 'Mañana';
  const label = date.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function Scheduled() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  // Fijado al montar: leer el reloj en el render no es puro. La lista se refresca sola cada minuto.
  const [today] = useState(() => new Date());

  const query = useQuery({
    queryKey: qk.scheduled(businessId),
    enabled: !!businessId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data } = await api.get(`/orders/business/${businessId}/scheduled`);
      return (data.data ?? []) as ScheduledOrder[];
    },
  });

  const groups = useMemo(() => {
    const byDay = new Map<string, { label: string; orders: ScheduledOrder[] }>();
    for (const order of query.data ?? []) {
      const at = new Date(order.scheduledFor);
      const key = dayKey(at);
      if (!byDay.has(key)) byDay.set(key, { label: dayLabel(at, today), orders: [] });
      byDay.get(key)!.orders.push(order);
    }
    return [...byDay.values()];
  }, [query.data, today]);

  if (!businessId) {
    return (
      <div className="py-20 text-center space-y-2">
        <Store className="w-8 h-8 text-[var(--color-primary)] mx-auto" />
        <p className="font-semibold text-[var(--color-text-main)] text-base">Sin establecimiento seleccionado</p>
        <p className="text-xs text-[var(--color-text-secondary)]">Elige un negocio en el menú lateral.</p>
      </div>
    );
  }

  const total = query.data?.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Programados</h1>
          <p className="page-subtitle">
            Pedidos que esperan su hora. Pasan solos a Pedidos poco antes de la entrega.
          </p>
        </div>
        <button
          onClick={() => query.refetch()}
          className="h-8 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium text-[var(--color-text-main)] cursor-pointer flex items-center justify-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-[var(--color-text-secondary)] ${query.isFetching ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      {query.isError && (
        <p role="alert" className="border-l-2 border-[var(--color-danger)] pl-3 text-xs font-semibold text-[var(--color-danger)]">
          {apiMessage(query.error, 'No se pudieron cargar los pedidos programados.')}
        </p>
      )}

      {query.isPending && (
        <div className="flex justify-center py-16">
          <RefreshCw className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
        </div>
      )}

      {!query.isPending && !query.isError && total === 0 && (
        <div className="py-16 text-center space-y-1">
          <p className="text-sm font-semibold text-[var(--color-text-main)]">No tienes pedidos programados</p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Cuando un cliente programe un pedido para más tarde, lo verás aquí con su hora de entrega.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.label} aria-label={group.label} className="space-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            {group.label} <span className="tabular font-normal">· {group.orders.length}</span>
          </h2>
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {group.orders.map((order) => (
              <li key={order._id} className="flex items-start gap-4 py-3">
                <p className="w-20 shrink-0 text-lg font-semibold tabular text-[var(--color-text-main)]">
                  {clock(order.scheduledFor)}
                </p>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                    {order.clientId?.name ?? 'Cliente'}
                    <span className="ml-2 text-xs font-normal text-[var(--color-text-secondary)] tabular">
                      {orderTag(order)}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--color-text-main)]">
                    {order.items.map((item) => `${item.quantity}× ${item.productName}`).join(', ')}
                  </p>
                  {order.deliveryAddress && (
                    <p className="text-xs text-[var(--color-text-secondary)] truncate">{order.deliveryAddress}</p>
                  )}
                  {order.notes && (
                    <p className="text-xs text-[var(--color-text-secondary)]">Nota: {order.notes}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular text-[var(--color-text-main)]">{money(order.total)}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {order.paymentMethod === 'cash_on_delivery' ? 'Efectivo' : 'Pagado en línea'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
