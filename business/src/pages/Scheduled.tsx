import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, MapPin, RefreshCw, Store } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { clock, money, orderTag, type BusinessOrder } from '../lib/orderFlow';
import { scheduledTone, untilLabel } from '../lib/scheduledOrders';

/**
 * Pedidos programados: los que ya están pagados o confirmados pero esperan su
 * hora. La cocina no los ve hasta que faltan unos minutos (ver
 * `activateScheduledOrders` en el backend), así que sin esta lista el comercio
 * no tenía forma de saber qué le viene mañana. Es solo lectura: al llegar la
 * hora pasan solos a Pedidos, donde se aceptan como cualquier otro.
 *
 * Cada pedido es una tarjeta (la misma superficie que Promociones y Publicidad,
 * ver `.promo-card` en `index.css`) con la hora grande y cuánto falta; la franja
 * superior se calienta a medida que se acerca. Son de solo lectura, así que no
 * levantan al pasar el cursor.
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
  // «Ahora» es la última lectura (se refresca cada minuto): mantiene el render puro.
  const now = query.dataUpdatedAt;

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
        <section key={group.label} aria-label={group.label} className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            {group.label} <span className="tabular font-normal">· {group.orders.length}</span>
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.orders.map((order, i) => {
              const msUntil = new Date(order.scheduledFor).getTime() - now;
              const tone = scheduledTone(msUntil);
              return (
                <li
                  key={order._id}
                  className="promo-card"
                  data-static
                  data-tone={tone}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-3xl font-semibold leading-none tabular text-[var(--color-text-main)]">
                        {clock(order.scheduledFor)}
                      </p>
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">
                        <Clock className="h-3.5 w-3.5" />
                        {untilLabel(msUntil)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular text-[var(--color-text-main)]">{money(order.total)}</p>
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {order.paymentMethod === 'cash_on_delivery' ? 'Efectivo' : 'Pagado en línea'}
                      </p>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-1.5 border-t border-[var(--color-border)] pt-3">
                    <p className="truncate text-sm font-semibold text-[var(--color-text-main)]">
                      {order.clientId?.name ?? 'Cliente'}
                      <span className="ml-2 text-xs font-normal tabular text-[var(--color-text-secondary)]">
                        {orderTag(order)}
                      </span>
                    </p>
                    <ul className="space-y-0.5">
                      {order.items.map((item, k) => (
                        <li key={k} className="text-xs text-[var(--color-text-main)]">
                          <span className="tabular font-semibold">{item.quantity}×</span> {item.productName}
                        </li>
                      ))}
                    </ul>
                    {order.deliveryAddress && (
                      <p className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-words">{order.deliveryAddress}</span>
                      </p>
                    )}
                    {order.notes && (
                      <p className="text-xs text-[var(--color-text-secondary)]">Nota: {order.notes}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
