import { describe, expect, it } from 'vitest';
// Solo para esta prueba de paridad: se compara con la implementación del servidor, que es la que manda.
import * as server from '../../../backend/src/purchases/purchases.js';
import { validatePurchase, withholdingAmount } from './purchases.js';

describe('retenciones: paridad con el servidor', () => {
  it('da el mismo importe en miles de combinaciones aleatorias', () => {
    let seed = 24681357;
    const rand = (max) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 5000; i += 1) {
      const base = rand(2_000_000_000);
      const rate = 1 + rand(10_000);
      expect(withholdingAmount(base, rate), `${base} × ${rate}`).toBe(server.withholdingAmount(base, rate));
    }
  });

  it('rechaza tarifas y bases fuera de rango', () => {
    expect(withholdingAmount(100, 0)).toBeNull();
    expect(withholdingAmount(100, 10_001)).toBeNull();
    expect(withholdingAmount(-1, 100)).toBeNull();
    expect(withholdingAmount(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

const line = (patch = {}) => ({ description: 'Servicio de aseo', quantity: '1', unitPrice: '10.000', discount: '', vatBps: 1900, accountId: '519595', ...patch });
const rete = (patch = {}) => ({ name: 'Retefuente 2,5 %', accountId: '236540', basis: 'subtotal', rate: '2,5', ...patch });
const check = (patch = {}) =>
  validatePurchase({ supplierId: 's1', supplierDocNumber: 'SA-1', issueDate: '2026-10-05', dueDate: '2026-11-04', lines: [line()], withholdings: [], currency: 'COP', ...patch });

describe('validación del formulario de compra', () => {
  it('calcula la vista previa igual que el servidor, con retenciones', () => {
    const result = check({ withholdings: [rete(), rete({ name: 'ReteIVA', accountId: '236701', basis: 'vat', rate: '15' })] });
    expect(result.ok).toBe(true);
    expect(result.totals).toMatchObject({ subtotal: 1_000_000, tax: 190_000, total: 1_190_000 });
    expect(result.withholdings.map((w) => w.amount)).toEqual([25_000, 28_500]);
    expect(result.withheld).toBe(53_500);
    expect(result.payable).toBe(1_136_500);
    expect(result.prepared).toEqual([{ description: 'Servicio de aseo', quantity: 1000, unitPrice: 1_000_000, vatBps: 1900, accountId: '519595' }]);
  });

  it('una línea o retención totalmente vacía se ignora', () => {
    const result = check({ lines: [line(), line({ description: '', unitPrice: '', quantity: '1', accountId: '' })], withholdings: [rete({ name: '', accountId: '', rate: '' })] });
    expect(result.ok).toBe(true);
    expect(result.prepared).toHaveLength(1);
    expect(result.withholdings).toEqual([]);
  });

  it('exige proveedor, número, fecha y que el vencimiento no preceda a la factura', () => {
    expect(check({ supplierId: '' }).errors.form).toContain('Elige el proveedor.');
    expect(check({ supplierDocNumber: ' ' }).errors.form).toContain('Escribe el número de la factura del proveedor.');
    expect(check({ issueDate: '' }).errors.form).toContain('Elige la fecha de la factura.');
    expect(check({ dueDate: '2026-10-01' }).errors.form).toContain('El vencimiento no puede ser anterior a la fecha de la factura.');
    expect(check({ dueDate: '' }).ok).toBe(true);
  });

  it('marca cada campo mal escrito sin redondear nada', () => {
    const result = check({ lines: [line({ description: '', quantity: '1,2345', unitPrice: '12,345', discount: '120', accountId: 'x' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.lines[0]).toMatchObject({
      description: expect.any(String),
      quantity: expect.stringMatching(/Cantidad/),
      unitPrice: expect.stringMatching(/Precio/),
      discount: expect.stringMatching(/Descuento/),
      accountId: expect.stringMatching(/cuenta/),
    });
  });

  it('exige la cuenta en cada línea con contenido', () => {
    expect(check({ lines: [line({ accountId: '' })] }).errors.lines[0].accountId).toMatch(/cuenta/);
  });

  it('valida las retenciones: nombre, cuenta y tarifa', () => {
    const result = check({ withholdings: [rete({ name: '', accountId: 'x', rate: '0' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.withholdings[0]).toMatchObject({ name: expect.any(String), accountId: expect.any(String), rate: expect.any(String) });
  });

  it('retener todo deja la factura sin valor por pagar y no se envía', () => {
    const result = check({ withholdings: [rete({ rate: '100' }), rete({ name: 'ReteIVA', accountId: '236701', basis: 'vat', rate: '100' })] });
    expect(result.ok).toBe(false);
    expect(result.errors.form).toContain('Las retenciones no pueden dejar la factura sin valor por pagar.');
  });

  it('un total en cero no se registra', () => {
    expect(check({ lines: [line({ unitPrice: '0' })] }).errors.form).toContain('El total debe ser mayor que cero.');
  });
});
