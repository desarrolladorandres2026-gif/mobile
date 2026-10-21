import { describe, expect, it } from 'vitest';
import { cartLine, differenceLabel, validateClose, validateSale } from './pos.js';

const item = { _id: 'a1', sku: 'TORN-1', name: 'Tornillo', price: 25_000, vatBps: 1900 };
const free = (patch = {}) => ({ ...cartLine(), description: 'Armado', unitPrice: '10.000', quantity: '1', ...patch });
const check = (patch = {}) => validateSale({ lines: [free()], currency: 'COP', ...patch });

describe('línea del carrito', () => {
  it('un artículo trae nombre, precio e IVA de su ficha', () => {
    expect(cartLine({ item })).toMatchObject({ description: 'Tornillo', unitPrice: '25000', priceFromItem: true, vatBps: 1900, quantity: '1' });
  });
  it('un artículo sin precio lo pide, y un concepto libre también', () => {
    expect(cartLine({ item: { ...item, price: undefined } })).toMatchObject({ unitPrice: '', priceFromItem: false });
    expect(cartLine()).toMatchObject({ item: null, unitPrice: '', priceFromItem: false });
  });
});

describe('validación de la venta', () => {
  it('todo en efectivo: el efectivo es el total y el cuerpo sale en enteros', () => {
    const r = check();
    expect(r.ok).toBe(true);
    expect(r.totals).toMatchObject({ subtotal: 1_000_000, tax: 190_000, total: 1_190_000 });
    expect(r.body).toEqual({ lines: [{ description: 'Armado', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900 }], payments: [{ method: 'cash', amount: 1_190_000 }] });
  });

  it('un artículo manda su itemId y el precio de su ficha, que ya viene en unidades menores', () => {
    const r = validateSale({ lines: [cartLine({ item })], currency: 'COP' });
    expect(r.ok).toBe(true);
    expect(r.body.lines[0]).toEqual({ description: 'Tornillo', quantity: 1000, unitPrice: 25_000, vatBps: 1900, itemId: 'a1' });
    expect(r.totals.total).toBe(29_750);
  });

  it('el efectivo es lo que falta tras tarjeta y transferencia', () => {
    const r = check({ cardText: '5.000', transferText: '2.000' });
    expect(r.cash).toBe(1_190_000 - 500_000 - 200_000);
    expect(r.body.payments).toEqual([
      { method: 'cash', amount: 490_000 },
      { method: 'card', amount: 500_000 },
      { method: 'transfer', amount: 200_000 },
    ]);
  });

  it('pagar todo con tarjeta no deja pago en efectivo', () => {
    const r = check({ cardText: '11.900' });
    expect(r.cash).toBe(0);
    expect(r.body.payments).toEqual([{ method: 'card', amount: 1_190_000 }]);
  });

  it('calcula el cambio con el efectivo recibido y lo manda solo si hay efectivo', () => {
    const r = check({ tenderedText: '20.000' });
    expect(r.change).toBe(2_000_000 - 1_190_000);
    expect(r.body.cashTendered).toBe(2_000_000);
    const card = check({ cardText: '11.900', tenderedText: '20.000' });
    expect(card.body).not.toHaveProperty('cashTendered');
  });

  it('rechaza tarjeta y transferencia que pasan del total, y un recibido menor que el cobro', () => {
    expect(check({ cardText: '12.000' }).errors.form.join(' ')).toMatch(/más que el total/);
    expect(check({ tenderedText: '5.000' }).errors.form.join(' ')).toMatch(/menor/);
    expect(check({ cardText: '1,234' }).ok).toBe(false);
    expect(check({ tenderedText: 'abc' }).ok).toBe(false);
  });

  it('un método que la caja no acepta no cuenta', () => {
    const r = check({ cardText: '5.000', accepts: { card: false, transfer: true } });
    expect(r.ok).toBe(true);
    expect(r.body.payments).toEqual([{ method: 'cash', amount: 1_190_000 }]);
  });

  it('exige líneas y marca cada línea mal escrita', () => {
    expect(validateSale({ lines: [], currency: 'COP' }).errors.form).toContain('Agrega al menos un artículo o concepto.');
    const bad = check({ lines: [free({ description: '', quantity: '0', unitPrice: '12,345' })] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.lines[0]).toMatchObject({ description: expect.any(String), quantity: expect.stringMatching(/Cantidad/), unitPrice: expect.stringMatching(/Precio/) });
  });
});

describe('cierre del turno', () => {
  it('calcula la diferencia contra lo esperado', () => {
    expect(validateClose({ countedText: '150.000', expectedCash: 15_000_000, currency: 'COP' })).toMatchObject({ ok: true, counted: 15_000_000, difference: 0 });
    expect(validateClose({ countedText: '149.000', expectedCash: 15_000_000, currency: 'COP' }).difference).toBe(-100_000);
    expect(validateClose({ countedText: '151.000', expectedCash: 15_000_000, currency: 'COP' }).difference).toBe(100_000);
  });
  it('exige un importe válido', () => {
    expect(validateClose({ countedText: '', expectedCash: 0, currency: 'COP' }).ok).toBe(false);
    expect(validateClose({ countedText: '1.2345', expectedCash: 0, currency: 'COP' }).ok).toBe(false);
  });
  it('nombra la diferencia', () => {
    expect([0, -5, 5].map(differenceLabel)).toEqual(['Cuadra', 'Faltante', 'Sobrante']);
  });
});
