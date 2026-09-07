import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';
import {
  EVENTS, RealtimeContext,
  type AnyPayload, type Handler, type Registry, type RealtimeValue,
} from './realtimeContext';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

/**
 * El proveedor, solo. Los tipos, el contexto y los hooks viven en
 * `realtimeContext.ts`: Fast Refresh deja de funcionar en un archivo que
 * mezcla componentes con otras exportaciones, y perder el recambio en
 * caliente justo en el archivo del socket es especialmente caro — cada
 * edición obligaba a recargar la página entera y volver a autenticarse.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const [connected, setConnected] = useState(false);
  const registry = useRef<Registry>(new Map());

  const value = useMemo<RealtimeValue>(
    () => ({
      connected,
      subscribe: (event, handler) => {
        const handlers = registry.current.get(event) ?? new Set<Handler>();
        // El registro guarda oyentes de los cuatro eventos en la misma
        // estructura, así que su tipo tiene que ser la union de los cuatro
        // payloads. El estrechamiento real lo hace la clave del mapa: un
        // oyente registrado bajo `order:incoming` solo recibe lo que llega
        // por `order:incoming`. Es la única conversión del módulo y está
        // aquí, en la frontera, y no en cada pantalla.
        handlers.add(handler as Handler);
        registry.current.set(event, handlers);
        return () => { handlers.delete(handler as Handler); };
      },
    }),
    [connected]
  );

  useEffect(() => {
    if (!token) { setConnected(false); return; }

    const socket: Socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    for (const event of EVENTS) {
      socket.on(event, (payload: AnyPayload) => {
        registry.current.get(event)?.forEach((handler) => {
          // Un oyente que falla no puede llevarse por delante a los
          // demás: son pantallas distintas escuchando el mismo hecho.
          try { handler(payload); } catch (err) { console.error(err); }
        });
      });
    }

    return () => { socket.disconnect(); };
  }, [token]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
