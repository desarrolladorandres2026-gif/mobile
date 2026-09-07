import { createContext, useContext, useEffect, useRef } from 'react';
import type { BusinessOrder, OrderStatus } from '../lib/orderFlow';

/**
 * Una sola conexión en vivo para todo el panel.
 *
 * Antes el socket lo abría `Dashboard.tsx` por su cuenta, así que
 * "Pedidos" y cualquier pantalla futura no se enteraban de nada y tenían
 * que refrescar a mano. Dos pantallas abriendo cada una su conexión
 * tampoco era la salida: el backend une el socket a las salas del
 * comercio al conectar, y duplicar conexiones duplica cada evento.
 *
 * El registro de oyentes vive en un `ref` a propósito. Si las
 * suscripciones formaran parte de las dependencias del efecto que crea el
 * socket, montar un componente que escucha reconectaría el socket entero
 * —y una reconexión pierde los eventos que llegan mientras tanto.
 */

/** Lo que el comercio necesita saber en el momento en que pasa. */
export type BusinessEvent =
  | 'order:incoming'
  | 'order:status:changed'
  | 'order:driver:assigned'
  | 'order:driver:arrived';

export const EVENTS: BusinessEvent[] = [
  'order:incoming',
  'order:status:changed',
  'order:driver:assigned',
  'order:driver:arrived',
];

/**
 * Lo que manda el servidor con cada aviso, evento por evento.
 *
 * No es el mismo objeto en los cuatro: `order:incoming` viaja con el
 * pedido entero (`OrderService.getById`, con `businessId` poblado) y los
 * otros tres con una ficha corta. Un único tipo para todos —o peor, `any`,
 * que es lo que había— dejaba que el dashboard metiera en su lista de
 * pedidos un objeto que solo trae `orderId` y `stage`, y esa fila se
 * pintaba luego con `undefined` en el total y en el estado.
 *
 * Los `orderId` de las fichas cortas son cadenas, no `_id`: el backend
 * los serializa así a propósito y el nombre distinto lo delata.
 */
export interface IncomingOrderPayload extends BusinessOrder {
  businessId?: string | { _id?: string } | null;
}

export interface OrderStatusPayload {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  driverId?: string;
  cancellationReason?: string;
}

export interface DriverArrivedPayload {
  orderId: string;
  orderNumber: string;
  stage: 'pickup' | 'delivery';
  arrivedAt: string;
}

export interface BusinessEventPayloads {
  'order:incoming': IncomingOrderPayload;
  'order:status:changed': OrderStatusPayload;
  'order:driver:assigned': OrderStatusPayload;
  'order:driver:arrived': DriverArrivedPayload;
}

export type AnyPayload = BusinessEventPayloads[BusinessEvent];
export type Handler = (payload: AnyPayload) => void;
export type Registry = Map<BusinessEvent, Set<Handler>>;

export interface RealtimeValue {
  connected: boolean;
  subscribe: <E extends BusinessEvent>(
    event: E,
    handler: (payload: BusinessEventPayloads[E]) => void
  ) => () => void;
}

export const RealtimeContext = createContext<RealtimeValue>({
  connected: false,
  subscribe: () => () => {},
});


export const useRealtime = () => useContext(RealtimeContext);

/**
 * Escucha uno de los eventos del comercio.
 *
 * El manejador se guarda en un `ref` y se vuelve a leer en cada aviso, de
 * modo que una función nueva en cada render —lo normal— no des-suscribe y
 * re-suscribe sin parar.
 */
export function useBusinessEvent<E extends BusinessEvent>(
  event: E,
  handler: (payload: BusinessEventPayloads[E]) => void
) {
  const { subscribe } = useRealtime();
  const saved = useRef(handler);

  // La escritura del `ref` va en su propio efecto: tocarlo durante el
  // render rompe el render concurrente, porque React puede repetir o
  // abandonar ese render y el `ref` no se desharía con él.
  useEffect(() => { saved.current = handler; }, [handler]);

  useEffect(
    () => subscribe(event, (payload) => saved.current(payload)),
    [event, subscribe]
  );
}
