import { describe, expect, it } from 'vitest';
import { suggestAllocations, validateAdvance, validateApplication } from './advances.js';

const form = (patch = {}) => ({ partyId: 'p1', date: '2026-10-21', amount: '500.000', account: '110505', currency: 'COP', ...patch });

describe('formulario de anticipo', () => {
  it('convierte el importe a unidades menores', () => {
    expect(validateAdvance(form(), { customer: true }).body).toEqual({ partyId: 'p1', date: '2026-10-21', amount: 50_000_000, account: '110505' });
    expect(validateAdvance(form({ amount: '1.250,50' }), { customer: true }).body.amount).toBe(125_050);
  });

  it('señala lo que falta, con el texto de cliente o de proveedor', () => {
    const c = validateAdvance(form({ partyId: '', amount: '0', account: 'x', date: '' }), { customer: true });
    expect(Object.keys(c.errors).sort()).toEqual(['account', 'amount', 'date', 'partyId']);
    expect(c.errors.partyId).toBe('Elige el cliente.');
    expect(c.errors.account).toMatch(/donde entra/);
    const s = validateAdvance(form({ partyId: '', account: '' }), { customer: false });
    expect(s.errors.partyId).toBe('Elige el proveedor.');
    expect(s.errors.account).toMatch(/de donde sale/);
    expect(validateAdvance(form({ amount: '' }), { customer: true }).ok).toBe(false);
    expect(validateAdvance(form({ amount: '1,234' }), { customer: true }).ok).toBe(false);
  });
});

describe('sugerir cómo aplicar', () => {
  const docs = [{ _id: 'a', balance: 30_000 }, { _id: 'b', balance: 50_000 }, { _id: 'c', balance: 70_000 }];
  it('reparte en el orden recibido sin pasarse del saldo de cada documento', () => {
    expect(suggestAllocations(60_000, docs, 'COP')).toEqual({ a: '300,00', b: '300,00' });
    expect(suggestAllocations(1_000_000, docs, 'COP')).toEqual({ a: '300,00', b: '500,00', c: '700,00' });
    expect(suggestAllocations(0, docs, 'COP')).toEqual({});
  });
});

describe('formulario de aplicación', () => {
  const docs = [{ _id: 'a', balance: 30_000 }, { _id: 'b', balance: 50_000 }];
  const check = (amounts, available = 60_000) => validateApplication({ date: '2026-10-21', amounts, documents: docs, available, currency: 'COP' });

  it('arma las asignaciones y lo que queda', () => {
    const r = check({ a: '200', b: '300' });
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ date: '2026-10-21', allocations: [{ documentId: 'a', amount: 20_000 }, { documentId: 'b', amount: 30_000 }] });
    expect(r.total).toBe(50_000);
    expect(r.remaining).toBe(10_000);
  });

  it('rechaza pasarse del saldo del documento o del anticipo, y un importe mal escrito', () => {
    expect(check({ a: '301' }).errors.documents.a).toMatch(/Solo debe/);
    expect(check({ a: 'x' }).errors.documents.a).toMatch(/no válido/);
    const over = check({ a: '300', b: '500' }, 60_000);
    expect(over.ok).toBe(false);
    expect(over.errors.form.join(' ')).toMatch(/solo tiene/);
  });

  it('exige aplicar algo y una fecha', () => {
    expect(check({}).errors.form).toContain('Escribe cuánto aplicar al menos a un documento.');
    expect(validateApplication({ date: '', amounts: { a: '100' }, documents: docs, available: 60_000, currency: 'COP' }).errors.form).toContain('Elige la fecha.');
  });
});
