import { describe, expect, it } from 'vitest';
import { blankBudgetLine, pctText, spreadYear, toForm, validateBudget, varianceTone, ytdRange } from './planning.js';

const line = (patch = {}, months = {}) => ({ ...blankBudgetLine(), ...patch, months: Array.from({ length: 12 }, (_, k) => months[k] ?? '') });
const codes = new Set(['413505', '519595']);

describe('formulario de presupuesto', () => {
  it('arma el cuerpo: mes vacío es cero, línea vacía se ignora', () => {
    const r = validateBudget([line({ accountId: '413505' }, { 0: '1.000,00', 2: '500,50' }), blankBudgetLine()], 'COP', codes);
    expect(r.ok).toBe(true);
    expect(r.body.lines).toEqual([{ accountId: '413505', months: [100_000, 0, 50_050, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
  });

  it('lleva el centro de costo cuando se elige', () => {
    expect(validateBudget([line({ accountId: '519595', costCenter: 'NORTE' }, { 0: '1' })], 'COP', codes).body.lines[0]).toMatchObject({ costCenter: 'NORTE' });
  });

  it('señala cuenta, importes y repetidas', () => {
    const r = validateBudget([line({ accountId: '' }, { 0: '1' }), line({ accountId: '413505' }, { 1: 'abc', 2: '-5' }), line({ accountId: '111005' }, { 0: '1' }), line({ accountId: '413505' }, { 0: '1' })], 'COP', codes);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      'Línea 1: indica la cuenta.',
      'Línea 2, Feb: importe no válido.',
      'Línea 2, Mar: importe no válido.',
      'Línea 3: la cuenta 111005 no es de ingresos, costos o gastos.',
      'Línea 4: la cuenta 413505 se repite.',
    ]);
    expect(validateBudget([blankBudgetLine()], 'COP', codes).errors).toEqual(['Agrega al menos una línea con importes.']);
  });

  it('muestra las líneas del servidor como texto', () => {
    const rows = toForm([{ accountId: '413505', costCenter: null, months: [100_000, 0, 50_050, ...Array(9).fill(0)] }], (n) => String(n / 100));
    expect(rows[0].months.slice(0, 3)).toEqual(['1000', '', '500.5']);
    expect(rows[0].costCenter).toBe('');
  });
});

describe('repartir un año', () => {
  it('doce partes que suman exacto, el residuo a los primeros meses', () => {
    const parts = spreadYear('1.000,00', 'COP');
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(parts.slice(0, 5)).toEqual([8334, 8334, 8334, 8334, 8333]);
    expect(spreadYear('abc', 'COP')).toBeNull();
    expect(spreadYear('', 'COP')).toEqual(Array(12).fill(0));
  });
});

describe('lectura de la ejecución', () => {
  it('formatea el porcentaje y colorea según el tipo de cuenta', () => {
    expect(pctText(500)).toBe('+5,0 %');
    expect(pctText(-3750)).toBe('-37,5 %');
    expect(pctText(null)).toBe('—');
    expect(varianceTone('income', 100)).toBe('good');
    expect(varianceTone('expense', 100)).toBe('bad');
    expect(varianceTone('expense', -100)).toBe('good');
    expect(varianceTone('cost', 0)).toBe('neutral');
  });

  it('el rango del año va de enero al mes actual', () => {
    expect(ytdRange('2026-10-22')).toEqual({ from: '2026-01', to: '2026-10' });
  });
});
