import { describe, expect, it } from 'vitest';
import { parseCifra, parseFecha, parsePorcentaje, sheetName, tableName, uniqueHeaders, workbookEntries } from './workbook.js';
import { zipStore } from './zip.js';

const NOW = new Date(2026, 9, 23, 15, 30);
const columns = [
  { title: 'Cuenta', type: 'text' },
  { title: 'Débitos', type: 'amount' },
  { title: 'Créditos', type: 'amount' },
];
const parts = (spec) => Object.fromEntries(workbookEntries({ title: 'Balance de prueba', company: { name: 'Acme & Cía', taxIdLabel: 'NIT 900.123.456-7' }, columns, now: NOW, ...spec }));

describe('lectura de valores', () => {
  it('lee cifras con formato colombiano y deja como texto lo que no lo es', () => {
    expect(parseCifra('1.190.000,50')).toEqual({ value: 1190000.5, decimals: 2 });
    expect(parseCifra('-2.500')).toEqual({ value: -2500, decimals: 0 });
    expect(parseCifra('FV-0001')).toBeNull();
    expect(parseCifra('900.123.456-7')).toBeNull();
  });
  it('convierte fechas dd/mm/aaaa a serie de Excel y rechaza días que no existen', () => {
    expect(parseFecha('01/01/2026')).toBe(46023);
    expect(parseFecha('31/02/2026')).toBeNull();
    expect(parseFecha('2026-01-01')).toBeNull();
  });
  it('convierte porcentajes', () => {
    expect(parsePorcentaje('19 %')).toBeCloseTo(0.19);
    expect(parsePorcentaje('2,5%')).toBeCloseTo(0.025);
    expect(parsePorcentaje('19')).toBeNull();
  });
});

describe('nombres', () => {
  it('cabeceras únicas y no vacías', () => {
    expect(uniqueHeaders(['Total', 'total', '', 'Total'])).toEqual(['Total', 'total 2', 'Columna 3', 'Total 3']);
  });
  it('nombre de tabla y de hoja válidos', () => {
    expect(tableName('Balance de prueba (año)')).toBe('T_Balance_de_prueba_ano');
    expect(sheetName('Ventas: enero/febrero [2026]')).toBe('Ventas enero febrero 2026');
    expect(sheetName('Información')).toBe('Datos');
  });
});

describe('workbookEntries', () => {
  const body = [
    { kind: 'body', depth: 0, cells: ['1105 Caja', '1.000,00', '0,00'] },
    { kind: 'body', depth: 0, cells: ['4135 Ventas', '0,00', '1.000,00'] },
  ];

  it('con un total que cuadra: Tabla nativa con fila de totales y SUBTOTAL', () => {
    const p = parts({ rows: [...body, { kind: 'total', depth: 0, cells: ['Totales', '1.000,00', '1.000,00'] }] });
    const sheet = p['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<f>SUBTOTAL(109,B6:B7)</f><v>1000</v>');
    expect(sheet).toContain('<tableParts count="1">');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('Acme &amp; Cía');
    expect(sheet).toContain('&amp;L&amp;8 Acme &amp;&amp; Cía'); // «&» duplicado en el pie de página
    const table = p['xl/tables/table1.xml'];
    expect(table).toContain('ref="A5:C8"');
    expect(table).toContain('totalsRowCount="1"');
    expect(table).toContain('<autoFilter ref="A5:C7"/>');
    expect(table).toContain('totalsRowLabel="Totales"');
    expect(table).toContain('<totalsRowFormula>SUBTOTAL(109,C6:C7)</totalsRowFormula>');
    expect(p['xl/worksheets/sheet2.xml']).toContain('Con fórmula SUBTOTAL');
  });

  it('con un total que no es la suma de las filas: valor fijo, nunca una fórmula que contradiga el informe', () => {
    const p = parts({ rows: [...body, { kind: 'total', depth: 0, cells: ['Totales', '9.999,00', '1.000,00'] }] });
    const sheet = p['xl/worksheets/sheet1.xml'];
    expect(sheet).not.toContain('SUBTOTAL(109,B');
    expect(sheet).toContain('SUBTOTAL(109,C6:C7)');
    expect(p['xl/worksheets/sheet2.xml']).toContain('Copiados del informe tal como se mostraron (no son una suma simple de las filas): Débitos');
  });

  it('la jerarquía va como esquema plegable y sangría', () => {
    const p = parts({
      rows: [
        { kind: 'group', depth: 0, cells: ['11 Disponible', '1.000,00', '0,00'] },
        { kind: 'body', depth: 1, cells: ['1105 Caja', '1.000,00', '0,00'] },
      ],
    });
    const sheet = p['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<row r="7" outlineLevel="1">');
    expect(sheet).toContain('outlineLevelRow="1"');
    expect(sheet).toContain('<outlinePr summaryBelow="0"/>');
    expect(p['xl/styles.xml']).toContain('indent="1"');
  });

  it('sin Tabla nativa si hay totales intermedios: rango con filtro', () => {
    const p = parts({
      rows: [body[0], { kind: 'total', depth: 0, cells: ['Subtotal', '1.000,00', '0,00'] }, body[1]],
    });
    expect(p['xl/tables/table1.xml']).toBeUndefined();
    expect(p['xl/worksheets/sheet1.xml']).toContain('<autoFilter ref="A5:C8"/>');
    expect(p['xl/workbook.xml']).toContain('_xlnm._FilterDatabase');
  });

  it('fechas como fecha real, porcentajes como número y textos raros escapados', () => {
    const p = parts({
      columns: [
        { title: 'Fecha', type: 'date' },
        { title: 'Tarifa', type: 'percent' },
        { title: 'Nota', type: 'text' },
      ],
      rows: [{ kind: 'body', depth: 0, cells: ['01/01/2026', '19 %', '<b>"hola"</b>'] }],
    });
    const sheet = p['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<v>46023</v>');
    expect(sheet).toContain('<v>0.19</v>');
    expect(sheet).toContain('&lt;b&gt;&quot;hola&quot;&lt;/b&gt;');
  });

  it('el libro trae hoja de información, propiedades e impresión con títulos repetidos', () => {
    const p = parts({ rows: body, user: 'ana@acme.co', currency: 'COP', info: { period: 'Enero de 2026 a Marzo de 2026', filters: [['Cuenta', '1105 Caja'], ['Vacío', '']] } });
    expect(p['xl/workbook.xml']).toContain(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Balance de prueba'!$5:$5</definedName>`);
    expect(p['xl/workbook.xml']).toContain('<sheet name="Información" sheetId="2" r:id="rId2"/>');
    expect(p['xl/worksheets/sheet1.xml']).toContain('NIT 900.123.456-7  ·  Período Enero de 2026 a Marzo de 2026  ·  Cuenta: 1105 Caja  ·  Moneda COP');
    expect(p['xl/worksheets/sheet2.xml']).toContain('ana@acme.co');
    expect(p['xl/worksheets/sheet2.xml']).not.toContain('Vacío');
    expect(p['docProps/core.xml']).toContain('<cp:lastModifiedBy>ana@acme.co</cp:lastModifiedBy>');
    expect(p['[Content_Types].xml']).toContain('/xl/tables/table1.xml');
  });
});

describe('zipStore', () => {
  it('genera un zip con las firmas de entrada, directorio central y cierre', async () => {
    const bytes = new Uint8Array(await zipStore([['a.txt', 'hola']]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  });
});
