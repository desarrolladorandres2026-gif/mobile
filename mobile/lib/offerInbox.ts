import type { OrderOffer } from '../services/socket';

/**
 * Las ofertas que llegan por notificación, no por socket.
 *
 * `OfferSheet` escucha el evento `order:offer` del socket, y eso cubre el
 * caso fácil: la app abierta y delante. El caso que de verdad importa es el
 * otro — el teléfono bloqueado en el bolsillo mientras se conduce—, y ahí
 * no hay socket vivo que entregue nada: solo llega la push.
 *
 * Este módulo es el cable entre las dos cosas. La push trae la oferta
 * entera (ver `notifyOffer` en `backend/src/services/dispatch.service.ts`),
 * así que la hoja se puede levantar tal cual sin preguntarle nada al
 * servidor — que es lo correcto cuando quedan veinte segundos de reloj.
 *
 * Guarda una sola oferta pendiente, no una cola: si llegan dos, la buena es
 * la última. Una oferta vieja ya venció o ya se la quedó alguien.
 */

type Listener = (offer: OrderOffer) => void;

const listeners = new Set<Listener>();

/**
 * La oferta que llegó antes de que hubiera nadie escuchando.
 *
 * Es el caso de abrir la app *desde* la notificación con la app cerrada:
 * `getLastNotificationResponseAsync` dispara antes de que `OfferSheet` se
 * monte, y sin este buzón la oferta se publicaría en el vacío. Justo el
 * arranque que más importa acertar.
 */
let pending: OrderOffer | null = null;

/** Convierte el `data` de una push en una oferta, o `null` si no lo es. */
export function offerFromPushData(data: unknown): OrderOffer | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'order:offer') return null;
  if (typeof d.orderId !== 'string' || typeof d.expiresAt !== 'string') return null;

  return {
    orderId: d.orderId,
    orderNumber: typeof d.orderNumber === 'string' ? d.orderNumber : '',
    businessName: typeof d.businessName === 'string' ? d.businessName : undefined,
    round: typeof d.round === 'number' ? d.round : 1,
    etaSeconds: typeof d.etaSeconds === 'number' ? d.etaSeconds : 0,
    expiresAt: d.expiresAt,
  };
}

/**
 * Publica una oferta llegada por push.
 *
 * Una oferta ya vencida se descarta aquí y no se guarda: el reloj corrió
 * mientras el teléfono estaba sin cobertura, y levantar la hoja en cero
 * solo invita a pulsar un botón que va a fallar. Es la misma regla que
 * aplica `OfferSheet` con las del socket.
 */
export function publishOffer(offer: OrderOffer): void {
  if (new Date(offer.expiresAt).getTime() <= Date.now()) return;

  if (listeners.size === 0) {
    pending = offer;
    return;
  }
  listeners.forEach((listener) => listener(offer));
}

/**
 * Se suscribe y, de paso, vacía lo que hubiera esperando.
 *
 * Las dos cosas van juntas a propósito: quien escucha quiere la oferta que
 * llegó hace un segundo tanto como la que llegue dentro de un minuto, y
 * separarlo en dos llamadas es una invitación a olvidarse de la primera.
 */
export function subscribeToOffers(listener: Listener): () => void {
  listeners.add(listener);

  if (pending) {
    const offer = pending;
    pending = null;
    // Vencida mientras esperaba en el buzón: no se entrega.
    if (new Date(offer.expiresAt).getTime() > Date.now()) listener(offer);
  }

  return () => {
    listeners.delete(listener);
  };
}

/** Solo para las pruebas: deja el buzón como recién arrancado. */
export function resetOfferInbox(): void {
  listeners.clear();
  pending = null;
}
