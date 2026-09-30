import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';
import { endSession, ensureFreshToken, freshestToken, SessionEndedError, startSessionKeeper } from '../lib/session';
import {
  EVENTS, RealtimeContext,
  type AnyPayload, type ConnectionStatus, type Handler, type Registry, type RealtimeValue,
} from './realtimeContext';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

/** Espera entre reintentos: 1 s, 2 s, 4 s… con tope de 30 s y algo de azar. */
const backoff = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);

/**
 * El proveedor, solo. Los tipos, el contexto y los hooks viven en
 * `realtimeContext.ts`: Fast Refresh deja de funcionar en un archivo que
 * mezcla componentes con otras exportaciones, y perder el recambio en
 * caliente justo en el archivo del socket es especialmente caro — cada
 * edición obligaba a recargar la página entera y volver a autenticarse.
 *
 * Por qué el socket ya no depende del token: el servidor corta la conexión
 * en el instante en que caduca el access token (15 min) y socket.io **no**
 * reintenta solo tras un corte del servidor ni tras un rechazo del
 * handshake. Con el efecto atado a `[token]`, un panel sin tráfico REST
 * quedaba sordo hasta que alguien tocara algo. Ahora la sesión la renueva
 * `lib/session.ts`, el handshake pide siempre el token más fresco, y este
 * archivo se encarga de volver a conectar.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const hasSession = useAuthStore((s) => !!s.token);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [downSince, setDownSince] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  const registry = useRef<Registry>(new Map());

  // Estable a propósito: si cambiara con el estado de la conexión, cada
  // pantalla que escucha se des-suscribiría y volvería a suscribir.
  const subscribe = useCallback<RealtimeValue['subscribe']>((event, handler) => {
    const handlers = registry.current.get(event) ?? new Set<Handler>();
    // El registro guarda oyentes de todos los eventos en la misma
    // estructura, así que su tipo tiene que ser la union de los payloads.
    // El estrechamiento real lo hace la clave del mapa: un oyente registrado
    // bajo `order:incoming` solo recibe lo que llega por `order:incoming`.
    // Es la única conversión del módulo y está aquí, en la frontera, y no
    // en cada pantalla.
    handlers.add(handler as Handler);
    registry.current.set(event, handlers);
    return () => { handlers.delete(handler as Handler); };
  }, []);

  const value = useMemo<RealtimeValue>(
    () => ({ connected: status === 'online', status, downSince, epoch, subscribe }),
    [status, downSince, epoch, subscribe]
  );

  // Renueva el token antes de que caduque, sin esperar a una petición.
  useEffect(() => (hasSession ? startSessionKeeper() : undefined), [hasSession]);

  useEffect(() => {
    if (!hasSession) return;

    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let handshakeToken: string | null = null;

    const markUp = () => {
      attempt = 0;
      setStatus('online');
      setDownSince(null);
      setEpoch((n) => n + 1);
    };
    const markDown = () => {
      setStatus(navigator.onLine ? 'connecting' : 'offline');
      setDownSince((since) => since ?? Date.now());
    };

    const socket: Socket = io(SOCKET_URL, {
      transports: ['websocket'],
      // Una función, no un objeto: se vuelve a ejecutar en cada conexión y
      // pide el token más fresco (o lo renueva si ya caducó).
      auth: (cb) => {
        ensureFreshToken()
          .catch(() => freshestToken())
          .then((token) => { handshakeToken = token; cb({ token }); });
      },
    });

    socket.on('connect', markUp);
    socket.on('disconnect', (reason) => {
      markDown();
      // El servidor cerró la conexión (caducó el token, o la sesión cambió):
      // socket.io no reconecta solo en ese caso. Se hace aquí, dentro del
      // propio evento y no en un temporizador, porque el navegador frena los
      // temporizadores de una pestaña en segundo plano.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', async (err) => {
      markDown();
      // Un fallo de transporte (sin red, servidor caído) lo reintenta el
      // propio cliente. Un rechazo del handshake, no.
      if (socket.active) return;
      // El 2FA pendiente lo resuelve la API REST llevando a /setup-2fa.
      if (err.message === 'Verificación en dos pasos requerida') return;
      try {
        await ensureFreshToken({ failedToken: handshakeToken });
      } catch (error) {
        if (error instanceof SessionEndedError) { endSession(); return; }
      }
      if (stopped) return;
      retry = setTimeout(() => socket.connect(), backoff(attempt++));
    });

    for (const event of EVENTS) {
      socket.on(event, (payload: AnyPayload) => {
        registry.current.get(event)?.forEach((handler) => {
          // Un oyente que falla no puede llevarse por delante a los
          // demás: son pantallas distintas escuchando el mismo hecho.
          try { handler(payload); } catch (err) { console.error(err); }
        });
      });
    }

    // Volver la red: no esperar al siguiente reintento del cliente.
    const onOnline = () => { if (!socket.connected && !socket.active) socket.connect(); };
    const onOffline = () => markDown();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      stopped = true;
      clearTimeout(retry);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      socket.disconnect();
    };
  }, [hasSession]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
