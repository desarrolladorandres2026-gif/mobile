import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { socketService } from '../services/socket';
import { useAuthStore } from '../stores/authStore';
import { useMyOrders } from './useApi';
import { ACTIVE_ORDER_STATUSES } from '../constants/config';

/**
 * Conexión en vivo con el servidor.
 *
 * Mantiene el socket abierto mientras la sesión esté activa y refresca los
 * pedidos cuando el servidor avisa de un cambio. Devuelve si hay conexión,
 * que es lo que alimenta la banda de "sin conexión": en una app donde el
 * pedido cambia solo, saber que dejaste de recibir novedades importa tanto
 * como las novedades.
 */
/** Margen antes de declarar la conexión caída, en milisegundos. */
const OFFLINE_GRACE = 4000;

export function useOrderRealtime() {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [connected, setConnected] = useState(true);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    socketService.connect();
    const socket = socketService.getSocket();
    if (!socket) return;

    const clearGrace = () => {
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };

    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order'] });
    };

    const onConnect = () => {
      clearGrace();
      setConnected(true);
      refresh();
    };

    // Abrir la app siempre implica unos segundos de negociación, y una
    // reconexión normal tarda un par más. Avisar de inmediato haría parpadear
    // "sin conexión" en cada arranque, que es la forma más rápida de que la
    // gente deje de creerle al aviso.
    const onDisconnect = () => {
      clearGrace();
      graceTimer.current = setTimeout(() => setConnected(false), OFFLINE_GRACE);
    };

    if (!socket.connected) onDisconnect();

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('order:status:changed', refresh);

    return () => {
      clearGrace();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('order:status:changed', refresh);
    };
  }, [isAuthenticated]);

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
