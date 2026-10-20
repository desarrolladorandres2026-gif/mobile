import { describe, expect, it } from 'vitest';
// Solo para esta prueba de paridad: se compara con la implementación del servidor, que es la que manda.
import * as server from '../../../backend/src/invoicing/tax.js';
import { computeLine, computeTotals, formatPercent, formatQuantity, parsePercent, parseQuantity } from './invoicing.js';

describe('paridad con el cálculo del servidor', () => {
  it('línea a línea, igual en miles de combinaciones aleatorias', () => {
    let seed = 987654321;
    const rand = (max) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 5000; i += 1) {
      const input = { quantity: 1 + rand(5_000_000), unitPrice: rand(2_000_000_000), discountBps: rand(10_001), vatBps: [0, 500, 1900, rand(10_001)][rand(4)] };
      expect(computeLine(input), JSON.stringify(input)).toEqual(server.computeLine(input));
    }
  });

  it('los totales y el desglose por tarifa coinciden', () => {
    const inputs = [
      { quantity: 2000, unitPrice: 50_000, vatBps: 1900 },
      { quantity: 1000, unitPrice: 20_000, discountBps: 1000, vatBps: 500 },
      { quantity: 333, unitPrice: 12_500, vatBps: 0 },
      { quantity: 7_777, unitPrice: 99_999, discountBps: 333, vatBps: 1900 },
    ];
    const withLine = (fn) => inputs.map((l) => ({ ...l, discountBps: l.discountBps ?? 0, ...fn(l) }));
    const mine = computeTotals(withLine(computeLine));
    const theirs = server.computeTotals(withLine(server.computeLine));
    expect(mine.subtotal).toBe(theirs.subtotal);
    expect(mine.tax).toBe(theirs.tax);
    expect(mine.total).toBe(theirs.total);
    expect(mine.taxByRate).toEqual(theirs.taxByRate);
  });

  it('un importe fuera del rango seguro da null en vez de un número equivocado', () => {
    expect(computeLine({ quantity: 1000, unitPrice: 9_000_000_000_000_000, vatBps: 1900 })).toBeNull();
  });
});

describe('cantidades', () => {
  it.each([
    ['1', 1000],
    ['1,5', 1500],
    ['0,001', 1],
    ['12,345', 12_345],
    [' 3 ', 3000],
  ])('«%s» es %i milésimas', (text, milli) => expect(parseQuantity(text)).toBe(milli));

  it.each([['0'], ['0,000'], ['1,2345'], ['-1'], ['abc'], ['1.5'], ['1,5,5'], ['']])('rechaza «%s»', (text) => expect(parseQuantity(text)).toBeNull());

  it('ida y vuelta', () => {
    for (const milli of [1, 10, 100, 1000, 1500, 12_345, 3_000_000]) expect(parseQuantity(formatQuantity(milli))).toBe(milli);
  });
});

describe('porcentajes', () => {
  it.each([
    ['10', 1000],
    ['12,5', 1250],
    ['0,25', 25],
    ['100', 10_000],
    ['19 %', 1900],
    ['', 0],
  ])('«%s» es %i puntos básicos', (text, bps) => expect(parsePercent(text)).toBe(bps));

  it.each([['100,01'], ['101'], ['-5'], ['1,234'], ['x']])('rechaza «%s»', (text) => expect(parsePercent(text)).toBeNull());

  it('se muestra con coma decimal solo cuando hace falta', () => {
    expect(formatPercent(1900)).toBe('19 %');
    expect(formatPercent(1250)).toBe('12,50 %');
    expect(formatPercent(0)).toBe('0 %');
  });
});
