import { describe, expect, it } from 'vitest';
import { tableToCsv } from './exportCsv.js';

const table = (html) => {
  const el = document.createElement('table');
  el.innerHTML = html;
  return el;
};

describe('tableToCsv', () => {
  it('separa por punto y coma y cita lo que lleva separadores o comillas', () => {
    const t = table('<thead><tr><th>Cuenta</th><th>Total</th></tr></thead><tbody><tr><td>Ventas; "netas"</td><td>1.190.000,50</td></tr></tbody>');
    expect(tableToCsv(t)).toBe('Cuenta;Total\r\n"Ventas; ""netas"""' + ';1.190.000,50');
  });
  it('neutraliza celdas que Excel leería como fórmula, sin tocar las cifras negativas', () => {
    const t = table('<tbody><tr><td>=SUMA(A1)</td><td>-1.500,00</td><td>-texto</td></tr></tbody>');
    expect(tableToCsv(t)).toBe("'=SUMA(A1);-1.500,00;'-texto");
  });
  it('omite la fila de «no hay registros»', () => {
    const t = table('<tbody><tr><td colspan="3">No hay registros.</td></tr></tbody>');
    expect(tableToCsv(t)).toBe('');
  });
});
