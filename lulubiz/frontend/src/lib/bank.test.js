import { describe, expect, it } from 'vitest';
import { CHUNK, chunk, differenceText, parseSignedAmount, parseStatement, parseStatementDate } from './bank.js';

describe('importe de una celda del extracto', () => {
  it('lee signos, paréntesis, símbolos y separadores es-CO', () => {
    expect(parseSignedAmount('1.250.000,50', 'COP')).toBe(125_000_050);
    expect(parseSignedAmount('-5.000,00', 'COP')).toBe(-500_000);
    expect(parseSignedAmount('(5.000,00)', 'COP')).toBe(-500_000);
    expect(parseSignedAmount('5.000,00-', 'COP')).toBe(-500_000);
    expect(parseSignedAmount('$ 1.000', 'COP')).toBe(100_000);
    expect(parseSignedAmount('+200,5', 'COP')).toBe(20_050);
    expect(parseSignedAmount('', 'COP')).toBe(0);
  });

  it('con punto decimal intercambia los separadores', () => {
    expect(parseSignedAmount('1,250,000.50', 'COP', 'dot')).toBe(125_000_050);
    expect(parseSignedAmount('-5000.00', 'COP', 'dot')).toBe(-500_000);
  });

  it('devuelve null si no se entiende', () => {
    expect(parseSignedAmount('abc', 'COP')).toBeNull();
    expect(parseSignedAmount('1.00.0', 'COP')).toBeNull();
    expect(parseSignedAmount('10,555', 'COP')).toBeNull();
  });
});

describe('fecha de una celda del extracto', () => {
  it('acepta año primero y día primero, y rechaza fechas que no existen', () => {
    expect(parseStatementDate('2026-10-05')).toBe('2026-10-05');
    expect(parseStatementDate('05/10/2026')).toBe('2026-10-05');
    expect(parseStatementDate('5-1-2026')).toBe('2026-01-05');
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('hoy')).toBeNull();
  });
});

describe('extracto en CSV', () => {
  const header = ['Fecha', 'Descripción', 'Referencia', 'Valor'];

  it('convierte filas con una columna de valor con signo', () => {
    const rows = [
      ['05/10/2026', 'Consignación cliente', 'R-1', '1.000.000,00'],
      ['06/10/2026', 'Comisión', '', '-5.000,00'],
    ];
    const r = parseStatement(header, rows, { currency: 'COP' });
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { date: '2026-10-05', description: 'Consignación cliente', reference: 'R-1', amount: 100_000_000 },
      { date: '2026-10-06', description: 'Comisión', amount: -500_000 },
    ]);
  });

  it('con columnas de ingreso y egreso, el egreso resta', () => {
    const r = parseStatement(['Fecha', 'Concepto', 'Débito', 'Crédito'], [['2026-10-05', 'Pago a proveedor', '2.000,00', ''], ['2026-10-06', 'Abono', '', '3.000,00']], { currency: 'COP' });
    expect(r.lines.map((l) => l.amount)).toEqual([-200_000, 300_000]);
  });

  it('señala las filas con error sin perder las buenas', () => {
    const rows = [
      ['32/10/2026', 'Mala fecha', '', '1.000,00'],
      ['05/10/2026', 'Sin valor', '', '0'],
      ['05/10/2026', 'Importe raro', '', '1.0.0'],
      ['05/10/2026', '', '', '1.000,00'],
      ['05/10/2026', 'Buena', '', '1.000,00'],
    ];
    const r = parseStatement(header, rows, { currency: 'COP' });
    expect(r.lines).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
  });

  it('avisa de las columnas que faltan', () => {
    expect(parseStatement(['Fecha', 'Descripción'], [['2026-10-05', 'x']], { currency: 'COP' }).missing).toEqual(['valor (o las dos columnas entra y sale)']);
    expect(parseStatement(['Descripción', 'Valor'], [['x', '1']], { currency: 'COP' }).missing).toEqual(['fecha']);
  });
});

describe('utilidades', () => {
  it('parte en lotes del tamaño del servidor', () => {
    expect(CHUNK).toBe(500);
    expect(chunk(Array.from({ length: 1201 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunk([])).toEqual([]);
  });

  it('explica la diferencia', () => {
    const f = (n) => `$${n}`;
    expect(differenceText(0, f)).toBe('La conciliación cuadra.');
    expect(differenceText(7000, f)).toMatch(/diferencia de \$7000/);
    expect(differenceText(-7000, f)).toMatch(/libro más lo pendiente del banco supera/);
  });
});
