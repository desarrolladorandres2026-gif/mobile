import { shouldPersistQuery } from '../lib/queryPersistence';

/**
 * Qué se guarda entre aperturas de la app.
 *
 * La regla es una lista de lo permitido: catálogo y direcciones. Estas
 * pruebas fijan sobre todo lo que **no** puede guardarse nunca —pedidos,
 * pagos, saldos, lo del domiciliario—, porque enseñar un estado de pedido
 * o un saldo de ayer como si fuera de ahora es peor que un esqueleto.
 */
const ok = (queryKey: unknown[]) => ({ queryKey, state: { status: 'success' } }) as any;

describe('shouldPersistQuery', () => {
  it.each([
    [['home-sections', { lat: 2.19, lng: -75.62 }]],
    [['home-sections', undefined]],
    [['homeCategories']],
    [['banners', 'home']],
    [['business', 'abc']],
    [['categories', 'abc']],
    [['products', 'abc', undefined]],
    [['products', 'top', 'abc']],
    [['products', 'sentiment', 'abc']],
    [['addresses']],
  ])('guarda %j', (key) => {
    expect(shouldPersistQuery(ok(key))).toBe(true);
  });

  it.each([
    [['orders', 'my', 1]],
    [['order', 'abc']],
    [['orderFlow', 'abc']],
    [['orderChat', 'abc']],
    [['tracking', 'abc']],
    [['payments', 'cards']],
    [['payments', 'methods']],
    [['coupons', 'mine']],
    [['driver', 'earnings', '2026-09-18']],
    [['driver', 'debts']],
    [['referrals']],
    [['receipt', 'abc']],
    [['orderQuote', {}]],
    [['storefront', 'abc']],
    [['addresses', 'search', 'calle 5', 2.1, -75.6]],
  ])('nunca guarda %j', (key) => {
    expect(shouldPersistQuery(ok(key))).toBe(false);
  });

  it('no guarda una consulta que falló o sigue cargando', () => {
    expect(shouldPersistQuery({ queryKey: ['homeCategories'], state: { status: 'error' } } as any)).toBe(false);
    expect(shouldPersistQuery({ queryKey: ['homeCategories'], state: { status: 'pending' } } as any)).toBe(false);
  });
});
