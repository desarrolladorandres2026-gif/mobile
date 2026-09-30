import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { ACTIVE_STATUSES, type BusinessOrder } from '../lib/orderFlow';
import { rememberFirstSeen } from '../lib/firstSeen';
import { useBusinessEvent, useRealtime } from './realtimeContext';
import { useTrailingCallback } from './useTrailingCallback';

/**
 * Los pedidos que todavía esperan algo del comercio.
 *
 * Una sola consulta compartida: el tablero de `/orders` y la alarma global
 * (montada en el `Layout`, en todas las pantallas) leen la misma clave. Antes
 * la lista solo se mantenía al día mientras `/orders` estaba abierta; con el
 * comercio en otra pantalla, un pedido nuevo no entraba al caché.
 *
 * `pollMs` es la red de seguridad: si el socket se cae en silencio, la
 * alarma sigue enterándose. En segundo plano también, porque el panel de una
 * cocina vive en una pestaña oculta.
 */
export function useActiveOrders(businessId: string | undefined, options: { pollMs?: number } = {}) {
  const { pollMs } = options;
  return useQuery({
    queryKey: qk.activeOrders(businessId),
    enabled: !!businessId,
    refetchInterval: pollMs ?? false,
    refetchIntervalInBackground: !!pollMs,
    queryFn: async () => {
      const orders = (await api.get(`/orders/business/${businessId}`, { params: { status: ACTIVE_STATUSES.join(','), limit: 100 } }))
        .data.data as BusinessOrder[];
      rememberFirstSeen(orders, { prune: true });
      return orders;
    },
  });
}

/**
 * Mantiene al día el caché de pedidos activos a partir del socket. Se monta
 * una sola vez, en la alarma global.
 *
 * Los eventos solo refrescan la lista; quién suena lo decide el estado de la
 * lista (`lib/orderAlarm`), así que un evento perdido no deja un pedido mudo.
 */
export function useActiveOrdersLiveSync(businessId: string | undefined) {
  const queryClient = useQueryClient();
  const { epoch } = useRealtime();

  const refresh = useTrailingCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.activeOrders(businessId) });
  }, 1000);

  const patch = (update: (orders: BusinessOrder[]) => BusinessOrder[]) =>
    queryClient.setQueryData<BusinessOrder[]>(qk.activeOrders(businessId), (previous) =>
      previous ? update(previous) : previous
    );

  useBusinessEvent('order:incoming', (incoming) => {
    // `businessId` llega poblado (un objeto) cuando el pedido viene entero
    // por socket, y como cadena en el resto de eventos. Comparar sin
    // normalizar dejaba fuera todos los pedidos nuevos.
    const ref = incoming?.businessId;
    const from = typeof ref === 'object' && ref !== null ? ref._id : ref;
    if (!incoming?._id || !from || String(from) !== businessId) return;
    rememberFirstSeen([incoming]);
    queryClient.setQueryData<BusinessOrder[]>(qk.activeOrders(businessId), (previous = []) =>
      // Puede llegar dos veces (reconexión justo después de crearse, o el
      // pago aprobado tras un cambio de método): no duplicar la fila.
      previous.some((order) => order._id === incoming._id) ? previous : [incoming, ...previous]
    );
  });

  // El estado se corrige en el acto para que el timbre calle sin esperar a
  // la consulta; la consulta llega después y confirma.
  useBusinessEvent('order:status:changed', (changed) => {
    if (changed.businessId && changed.businessId !== businessId) return;
    patch((orders) => orders.map((order) => (order._id === changed.orderId ? { ...order, status: changed.status } : order)));
    refresh();
  });
  useBusinessEvent('order:driver:assigned', (assigned) => {
    if (assigned.businessId && assigned.businessId !== businessId) return;
    refresh();
  });
  useBusinessEvent('order:withdrawn', (withdrawn) => {
    if (withdrawn.businessId !== businessId) return;
    patch((orders) => orders.filter((order) => order._id !== withdrawn.orderId));
  });

  // El servidor no reenvía lo que pasó mientras el socket estaba caído: al
  // volver hay que leer la lista entera.
  useEffect(() => {
    if (epoch > 0) void queryClient.invalidateQueries({ queryKey: qk.activeOrders(businessId) });
  }, [epoch, businessId, queryClient]);
}
