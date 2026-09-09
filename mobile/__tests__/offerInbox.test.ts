import {
  offerFromPushData,
  publishOffer,
  subscribeToOffers,
  resetOfferInbox,
} from '../lib/offerInbox';

/**
 * El buzón de ofertas llegadas por notificación.
 *
 * Lo que se prueba aquí no es el formato de un objeto: es que una oferta no
 * se pierda entre que la push despierta la app y que `OfferSheet` alcanza a
 * montarse. Ese hueco de milisegundos es todo el motivo por el que este
 * módulo existe, y un fallo ahí no da error — simplemente el domiciliario
 * no ve el pedido y no sabe por qué.
 */

const inSeconds = (n: number) => new Date(Date.now() + n * 1000).toISOString();

const pushData = (over: Record<string, unknown> = {}) => ({
  kind: 'order:offer',
  orderId: 'abc123',
  orderNumber: 'ZIPP-1001',
  businessName: 'Panadería El Trigal',
  round: 1,
  etaSeconds: 240,
  expiresAt: inSeconds(45),
  ...over,
});

beforeEach(() => resetOfferInbox());

describe('offerFromPushData', () => {
  it('reconstruye la oferta entera desde el data de la push', () => {
    expect(offerFromPushData(pushData())).toEqual({
      orderId: 'abc123',
      orderNumber: 'ZIPP-1001',
      businessName: 'Panadería El Trigal',
      round: 1,
      etaSeconds: 240,
      expiresAt: expect.any(String),
    });
  });

  it('ignora las push que no son ofertas', () => {
    // El mismo listener ve todos los avisos del sistema. Confundir un
    // "tu pedido va en camino" con una oferta levantaría una hoja con un
    // contador inventado.
    expect(offerFromPushData({ kind: 'order:status', orderId: 'abc' })).toBeNull();
    expect(offerFromPushData(null)).toBeNull();
    expect(offerFromPushData('order:offer')).toBeNull();
  });

  it('rechaza una oferta sin id o sin caducidad', () => {
    // Sin caducidad no hay reloj, y una hoja de oferta sin reloj es una
    // promesa que la app no puede cumplir.
    expect(offerFromPushData(pushData({ expiresAt: undefined }))).toBeNull();
    expect(offerFromPushData(pushData({ orderId: undefined }))).toBeNull();
  });

  it('sobrevive a un negocio sin nombre', () => {
    // El backend manda `null` cuando el pedido es un mandado: no hay
    // comercio del que salga nada.
    const offer = offerFromPushData(pushData({ businessName: null }));
    expect(offer?.businessName).toBeUndefined();
    expect(offer?.orderId).toBe('abc123');
  });
});

describe('el buzón', () => {
  it('entrega a quien ya estaba escuchando', () => {
    const seen: string[] = [];
    subscribeToOffers((o) => seen.push(o.orderId));

    publishOffer(offerFromPushData(pushData())!);

    expect(seen).toEqual(['abc123']);
  });

  it('guarda la oferta que llega antes de que haya nadie escuchando', () => {
    // Es el arranque desde la notificación con la app cerrada:
    // `getLastNotificationResponseAsync` dispara antes de que OfferSheet
    // se monte. Sin el buzón, esa oferta se publicaría en el vacío — y es
    // justo el caso que más importa acertar.
    publishOffer(offerFromPushData(pushData())!);

    const seen: string[] = [];
    subscribeToOffers((o) => seen.push(o.orderId));

    expect(seen).toEqual(['abc123']);
  });

  it('solo la vacía una vez', () => {
    publishOffer(offerFromPushData(pushData())!);

    const primero: string[] = [];
    const segundo: string[] = [];
    subscribeToOffers((o) => primero.push(o.orderId));
    subscribeToOffers((o) => segundo.push(o.orderId));

    expect(primero).toEqual(['abc123']);
    expect(segundo).toEqual([]);
  });

  it('descarta una oferta ya vencida', () => {
    // El teléfono estuvo sin cobertura y la push llegó tarde. Levantar la
    // hoja con el contador en cero solo invita a pulsar un botón que va a
    // fallar con un 409.
    publishOffer(offerFromPushData(pushData({ expiresAt: inSeconds(-5) }))!);

    const seen: string[] = [];
    subscribeToOffers((o) => seen.push(o.orderId));

    expect(seen).toEqual([]);
  });

  it('se queda con la última cuando llegan dos seguidas', () => {
    // Dos ofertas pendientes no son una cola: la vieja o venció o ya se la
    // quedó alguien.
    publishOffer(offerFromPushData(pushData({ orderId: 'vieja' }))!);
    publishOffer(offerFromPushData(pushData({ orderId: 'nueva' }))!);

    const seen: string[] = [];
    subscribeToOffers((o) => seen.push(o.orderId));

    expect(seen).toEqual(['nueva']);
  });

  it('deja de entregar tras darse de baja', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToOffers((o) => seen.push(o.orderId));
    unsubscribe();

    publishOffer(offerFromPushData(pushData())!);

    // Vuelve al buzón en vez de perderse: el siguiente que escuche la verá.
    expect(seen).toEqual([]);
    const otro: string[] = [];
    subscribeToOffers((o) => otro.push(o.orderId));
    expect(otro).toEqual(['abc123']);
  });
});
