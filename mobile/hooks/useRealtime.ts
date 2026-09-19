import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { socketService } from '../services/socket';
import { useRealtimeStore } from '../stores/realtimeStore';
import { useMyOrders } from './useApi';
import { ACTIVE_ORDER_STATUSES } from '../constants/config';

/** Margen antes de declarar la conexión caída, en milisegundos. */
const OFFLINE_GRACE = 4000;
/** Cambios de estado que llegan juntos se resuelven con una sola recarga. */
const REFRESH_DEBOUNCE_MS = 300;
/** Tras una reconexión, se espera a que se asiente antes de recargar. */
const RECONNECT_REFRESH_MS = 1000;

/**
 * Dueño único de la conexión en vivo. Se monta **una sola vez**, en la raíz.
 *
 * Mantiene el socket abierto mientras la sesión esté activa y refresca los
 * pedidos cuando el servidor avisa de un cambio.
 *
 * Antes esto vivía en `useOrderRealtime`, que llamaban cinco pantallas a la
 * vez (las dos barras de pestañas, Pedidos, Seguimiento y el pedido del
 * domiciliario): cada una registraba sus propios oyentes, así que un solo
 * cambio de estado disparaba dos o tres recargas de la misma lista. Y en
 * cada conexión —también la primera, al abrir la app— se tiraba la lista de
 * pedidos que el Inicio acababa de descargar.
 *
 * Ahora la primera conexión no recarga nada (lo que hay es de hace un
 * segundo); solo una **re**conexión, que sí puede haber dejado eventos por
 * el camino.
 */
export function useRealtimeOwner(enabled: boolean) {
  const queryClient = useQueryClient();
  const setConnected = useRealtimeStore((s) => s.setConnected);

  useEffect(() => {
    if (!enabled) return;

    socketService.connect();
    const socket = socketService.getSocket();
    if (!socket) return;

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let connectedOnce = socket.connected;

    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const refreshSoon = (delay: number) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['order'] });
      }, delay);
    };

    const onConnect = () => {
      clearGrace();
      setConnected(true);
      if (connectedOnce) refreshSoon(RECONNECT_REFRESH_MS);
      connectedOnce = true;
    };

    // Abrir la app siempre implica unos segundos de negociación, y una
    // reconexión normal tarda un par más. Avisar de inmediato haría parpadear
    // "sin conexión" en cada arranque, que es la forma más rápida de que la
    // gente deje de creerle al aviso.
    const onDisconnect = () => {
      clearGrace();
      graceTimer = setTimeout(() => setConnected(false), OFFLINE_GRACE);
    };

    const onStatusChanged = () => refreshSoon(REFRESH_DEBOUNCE_MS);

    if (!socket.connected) onDisconnect();

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('order:status:changed', onStatusChanged);

    /**
     * Antes esto se perdía: el usuario abría un PQRS, soporte respondía, y
     * no se enteraba salvo que reabriera la pantalla de solicitudes por su
     * cuenta. Va aquí y no en `requests.tsx` porque el aviso importa
     * mientras el usuario está en cualquier parte de la app, no solo
     * mirando esa pantalla.
     */
    const refreshPqrs = () => {
      queryClient.invalidateQueries({ queryKey: ['pqrs'] });
    };
    socketService.onSupportReplied(refreshPqrs);

    return () => {
      clearGrace();
      if (refreshTimer) clearTimeout(refreshTimer);
      socketService.offSupportReplied(refreshPqrs);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('order:status:changed', onStatusChanged);
    };
  }, [enabled]);
}

/**
 * Si hay canal en vivo. Lo que antes devolvía este hook, sin el trabajo:
 * la conexión la mantiene `useRealtimeOwner` en la raíz, y aquí solo se lee.
 * Así las cinco pantallas que lo usan no cambian.
 */
export function useOrderRealtime() {
  const connected = useRealtimeStore((s) => s.connected);
  return { connected };
}

/**
 * El pedido que todavía se está moviendo.
 *
 * Solo puede haber uno visible a la vez: si hay varios en curso se muestra el
 * más reciente, que es del que el cliente está pendiente.
 */
