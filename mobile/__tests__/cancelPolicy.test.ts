import { canCancelBySelf, isCancellable } from '../lib/cancelPolicy';

/**
 * Hasta cuándo puede cancelar el cliente por su cuenta.
 *
 * Cada cancelación emite **reembolso completo** por la pasarela, así que
 * esta frontera no es de interfaz: decide quién asume el coste de un pedido
 * que ya se cocinó. Un cambio accidental aquí no rompe ninguna pantalla y
 * empieza a costar dinero en silencio, que es exactamente el tipo de fallo
 * que un test tiene que sujetar.
 */
describe('canCancelBySelf', () => {
  it('deja cancelar antes de que la cocina empiece', () => {
    expect(canCancelBySelf('pending')).toBe(true);
    expect(canCancelBySelf('accepted')).toBe(true);
  });

  it('manda a soporte desde que hay comida hecha', () => {
    // A partir de aquí alguien puso ingredientes y tiempo, y en `on_way`
    // además va sobre una moto.
    expect(canCancelBySelf('preparing')).toBe(false);
    expect(canCancelBySelf('ready')).toBe(false);
    expect(canCancelBySelf('on_way')).toBe(false);
  });
});

describe('isCancellable', () => {
  it('cubre los cinco estados que el servidor permite', () => {
    for (const status of ['pending', 'accepted', 'preparing', 'ready', 'on_way']) {
      expect(isCancellable(status)).toBe(true);
    }
  });

  it('no ofrece nada sobre un pedido ya cerrado', () => {
    // `picked_up` no está en la lista del servidor: la comida está recogida
    // y aún no en camino, y ahí la transición a cancelado no existe.
    expect(isCancellable('delivered')).toBe(false);
    expect(isCancellable('cancelled')).toBe(false);
    expect(isCancellable('picked_up')).toBe(false);
  });
});
