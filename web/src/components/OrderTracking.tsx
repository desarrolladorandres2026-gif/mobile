import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/http';
import type { Order } from '../lib/commerceApi';
import { connectSocket } from '../lib/socket';
import { isActiveStatus } from '../lib/orderStatus';

const OrderMap = lazy(() => import('./OrderMap'));

/** Estados en los que hay un repartidor que seguir en el mapa. */
const TRACKABLE = ['ready', 'picked_up', 'on_way'];

interface MapConfig { accessToken: string; enabled: boolean; style: string }
interface Point { lat: number; lng: number }
interface TrackingData {
  business?: { name?: string; location?: Point };
  destination?: { address?: string; location?: Point };
  driver?: { location?: Point; stale?: boolean };
  route?: { source?: string; geometry?: { type: 'LineString'; coordinates: [number, number][] } };
  etaSeconds?: number | null;
}

/** "8 min", "1 h 5 min". Null cuando no hay estimación que mostrar. */
function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Seguimiento en vivo de un pedido. Quien lo use debe darle `key={order._id}`: así, al cambiar de
 * pedido, la posición en vivo del anterior no se arrastra.
 *
 * Dos fuentes con papeles distintos: el socket avisa los cambios de estado y
 * la posición del repartidor apenas ocurren; la consulta REST trae la foto
 * completa (ruta, ETA) y sirve de respaldo si el socket no conecta. La
 * posición del socket pisa a la de REST porque es más nueva.
 */
export function OrderTracking({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const orderId = order._id;
  const active = isActiveStatus(order.status);
  const trackable = TRACKABLE.includes(order.status);
  const [arrived, setArrived] = useState(false);
  const [live, setLive] = useState<Point | null>(null);

  const driverUser = (order as unknown as { driverId?: { userId?: { _id?: string } | string } }).driverId?.userId;
  const driverUserId = typeof driverUser === 'string' ? driverUser : driverUser?._id ?? null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    connectSocket().then((socket) => {
      if (cancelled) return;
      const join = () => {
        socket.emit('order:join', orderId);
        if (driverUserId) socket.emit('track:driver', driverUserId);
      };
      const refresh = (payload?: { orderId?: string | null }) => {
        if (payload?.orderId && payload.orderId !== orderId) return;
        void queryClient.invalidateQueries({ queryKey: ['order', orderId] });
        void queryClient.invalidateQueries({ queryKey: ['orders', 'mine'] });
      };
      const onArrived = (payload?: { orderId?: string }) => {
        if (payload?.orderId && payload.orderId !== orderId) return;
        setArrived(true);
        refresh(payload);
      };
      const onLocation = (payload?: { orderId?: string; location?: Point }) => {
        // Un socket puede estar en varias salas: no se dibuja al repartidor de otro pedido.
        if (payload?.orderId && payload.orderId !== orderId) return;
        if (payload?.location) setLive({ lat: payload.location.lat, lng: payload.location.lng });
      };

      // `connect` se repite en cada reconexión: hay que volver a entrar a las salas.
      socket.on('connect', join);
      if (socket.connected) join();
      socket.on('order:status:changed', refresh);
      socket.on('payment:updated', refresh);
      socket.on('order:driver:arrived', onArrived);
      socket.on('driver:location:update', onLocation);

      cleanup = () => {
        socket.off('connect', join);
        socket.off('order:status:changed', refresh);
        socket.off('payment:updated', refresh);
        socket.off('order:driver:arrived', onArrived);
        socket.off('driver:location:update', onLocation);
        if (driverUserId) socket.emit('untrack:driver', driverUserId);
      };
    }).catch(() => {
      // Sin socket el pedido igual se actualiza por la consulta periódica.
    });

    return () => { cancelled = true; cleanup?.(); };
  }, [active, orderId, driverUserId, queryClient]);

  const tracking = useQuery({
    queryKey: ['tracking', orderId],
    queryFn: () => api<TrackingData>(`/tracking/orders/${encodeURIComponent(orderId)}?trail=true`, { auth: true }),
    enabled: trackable,
    refetchInterval: trackable ? 60_000 : false,
    retry: false,
  });
  const mapConfig = useQuery({
    queryKey: ['map-config'],
    queryFn: () => api<MapConfig>('/tracking/config', { auth: true }),
    enabled: trackable,
    staleTime: Infinity,
    retry: false,
  });

  const data = tracking.data;
  const driverPoint = useMemo<(Point & { stale?: boolean }) | null>(() => {
    if (live) return live;
    if (data?.driver?.location) return { ...data.driver.location, stale: data.driver.stale };
    return null;
  }, [live, data]);

  if (!trackable) return arrived ? <p className="mt-6 border-t border-border pt-6 text-base font-semibold text-text-main">Tu domiciliario llegó.</p> : null;

  const eta = formatEta(data?.etaSeconds);
  const config = mapConfig.data;
  const canMap = Boolean(config?.enabled && config.accessToken);

  return (
    <section className="mt-6 border-t border-border pt-6" aria-labelledby="h-seguimiento">
      <h2 id="h-seguimiento" className="text-xl font-semibold text-text-main">Seguimiento</h2>
      {arrived && <p className="mt-2 text-base font-semibold text-text-main">Tu domiciliario llegó.</p>}
      {eta && (
        <p className="mt-2 text-base text-text-main">
          Llega en unos {eta}
          {data?.route?.source !== 'mapbox' ? ' (estimado)' : ''}.
        </p>
      )}
      {driverPoint?.stale && (
        <p className="mt-1 text-sm text-text-secondary">Perdimos la señal del repartidor por un momento. Seguimos buscándolo.</p>
      )}
      <div className="mt-4">
        {canMap ? (
          <Suspense fallback={<p className="text-base text-text-secondary">Cargando el mapa…</p>}>
            <OrderMap
              token={config!.accessToken}
              style={config!.style}
              business={data?.business?.location ? { ...data.business.location, label: data.business.name } : null}
              destination={data?.destination?.location ? { ...data.destination.location, label: data.destination.address } : null}
              driver={driverPoint}
              route={data?.route?.geometry ?? null}
            />
          </Suspense>
        ) : mapConfig.isPending || tracking.isPending ? (
          <p className="text-base text-text-secondary">Buscando a tu domiciliario…</p>
        ) : (
          <p className="text-base text-text-secondary">El mapa no está disponible ahora. El estado de tu pedido se sigue actualizando aquí.</p>
        )}
      </div>
    </section>
  );
}
