import {
  messageChannel,
  normalizeChannel,
  chatThreadKey,
  chatThreadsKey,
  chatEventChannel,
  unreadByChannel,
  totalUnread,
  initialChatChannel,
  channelParam,
} from '../lib/orderChat';

/**
 * Los dos hilos del chat del pedido. Lo que se fija aquí es que nunca se
 * mezclen: un mensaje del comercio no cuenta ni se ve en el hilo del cliente,
 * y un servidor viejo (sin `channel`) sigue siendo el hilo del cliente.
 */
describe('messageChannel', () => {
  it('lee el canal del mensaje', () => {
    expect(messageChannel({ channel: 'business_driver' })).toBe('business_driver');
    expect(messageChannel({ channel: 'client_driver' })).toBe('client_driver');
  });

  it('sin canal (servidor viejo) es el hilo del cliente', () => {
    expect(messageChannel({})).toBe('client_driver');
    expect(messageChannel({ channel: null })).toBe('client_driver');
    expect(messageChannel(undefined)).toBe('client_driver');
  });

  it('un canal desconocido nunca cae en el del comercio', () => {
    expect(messageChannel({ channel: 'otra_cosa' })).toBe('client_driver');
    expect(normalizeChannel('otra_cosa')).toBe('client_driver');
  });
});

describe('claves de caché', () => {
  it('cada hilo tiene su propia clave', () => {
    expect(chatThreadKey('o1', 'client_driver')).not.toEqual(chatThreadKey('o1', 'business_driver'));
    expect(chatThreadKey('o1', 'business_driver')).toEqual(['orderChat', 'o1', 'business_driver']);
  });

  it('el prefijo del pedido cubre los dos hilos', () => {
    const prefix = chatThreadsKey('o1');
    expect(chatThreadKey('o1', 'client_driver').slice(0, prefix.length)).toEqual([...prefix]);
    expect(chatThreadKey('o1', 'business_driver').slice(0, prefix.length)).toEqual([...prefix]);
  });
});

describe('chatEventChannel', () => {
  it('enruta un mensaje al hilo de su canal', () => {
    expect(
      chatEventChannel({ orderId: 'o1', message: { channel: 'business_driver' } }, 'o1', true),
    ).toBe('business_driver');
    expect(
      chatEventChannel({ orderId: 'o1', message: { channel: 'client_driver' } }, 'o1', true),
    ).toBe('client_driver');
  });

  it('un mensaje sin canal va al hilo del cliente', () => {
    expect(chatEventChannel({ orderId: 'o1', message: {} }, 'o1', true)).toBe('client_driver');
  });

  it('order:chat:read trae el canal suelto; sin él es el del cliente', () => {
    expect(chatEventChannel({ orderId: 'o1', channel: 'business_driver' }, 'o1', true)).toBe('business_driver');
    expect(chatEventChannel({ orderId: 'o1' }, 'o1', true)).toBe('client_driver');
  });

  it('ignora eventos de otro pedido o vacíos', () => {
    expect(chatEventChannel({ orderId: 'otro', message: {} }, 'o1', true)).toBeNull();
    expect(chatEventChannel(undefined, 'o1', true)).toBeNull();
  });

  it('en la app del cliente el hilo del comercio no existe', () => {
    expect(
      chatEventChannel({ orderId: 'o1', message: { channel: 'business_driver' } }, 'o1', false),
    ).toBeNull();
    expect(chatEventChannel({ orderId: 'o1', channel: 'business_driver' }, 'o1', false)).toBeNull();
    expect(chatEventChannel({ orderId: 'o1', message: {} }, 'o1', false)).toBe('client_driver');
  });
});

describe('no leídos', () => {
  it('separa los dos hilos', () => {
    expect(unreadByChannel({ unread: 2, unreadBusiness: 5 })).toEqual({
      client_driver: 2,
      business_driver: 5,
    });
  });

  it('un servidor viejo no manda unreadBusiness: vale 0', () => {
    expect(unreadByChannel({ unread: 3 })).toEqual({ client_driver: 3, business_driver: 0 });
    expect(unreadByChannel(undefined)).toEqual({ client_driver: 0, business_driver: 0 });
  });

  it('suma los dos hilos para el indicador del botón', () => {
    expect(totalUnread({ unread: 2, unreadBusiness: 5 })).toBe(7);
    expect(totalUnread({ unread: 0, unreadBusiness: 1 })).toBe(1);
    expect(totalUnread({ unread: 0, unreadBusiness: 0 })).toBe(0);
    expect(totalUnread(undefined)).toBe(0);
  });

  it('un valor negativo no resta', () => {
    expect(totalUnread({ unread: -4, unreadBusiness: 2 })).toBe(2);
  });
});

describe('initialChatChannel', () => {
  it('abre el del cliente por defecto', () => {
    expect(initialChatChannel({ unread: 0, unreadBusiness: 0 })).toBe('client_driver');
    expect(initialChatChannel({ unread: 2, unreadBusiness: 3 })).toBe('client_driver');
    expect(initialChatChannel(undefined)).toBe('client_driver');
  });

  it('salta al del comercio solo si es el único con novedades', () => {
    expect(initialChatChannel({ unread: 0, unreadBusiness: 1 })).toBe('business_driver');
  });
});

describe('channelParam', () => {
  it('el hilo del cliente no añade parámetro: la petición queda como siempre', () => {
    expect(channelParam('client_driver')).toEqual({});
  });

  it('el hilo del comercio lo manda explícito', () => {
    expect(channelParam('business_driver')).toEqual({ channel: 'business_driver' });
  });
});
