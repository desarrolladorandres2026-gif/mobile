import { describe, expect, it } from 'vitest';
import { addDays, blankLine, runSummary, validateDocLines, validateRecurring } from './commercial.js';

const line = (patch = {}) => ({ ...blankLine(1900), description: 'Mercancía', quantity: '2', unitPrice: '5.000,00', ...patch });

describe('líneas de un documento comercial', () => {
  it('calcula con la aritmética de la factura y deja el cuerpo listo', () => {
    const r = validateDocLines([line(), blankLine(0)], { currency: 'COP' });
    expect(r.ok).toBe(true);
    expect(r.totals).toMatchObject({ subtotal: 1_000_000, tax: 190_000, total: 1_190_000 });
    expect(r.prepared).toEqual([{ description: 'Mercancía', quantity: 2000, unitPrice: 500_000, vatBps: 1900 }]);
  });

  it('lleva descuento, cuenta, artículo y centro de costo', () => {
    const item = { _id: 'abc123abc123abc123abc123', sku: 'A1' };
    const r = validateDocLines([line({ discount: '10', costCenter: 'NORTE', accountId: '519595' }), line({ item, itemText: 'A1', accountId: '519595' })], { currency: 'COP' });
    expect(r.prepared[0]).toMatchObject({ discountBps: 1000, costCenter: 'NORTE', accountId: '519595' });
    // Con artículo, la cuenta la pone el artículo: no se envía.
    expect(r.prepared[1]).toEqual({ description: 'Mercancía', quantity: 2000, unitPrice: 500_000, vatBps: 1900, itemId: item._id });
  });

  it('señala los errores por línea', () => {
    const r = validateDocLines([line({ description: '' }), line({ quantity: '0' }), line({ unitPrice: 'abc' }), line({ discount: '150' }), line({ accountId: 'x1' }), line({ itemText: 'zzz' })], { currency: 'COP' });
    expect(r.ok).toBe(false);
    expect(r.errors.lines.map((e) => Object.keys(e))).toEqual([['description'], ['quantity'], ['unitPrice'], ['discount'], ['accountId'], ['item']]);
  });

  it('pide al menos una línea y un total mayor que cero', () => {
    expect(validateDocLines([blankLine(0)], { currency: 'COP' }).errors.form).toEqual(['Agrega al menos una línea.']);
    expect(validateDocLines([line({ unitPrice: '0' })], { currency: 'COP' }).errors.form).toEqual(['El total debe ser mayor que cero.']);
  });

  it('la orden de compra exige cuenta o artículo en cada línea', () => {
    const r = validateDocLines([line()], { currency: 'COP', requireAccount: true });
    expect(r.errors.lines[0].accountId).toBe('Indica la cuenta o elige un artículo.');
    expect(validateDocLines([line({ accountId: '519595' })], { currency: 'COP', requireAccount: true }).ok).toBe(true);
    expect(validateDocLines([line({ item: { _id: 'abc123abc123abc123abc123' }, itemText: 'A1' })], { currency: 'COP', requireAccount: true }).ok).toBe(true);
  });
});

describe('plantilla recurrente', () => {
  const base = { name: 'Mantenimiento', customerId: 'c1', frequency: 'monthly', startDate: '2026-11-01', endDate: '', paymentMethod: 'credit', dueDays: '30', notes: '' };

  it('arma el cuerpo; el contado no lleva plazo', () => {
    expect(validateRecurring(base)).toEqual({ ok: true, body: { name: 'Mantenimiento', customerId: 'c1', frequency: 'monthly', startDate: '2026-11-01', paymentMethod: 'credit', dueDays: 30 } });
    expect(validateRecurring({ ...base, paymentMethod: 'cash', dueDays: '', notes: ' nota ' }).body).toEqual({ name: 'Mantenimiento', customerId: 'c1', frequency: 'monthly', startDate: '2026-11-01', paymentMethod: 'cash', notes: 'nota' });
  });

  it('señala lo que falta o no cuadra', () => {
    expect(validateRecurring({ ...base, name: ' ', customerId: '' }).errors).toEqual(['Escribe el nombre de la plantilla.', 'Elige el cliente.']);
    expect(validateRecurring({ ...base, endDate: '2026-10-01' }).errors).toEqual(['La fecha final no puede ser anterior a la primera factura.']);
    expect(validateRecurring({ ...base, dueDays: '0' }).errors).toEqual(['Una venta a crédito necesita días de plazo.']);
    expect(validateRecurring({ ...base, dueDays: '400' }).errors).toEqual(['Los días de plazo son un número de 0 a 365.']);
  });
});

describe('utilidades', () => {
  it('suma días con cambio de mes y de año', () => {
    expect(addDays('2026-10-25', 10)).toBe('2026-11-04');
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('resume una generación', () => {
    expect(runSummary({ generated: [], failed: [] })).toBe('No había facturas vencidas por generar.');
    expect(runSummary({ generated: [{}], failed: [] })).toBe('Se emitieron 1 factura.');
    expect(runSummary({ generated: [{}, {}], failed: [{}] })).toBe('Se emitieron 2 facturas y 1 plantilla falló.');
  });
});
