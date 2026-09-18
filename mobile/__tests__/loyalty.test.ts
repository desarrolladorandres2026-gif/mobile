import { planRedemption, redeemOptions } from '../lib/loyalty';

describe('redeemOptions', () => {
  it('ofrece el mínimo, un cuarto, la mitad y todo', () => {
    expect(redeemOptions(12_350, 1000)).toEqual([1000, 3000, 6100, 12_350]);
  });

  it('con saldo corto no repite ni ofrece menos del mínimo', () => {
    expect(redeemOptions(1500, 1000)).toEqual([1000, 1500]);
  });

  it('por debajo del mínimo no ofrece nada', () => {
    expect(redeemOptions(800, 1000)).toEqual([]);
  });
});

/**
 * El canje es un cupón de un solo uso que el servidor recorta a lo que el
 * pedido puede absorber. Canjear de más no da más descuento: quema puntos.
 */
describe('planRedemption', () => {
  const base = { balance: 10_000, minRedeem: 1000, maxPerOrder: 0, subtotal: 50_000 };

  it('con saldo de sobra canjea todo el saldo', () => {
    expect(planRedemption(base)).toEqual({ kind: 'redeem', points: 10_000 });
  });

  it('nunca canjea más que el subtotal: el resto se quemaría', () => {
    expect(planRedemption({ ...base, subtotal: 7000 })).toEqual({ kind: 'redeem', points: 7000 });
  });

  it('respeta el tope de subsidio por pedido', () => {
    expect(planRedemption({ ...base, maxPerOrder: 5000 })).toEqual({ kind: 'redeem', points: 5000 });
  });

  it('dice cuánto falta cuando el saldo no llega al mínimo', () => {
    expect(planRedemption({ ...base, balance: 400 })).toEqual({ kind: 'below-minimum', missing: 600 });
  });

  it('distingue un pedido demasiado pequeño de un saldo insuficiente', () => {
    expect(planRedemption({ ...base, subtotal: 800 })).toEqual({ kind: 'order-too-small', minRedeem: 1000 });
  });

  it('sin puntos no ofrece nada', () => {
    expect(planRedemption({ ...base, balance: 0 })).toEqual({ kind: 'none' });
  });
});
