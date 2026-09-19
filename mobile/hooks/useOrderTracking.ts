import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../services/endpoints';
import { socketService } from '../services/socket';
import { pollInterval } from '../stores/realtimeStore';
import type { MapMarker, MapPoint, MapRoute } from '../lib/mapbox';

/** Estados en los que hay algo que seguir en el mapa. */
const TRACKABLE = ['ready', 'picked_up', 'on_way'];

export interface LivePosition extends MapPoint {
  heading: number | null;
  speed: number | null;
  at: number;
}

/**
 * Seguimiento de un pedido en el mapa, para el cliente.
 *
 * Combina dos fuentes con papeles distintos y complementarios:
 *
 * - **REST** (`trackingApi.getOrder`) — la foto completa: ruta, ETA,
 *   negocio, destino y rastro. Cara de calcular, así que se pide al abrir
 *   y luego cada tanto.
 * - **Socket** (`driver:location:update`) — solo la posición, según llega.
 *   Barata y frecuente.
 *
 * La posición del socket **pisa** la del REST porque es más nueva. Sin
 * eso, cada refresco periódico devolvería al repartidor a donde estaba
 * cuando se calculó la ruta y el punto daría un salto atrás cada 45
 * segundos — un error que se ve rarísimo y cuesta mucho diagnosticar.
 */
export function useOrderTracking(order: { _id?: string; status?: string; driverId?: any } | null) {
  const orderId = order?._id;
  const trackable = !!order?.status && TRACKABLE.includes(order.status);
  const driverUserId = order?.driverId?.userId?._id ?? order?.driverId?.userId ?? null;

  const [live, setLive] = useState<LivePosition | null>(null);
  const lastOrderRef = useRef<string | undefined>(undefined);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['tracking', orderId],
    queryFn: () => trackingApi.getOrder(orderId!, true),
    enabled: !!orderId && trackable,
    // La ruta y el ETA se recalculan desde donde está el repartidor, así
    // que caducan con el movimiento. 45 s es el punto donde el ETA sigue
    // siendo creíble sin convertir cada pantalla abierta en una petición
    // a Mapbox cada pocos segundos.
    //
    // Con el socket conectado la posición llega en vivo y la ruta solo
    // necesita refrescarse de vez en cuando: 90 s.
    refetchInterval: trackable ? () => pollInterval(90_000, 45_000) : false,
  });

  // Al cambiar de pedido, la posición en vivo del anterior deja de tener
  // sentido. Sin esto, abrir un pedido nuevo mostraría por un instante al
  // repartidor del pedido anterior sobre el mapa del nuevo.
  useEffect(() => {
    if (lastOrderRef.current !== orderId) {
      setLive(null);
      lastOrderRef.current = orderId;
    }
  }, [orderId]);

  useEffect(() => {
    if (!orderId || !trackable) return;

    socketService.connect();
    // La sala del pedido ya la abre `useOrderFlowRealtime`; suscribirse
    // además al repartidor cubre el caso de que la pantalla se use sin
    // aquel hook. El servidor valida las dos por separado, así que pedir
    // de más no concede nada de más.
    if (driverUserId) socketService.trackDriver(driverUserId);

    const onLocation = (payload: any) => {
      // Un socket puede estar en varias salas: el panel de un comercio con
      // dos pedidos en curso recibe los dos. Sin este filtro, la pantalla
      // de un pedido dibujaría al repartidor del otro.
      if (payload?.orderId && payload.orderId !== orderId) return;
      if (!payload?.location) return;

      setLive({
        lat: payload.location.lat,
        lng: payload.location.lng,
        heading: payload.heading ?? null,
        speed: payload.speed ?? null,
        at: Date.now(),
      });
    };

    socketService.onDriverLocationUpdate(onLocation);

    return () => {
      socketService.offDriverLocationUpdate(onLocation);
      if (driverUserId) socketService.untrackDriver(driverUserId);
    };
  }, [orderId, trackable, driverUserId]);

  const driverPosition: LivePosition | null = useMemo(() => {
    if (live) return live;
    if (!data?.driver?.location) return null;
    return {
      ...data.driver.location,
      heading: data.driver.heading ?? null,
      speed: data.driver.speed ?? null,
      at: data.driver.lastSeenAt ? new Date(data.driver.lastSeenAt).getTime() : 0,
    };
  }, [live, data]);

  /** Marcadores listos para el mapa, en el orden en que deben pintarse. */
  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = [];

    if (data?.business?.location) {
      list.push({
        id: 'business',
        kind: 'business',
        ...data.business.location,
        label: data.business.name,
      });
    }

    if (data?.destination?.location) {
      list.push({
        id: 'destination',
        kind: 'client',
        ...data.destination.location,
        label: data.destination.address,
      });
    }

    if (driverPosition) {
      list.push({
        id: 'driver',
        kind: 'driver',
        lat: driverPosition.lat,
        lng: driverPosition.lng,
        heading: driverPosition.heading,
        stale: data?.driver?.stale ?? false,
      });
    }

    return list;
  }, [data, driverPosition]);

  return {
    tracking: data ?? null,
    markers,
    route: (data?.route?.geometry ?? null) as MapRoute | null,
    trail: (data?.trail ?? null) as MapPoint[] | null,
    driverPosition,
    /** Segundos hasta la entrega. Null si no se puede estimar. */
    etaSeconds: data?.etaSeconds ?? null,
    /** `true` cuando el ETA viene de Mapbox y no de una estimación geométrica. */
    etaIsPrecise: data?.route?.source === 'mapbox',
    trackable,
    isLoading,
    refetch,
  };
}

/** "8 min", "1 h 5 min". Null cuando no hay estimación que mostrar. */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;

  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
