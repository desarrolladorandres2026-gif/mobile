import { describe, expect, it } from 'vitest';
import { readTable } from './exportXlsx.js';

const table = (html) => {
  const el = document.createElement('table');
  el.innerHTML = html;
  return el;
};

describe('readTable', () => {
  it('toma el tipo de cada columna de sus marcas y deja fuera las de acciones', () => {
    const t = table(
      '<thead><tr><th data-xl-type="text">Cuenta</th><th data-xl-type="amount" class="text-right">Saldo</th><th data-xl-skip="">Acciones</th></tr></thead>' +
        '<tbody><tr><td>Caja</td><td class="text-right">1.000,00</td><td><button>Editar</button></td></tr></tbody>',
    );
    expect(readTable(t)).toEqual({
      columns: [
        { title: 'Cuenta', type: 'text' },
        { title: 'Saldo', type: 'amount' },
      ],
      rows: [{ kind: 'body', depth: 0, cells: ['Caja', '1.000,00'] }],
    });
  });

  it('lee jerarquía y totales de las marcas de fila, y reconoce un «Total» sin marca', () => {
    const t = table(
      '<thead><tr><th>Cuenta</th><th class="text-right">Importe</th></tr></thead><tbody>' +
        '<tr data-xl-kind="group"><td>11 Disponible</td><td>5,00</td></tr>' +
        '<tr data-xl-depth="2"><td>1105 Caja</td><td>5,00</td></tr>' +
        '<tr><td>Totales</td><td>5,00</td></tr></tbody>',
    );
    const { columns, rows } = readTable(t);
    expect(columns[1].type).toBe('amount');
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([
      ['group', 0],
      ['body', 2],
      ['total', 0],
    ]);
  });

  it('omite la fila de «no hay registros» y los detalles desplegados', () => {
    const t = table('<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td colspan="2">No hay registros.</td></tr></tbody>');
    expect(readTable(t).rows).toEqual([]);
  });
});
