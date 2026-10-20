import { describe, expect, it } from 'vitest';
import { TaxError, computeLine, computeTotals, proportionalShare } from './tax.js';

const line = (overrides = {}) => ({ quantity: 1000, unitPrice: 10_000, discountBps: 0, vatBps: 1900, ...overrides });

describe('cálculo de una línea', () => {
  it('1 unidad de 100,00 con IVA 19 %: neto 10000, impuesto 1900, total 11900', () => {
    expect(computeLine(line())).toEqual({ gross: 10_000, discount: 0, net: 10_000, tax: 1900, total: 11_900 });
  });

  it('admite cantidades con decimales sin pasar por números flotantes', () => {
    // 1,5 × 10 000 = 15 000
    expect(computeLine(line({ quantity: 1500 })).gross).toBe(15_000);
    // 0,333 × 10 000 = 3 330
    expect(computeLine(line({ quantity: 333 })).gross).toBe(3330);
  });

  it('redondea medio hacia arriba', () => {
    // 0,001 × 12 500 = 12,5 → 13
    expect(computeLine(line({ quantity: 1, unitPrice: 12_500, vatBps: 0 })).gross).toBe(13);
    // 0,001 × 12 499 = 12,499 → 12
    expect(computeLine(line({ quantity: 1, unitPrice: 12_499, vatBps: 0 })).gross).toBe(12);
  });

  it('aplica el descuento antes del impuesto', () => {
    // 100,00 con 10 % de descuento = 90,00 neto; IVA 19 % sobre 90,00 = 17,10
    expect(computeLine(line({ discountBps: 1000 }))).toEqual({ gross: 10_000, discount: 1000, net: 9000, tax: 1710, total: 10_710 });
  });

  it('IVA 0 y 5 %', () => {
    expect(computeLine(line({ vatBps: 0 })).tax).toBe(0);
    expect(computeLine(line({ vatBps: 500 })).tax).toBe(500);
  });

  it('un descuento del 100 % deja la línea en cero', () => {
    expect(computeLine(line({ discountBps: 10_000 }))).toEqual({ gross: 10_000, discount: 10_000, net: 0, tax: 0, total: 0 });
  });

  it('importes enormes siguen exactos y los que se salen del rango seguro se rechazan', () => {
    const big = computeLine(line({ quantity: 1000, unitPrice: 9_000_000_000_000_000, vatBps: 0 }));
    expect(big.net).toBe(9_000_000_000_000_000);
    expect(() => computeLine(line({ quantity: 1000, unitPrice: 9_000_000_000_000_000, vatBps: 1900 }))).toThrow(TaxError);
  });

  it('rechaza valores que no son enteros o están fuera de rango', () => {
    for (const bad of [
      { quantity: 0 },
      { quantity: -1 },
      { quantity: 1.5 },
      { unitPrice: -1 },
      { unitPrice: 10.5 },
      { discountBps: -1 },
      { discountBps: 10_001 },
      { vatBps: 10_001 },
      { vatBps: 19.5 },
      { quantity: '1000' },
    ]) {
      expect(() => computeLine(line(bad)), JSON.stringify(bad)).toThrow(TaxError);
    }
  });
});

describe('totales del documento', () => {
  const lines = [line({ quantity: 2000, unitPrice: 5_000 }), line({ unitPrice: 3_333, vatBps: 500 }), line({ unitPrice: 1_000, vatBps: 0 })].map((l) => ({
    ...l,
    ...computeLine(l),
  }));

  it('suma las líneas ya redondeadas, y el total es subtotal más impuestos', () => {
    const totals = computeTotals(lines);
    expect(totals.subtotal).toBe(lines.reduce((s, l) => s + l.net, 0));
    expect(totals.tax).toBe(lines.reduce((s, l) => s + l.tax, 0));
    expect(totals.total).toBe(totals.subtotal + totals.tax);
  });

  it('agrupa base e impuesto por tarifa, ordenadas', () => {
    const { taxByRate } = computeTotals(lines);
    expect(taxByRate.map((r) => r.vatBps)).toEqual([0, 500, 1900]);
    expect(taxByRate.reduce((s, r) => s + r.base, 0)).toBe(computeTotals(lines).subtotal);
    expect(taxByRate.reduce((s, r) => s + r.tax, 0)).toBe(computeTotals(lines).tax);
  });

  it('una lista vacía da ceros', () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, discount: 0, tax: 0, total: 0, taxByRate: [] });
  });

  it('propiedad: para muchas combinaciones, total = neto + impuesto y nada se sale de los límites', () => {
    let seed = 12345;
    const rand = (max) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 2000; i += 1) {
      const l = computeLine({ quantity: 1 + rand(100_000), unitPrice: rand(10_000_000), discountBps: rand(10_001), vatBps: [0, 500, 1900][rand(3)] });
      expect(l.net + l.tax).toBe(l.total);
      expect(l.gross - l.discount).toBe(l.net);
      expect(l.net).toBeGreaterThanOrEqual(0);
      expect(l.tax).toBeLessThanOrEqual(Math.ceil(l.net * 0.19) + 1);
    }
  });
});

describe('parte proporcional para notas crédito', () => {
  const invoiceLine = { quantity: 3000, ...computeLine({ quantity: 3000, unitPrice: 3_333, vatBps: 1900 }) }; // 3 unidades

  it('una parte se calcula proporcional', () => {
    const share = proportionalShare(invoiceLine, { quantity: 1000 });
    expect(share.net).toBe(Math.round(invoiceLine.net / 3));
    expect(share.total).toBe(share.net + share.tax);
  });

  it('acreditar todo lo que queda usa la diferencia exacta: tres notas suman justo la línea', () => {
    const first = proportionalShare(invoiceLine, { quantity: 1000 });
    const second = proportionalShare(invoiceLine, { quantity: 1000, creditedQuantity: 1000, creditedNet: first.net, creditedTax: first.tax });
    const third = proportionalShare(invoiceLine, {
      quantity: 1000,
      creditedQuantity: 2000,
      creditedNet: first.net + second.net,
      creditedTax: first.tax + second.tax,
    });
    expect(first.net + second.net + third.net).toBe(invoiceLine.net);
    expect(first.tax + second.tax + third.tax).toBe(invoiceLine.tax);
  });

  it('no deja acreditar más de lo facturado', () => {
    expect(() => proportionalShare(invoiceLine, { quantity: 3001 })).toThrow(/más de lo facturado/);
    expect(() => proportionalShare(invoiceLine, { quantity: 1000, creditedQuantity: 2500 })).toThrow(/más de lo facturado/);
    expect(() => proportionalShare(invoiceLine, { quantity: 0 })).toThrow(TaxError);
  });
});
