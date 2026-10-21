import { describe, expect, it } from 'vitest';
import { resultLabel, validateYearClose, yearOptions } from './yearEnd.js';

describe('cierre de ejercicio: formulario', () => {
  it('lista los años del actual hacia atrás', () => {
    expect(yearOptions('2026-10-21', 3)).toEqual([2026, 2025, 2024]);
  });
  it('arma el cuerpo y omite la cuenta de pérdida vacía', () => {
    expect(validateYearClose({ year: 2025, currency: 'cop', profitAccount: ' 360505 ', lossAccount: '' }).body).toEqual({ year: 2025, currency: 'COP', profitAccount: '360505' });
    expect(validateYearClose({ year: 2025, currency: 'COP', profitAccount: '360505', lossAccount: '360510' }).body.lossAccount).toBe('360510');
  });
  it('exige año, moneda y cuenta de utilidad, y que la de pérdida sea un código', () => {
    const r = validateYearClose({ year: NaN, currency: 'PESOS', profitAccount: 'abc', lossAccount: 'x' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['currency', 'lossAccount', 'profitAccount', 'year']);
  });
  it('nombra el resultado', () => {
    expect([500, -5, 0].map(resultLabel)).toEqual(['Utilidad', 'Pérdida', 'Sin resultado']);
  });
});
