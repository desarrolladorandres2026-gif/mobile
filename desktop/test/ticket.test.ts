import { describe, it, expect } from 'vitest';
import { validateTicket, isValidTicket } from '../src/shared/ticket';

function baseTicket() {
  return {
    orderNumber: '1042',
    businessName: 'Donde Betty',
    items: [{ name: 'Bandeja paisa', quantity: 1, price: 18000 }],
    total: 18000,
    paperWidthMm: 80,
  };
}

describe('Validación del comprobante de impresión', () => {
  it('un comprobante completo es válido', () => {
    expect(validateTicket(baseTicket())).toEqual([]);
    expect(isValidTicket(baseTicket())).toBe(true);
  });

  it('rechaza un ancho de papel que no sea 58 o 80', () => {
    expect(validateTicket({ ...baseTicket(), paperWidthMm: 112 })).toContain('paperWidthMm debe ser 58 o 80');
  });

  it('rechaza dinero no entero o negativo, igual que money.ts en el backend', () => {
    expect(validateTicket({ ...baseTicket(), total: 18000.5 })).toContain('total inválido');
    expect(validateTicket({ ...baseTicket(), total: -1 })).toContain('total inválido');
    expect(validateTicket({ ...baseTicket(), items: [{ name: 'x', quantity: 1, price: -5 }] }))
      .toContain('items[0].price inválido');
  });

  it('rechaza items vacíos y más de 100 líneas', () => {
    expect(validateTicket({ ...baseTicket(), items: [] })).toContain('items vacío');
    const manyItems = Array.from({ length: 101 }, () => ({ name: 'x', quantity: 1, price: 1000 }));
    expect(validateTicket({ ...baseTicket(), items: manyItems })).toContain('items tiene más de 100 líneas');
  });

  it('rechaza una cantidad por línea que no sea un entero positivo razonable', () => {
    expect(validateTicket({ ...baseTicket(), items: [{ name: 'x', quantity: 0, price: 1000 }] }))
      .toContain('items[0].quantity inválido');
    expect(validateTicket({ ...baseTicket(), items: [{ name: 'x', quantity: 1000, price: 1000 }] }))
      .toContain('items[0].quantity inválido');
  });

  it('no es un objeto, o le falta todo', () => {
    expect(validateTicket('no es un ticket')).toEqual(['El comprobante no es un objeto']);
    expect(validateTicket({}).length).toBeGreaterThan(0);
  });
});
