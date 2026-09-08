import { describe, it, expect } from 'vitest';
import { toCsv, csvFilename } from '../utils/csv';

/**
 * Generación de CSV.
 *
 * El archivo lo abre una persona en Excel, no otro programa, y ahí es donde
 * están los problemas: separadores que Excel español interpreta al revés,
 * tildes que se rompen sin BOM, y datos escritos por desconocidos que Excel
 * ejecuta si empiezan por el carácter equivocado.
 */
describe('toCsv', () => {
  const rows = [
    { nombre: 'Ana', total: 15000 },
    { nombre: 'Luis', total: 8000 },
  ];
  const columns = [
    { header: 'Nombre', value: (r: typeof rows[0]) => r.nombre },
    { header: 'Total', value: (r: typeof rows[0]) => r.total },
  ];

  it('separa por punto y coma, que es lo que espera Excel en español', () => {
    const csv = toCsv(rows, columns);
    expect(csv).toContain('"Nombre";"Total"');
    expect(csv).toContain('"Ana";"15000"');
  });

  it('abre con BOM para que las tildes no se rompan', () => {
    const csv = toCsv([{ nombre: 'Ñoño Pérez' }], [
      { header: 'Nombre', value: (r: any) => r.nombre },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Ñoño Pérez');
  });

  it('una coma dentro del dato no parte la fila', () => {
    const csv = toCsv([{ nombre: 'Donde Pepe, el de la esquina' }], [
      { header: 'Negocio', value: (r: any) => r.nombre },
    ]);
    const linea = csv.split('\r\n')[1];
    expect(linea).toBe('"Donde Pepe, el de la esquina"');
  });

  it('duplica las comillas en vez de dejarlas cerrar la celda', () => {
    const csv = toCsv([{ nombre: 'El "Mono"' }], [
      { header: 'Negocio', value: (r: any) => r.nombre },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"El ""Mono"""');
  });

  it('neutraliza las fórmulas que Excel ejecutaría', () => {
    // El dato lo escribió un desconocido al registrarse. Sin esto, abrir el
    // informe ejecuta código en la máquina de quien lo abre.
    const peligrosos = ['=1+1', '+1+1', '-1+1', '@SUM(A1)'];

    for (const valor of peligrosos) {
      const csv = toCsv([{ v: valor }], [{ header: 'V', value: (r: any) => r.v }]);
      expect(csv.split('\r\n')[1]).toBe(`"'${valor}"`);
    }

    // Con comillas dentro se aplican las dos defensas a la vez: el
    // apóstrofo delante y las comillas duplicadas.
    const conComillas = toCsv([{ v: '=HYPERLINK("http://malo")' }], [
      { header: 'V', value: (r: any) => r.v },
    ]);
    expect(conComillas.split('\r\n')[1]).toBe('"\'=HYPERLINK(""http://malo"")"');
  });

  it('un valor normal no lleva apóstrofo de más', () => {
    const csv = toCsv([{ v: 'Hamburguesa doble' }], [
      { header: 'V', value: (r: any) => r.v },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"Hamburguesa doble"');
  });

  it('nulos y ausentes salen como celda vacía, no como "undefined"', () => {
    const csv = toCsv([{ a: null, b: undefined }], [
      { header: 'A', value: (r: any) => r.a },
      { header: 'B', value: (r: any) => r.b },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"";""');
  });

  it('las fechas van en ISO, que no depende de la configuración regional', () => {
    const fecha = new Date('2026-09-07T15:30:00.000Z');
    const csv = toCsv([{ f: fecha }], [{ header: 'F', value: (r: any) => r.f }]);
    expect(csv.split('\r\n')[1]).toBe('"2026-09-07T15:30:00.000Z"');
  });

  it('sin filas deja el archivo con solo la cabecera', () => {
    const csv = toCsv([], columns);
    expect(csv).toBe('﻿"Nombre";"Total"');
  });
});

describe('csvFilename', () => {
  it('lleva la fecha para que dos descargas no se pisen', () => {
    expect(csvFilename('pedidos')).toMatch(/^pedidos-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