export function useActiveOrder() {
  const { data } = useMyOrders(1);
  const orders: any[] = data?.orders ?? [];

  const active = orders.filter((o) =>
    (ACTIVE_ORDER_STATUSES as readonly string[]).includes(o.status)
  );

  if (active.length === 0) return null;

  return active.reduce((newest, o) =>
    new Date(o.createdAt) > new Date(newest.createdAt) ? o : newest
  );
}

/**
 * Tiempo real del traspaso del pedido: chat, llegadas y llamadas.
 *
 * Se une a la sala del pedido mientras la pantalla está montada — el
 * servidor decide si el socket puede quedarse (ver `resolveOrderAccess`
 * en `sockets/index.ts`), así que unirse no es más que pedirlo — y la
 * abandona al salir. Es intencionalmente independiente de
 * `useOrderRealtime`: aquella vive en toda la sesión y refresca las
 * listas de pedidos; esta solo tiene sentido dentro de la pantalla de un
 * pedido concreto.
 *
 * Expone la llamada entrante como estado local en vez de un evento
 * disparado una sola vez: si la pantalla se vuelve a montar (navegación,
 * cambio de pestaña) sin que la llamada se haya cerrado, sigue
 * apareciendo — no se pierde por no haber estado escuchando el instante
 * exacto en que llegó.
 */
export function useOrderFlowRealtime(orderId: string | undefined) {
  const queryClient = useQueryClient();
  const [incomingCall, setIncomingCall] = useState<any>(null);
  /**
   * El reparto lleva varias vueltas sin encontrar a nadie.
   *
   * No se limpia solo: una vez ha pasado, la espera ya es anormal y seguir
   * diciéndolo es más honesto que hacer desaparecer el aviso. Se va cuando
   * el pedido cambia de estado y la pantalla se desmonta.
   */
  const [dispatchStalled, setDispatchStalled] = useState(false);

  useEffect(() => {
    if (!orderId) return;

    socketService.connect();
    socketService.joinOrderRoom(orderId);

    // Al cambiar de pedido, el atasco del anterior no dice nada del nuevo.
    setDispatchStalled(false);

    const refreshFlow = () => {
      queryClient.invalidateQueries({ queryKey: ['orderFlow', orderId] });
    };
    const refreshChat = () => {
      queryClient.invalidateQueries({ queryKey: ['orderChat', orderId] });
      refreshFlow();
    };
    const onIncoming = (data: any) => {
      if (data?.orderId === orderId) setIncomingCall(data.call);
    };
    const onStalled = (data: any) => {
      if (data?.orderId === orderId) setDispatchStalled(true);
    };
    const onCallSettled = (data: any) => {
      if (data?.call?.orderId === orderId) {
        setIncomingCall((current: any) => (current?.id === data.call.id ? null : current));
      }
      refreshFlow();
    };

    socketService.onDriverArrived(refreshFlow);
    socketService.onChatMessage(refreshChat);
    socketService.onChatRead(refreshChat);
    socketService.onCallIncoming(onIncoming);
    socketService.onCallAnswered(onCallSettled);
    socketService.onCallEnded(onCallSettled);
    socketService.onDispatchStalled(onStalled);

    return () => {
      socketService.leaveOrderRoom(orderId);
      socketService.offDriverArrived(refreshFlow);
      socketService.offChatMessage(refreshChat);
      socketService.offChatRead(refreshChat);
      socketService.offCallIncoming(onIncoming);
      socketService.offCallAnswered(onCallSettled);
      socketService.offCallEnded(onCallSettled);
      socketService.offDispatchStalled(onStalled);
    };
  }, [orderId]);

  return {
    incomingCall,
    clearIncomingCall: () => setIncomingCall(null),
    dispatchStalled,
  };
}

/** Avance del pedido de 0 a 1, para el trazo y la barra de progreso. */
export function orderProgress(status: string): number {
  const map: Record<string, number> = {
    pending: 0.06,
    accepted: 0.24,
    preparing: 0.42,
    ready: 0.6,
    picked_up: 0.76,
    on_way: 0.9,
    delivered: 1,
    cancelled: 0,
  };
  return map[status] ?? 0;
}
