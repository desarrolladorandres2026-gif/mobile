import { describe, expect, it } from 'vitest';
import { CsvError, MAX_CSV_ROWS, mapColumns, normalizeHeader, parseCsv } from './csv.js';
import { prepare, runImport } from './importer.js';

const BOM = String.fromCharCode(0xfeff);

describe('lectura de CSV', () => {
  it('lee comas, comillas, comillas dobles y saltos de línea dentro de un campo', () => {
    const { header, rows } = parseCsv('codigo,nombre\r\nA1,"Tornillo, 1/2"\r\nA2,"dice ""hola"""\nA3,"dos\nlíneas"\n');
    expect(header).toEqual(['codigo', 'nombre']);
    expect(rows).toEqual([['A1', 'Tornillo, 1/2'], ['A2', 'dice "hola"'], ['A3', 'dos\nlíneas']]);
  });

  it('detecta punto y coma y tabulador, y quita el BOM de Excel', () => {
    expect(parseCsv(`${BOM}codigo;nombre\nA1;Uno`).header).toEqual(['codigo', 'nombre']);
    expect(parseCsv('codigo\tnombre\nA1\tUno').rows).toEqual([['A1', 'Uno']]);
  });

  it('omite líneas vacías y recorta espacios', () => {
    expect(parseCsv('a,b\n\n 1 , 2 \n,\n').rows).toEqual([['1', '2']]);
  });

  it('rechaza lo que no se puede leer, con un mensaje claro', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('solo,encabezado')).toThrow(/faltan filas/);
    expect(() => parseCsv('a,b\n"sin cerrar,2')).toThrow(/comilla sin cerrar/);
    expect(() => parseCsv(`a\n${'x\n'.repeat(MAX_CSV_ROWS + 1)}`)).toThrow(/importa máximo/);
    expect(() => parseCsv(`a\n${'x'.repeat(2_000_001)}`)).toThrow(/demasiado grande/);
  });

  it('normaliza los nombres de columna', () => {
    expect(normalizeHeader(' Cuenta de Inventario ')).toBe('cuenta_de_inventario');
    expect(normalizeHeader('Dígito')).toBe('digito');
    expect(normalizeHeader('IVA (%)')).toBe('iva');
  });

  it('mapea columnas por alias, y avisa de las desconocidas y de las obligatorias que faltan', () => {
    const columns = { codigo: ['sku'], nombre: [] };
    const ok = mapColumns(['SKU', 'Nombre', 'Color'], [['A1', 'Uno', 'rojo']], columns, ['codigo', 'nombre']);
    expect(ok.objects).toEqual([{ line: 2, values: { codigo: 'A1', nombre: 'Uno' } }]);
    expect(ok.unknown).toEqual(['Color']);
    expect(ok.missing).toEqual([]);
    expect(mapColumns(['nombre'], [['x']], columns, ['codigo', 'nombre']).missing).toEqual(['codigo']);
  });
});

const items = (csv, currency = 'COP') => {
  const { header, rows } = parseCsv(csv);
  return prepare('items', header, rows, { currency });
};
const parties = (csv, defaultType = 'NIT') => {
  const { header, rows } = parseCsv(csv);
  return prepare('parties', header, rows, { defaultType });
};

describe('importar artículos', () => {
  const head = 'codigo,nombre,tipo,unidad,cuenta_inventario,cuenta_costo,cuenta_ingreso,precio,iva,minimo\n';

  it('arma el cuerpo con enteros como el formulario', () => {
    const { results } = items(`${head}tornillo-1,Tornillo 1/2,bien,caja,143505,613505,413505,"1.250,50",19,"2,5"`);
    expect(results[0]).toEqual({
      line: 2,
      body: { sku: 'tornillo-1', type: 'goods', name: 'Tornillo 1/2', unit: 'caja', inventoryAccount: '143505', cogsAccount: '613505', incomeAccount: '413505', price: 125050, vatBps: 1900, minStock: 2500 },
    });
  });

  it('un servicio no pide cuentas de inventario, y sin tipo es un bien', () => {
    const { results } = items(`${head}INSTALA,Instalación,servicio,,,,413505,50.000,19,\nA1,Sin tipo,,,143505,613505,,,,`);
    expect(results[0].body).toMatchObject({ type: 'service', incomeAccount: '413505', price: 5_000_000, vatBps: 1900 });
    expect(results[0].body).not.toHaveProperty('inventoryAccount');
    expect(results[1].body).toMatchObject({ type: 'goods', unit: 'UND' });
  });

  it('señala la fila mala con la línea del archivo y no detiene las demás', () => {
    const { results } = items(`${head}A1,Bueno,bien,und,143505,613505,,,,\n,Sin código,bien,und,143505,613505,,,,\nA3,Tipo raro,cosa,und,143505,613505,,,,\nA4,IVA malo,bien,und,143505,613505,,,veinte,\nA5,Sin cuentas,bien,und,,,,,,`);
    expect(results.map((r) => [r.line, Boolean(r.body)])).toEqual([[2, true], [3, false], [4, false], [5, false], [6, false]]);
    expect(results[1].error).toMatch(/código/);
    expect(results[2].error).toMatch(/tipo «cosa»/);
    expect(results[3].error).toMatch(/IVA «veinte»/);
    expect(results[4].error).toMatch(/cuenta de inventario/);
  });

  it('un código repetido en el archivo se rechaza en su segunda aparición, sin importar mayúsculas', () => {
    const { results } = items(`${head}A1,Uno,bien,und,143505,613505,,,,\na1,Otro,bien,und,143505,613505,,,,`);
    expect(results[0].body).toBeTruthy();
    expect(results[1]).toMatchObject({ body: null, error: expect.stringMatching(/línea 2/) });
  });

  it('acepta encabezados en inglés o con tildes y avisa si falta una columna obligatoria', () => {
    const ok = items('SKU,Nombre,Cuenta de inventario,Cuenta de costo\nA1,Uno,143505,613505');
    expect(ok.results[0].body).toBeTruthy();
    const bad = items('nombre,precio\nUno,10');
    expect(bad.missing).toEqual(['codigo']);
    expect(bad.results).toEqual([]);
  });
});

describe('importar terceros', () => {
  const head = 'nombre,tipo_documento,documento,digito,rol,correo,telefono,direccion,ciudad,departamento\n';

  it('un NIT con guion trae su dígito; sin guion se calcula; con columna se respeta', () => {
    const { results } = parties(`${head}Droguería Los Andes,NIT,800.197.268-4,,cliente,,,,,\nAseo Total,NIT,900123456,,proveedor,,,,,\nMarca,NIT,900123456,8,proveedor,,,,,`);
    expect(results[0].body).toMatchObject({ taxId: '800197268', checkDigit: 4, roles: ['customer'] });
    expect(results[1].body).toMatchObject({ taxId: '900123456', checkDigit: 8, roles: ['supplier'] });
    expect(results[2].error).toMatch(/repetido/);
  });

  it('una cédula no lleva dígito, y sin tipo se usa el predeterminado', () => {
    const { results } = parties(`${head}Ana Pérez,CC,1.075.123.456,,,ana@correo.co,3001234567,Calle 1,Garzón,Huila`);
    expect(results[0].body).toEqual({
      name: 'Ana Pérez',
      roles: ['customer'],
      taxIdType: 'CC',
      taxId: '1075123456',
      email: 'ana@correo.co',
      phone: '3001234567',
      address: { line: 'Calle 1', city: 'Garzón', region: 'Huila' },
    });
    const noType = parties('nombre,documento\nBeto,800197268', 'NIT');
    expect(noType.results[0].body).toMatchObject({ taxIdType: 'NIT', checkDigit: 4 });
  });

  it('entiende varios roles y rechaza los desconocidos', () => {
    const { results } = parties(`${head}Uno,CC,111,,ambos,,,,,\nDos,CC,222,,cliente / proveedor,,,,,\nTres,CC,333,,jefe,,,,,`);
    expect(results[0].body.roles).toEqual(['customer', 'supplier']);
    expect(results[1].body.roles).toEqual(['customer', 'supplier']);
    expect(results[2].error).toMatch(/rol «jefe»/);
  });

  it('falta nombre o documento, o el dígito del NIT no es válido', () => {
    const { results } = parties(`${head},CC,111,,,,,,,\nSin doc,CC,,,,,,,,\nNIT malo,NIT,900123456,x,,,,,,`);
    expect(results.map((r) => Boolean(r.body))).toEqual([false, false, false]);
    expect(results[0].error).toMatch(/nombre/);
    expect(results[1].error).toMatch(/documento/);
    expect(results[2].error).toMatch(/dígito/);
  });
});

describe('ejecutar la importación', () => {
  const rows = [{ line: 2, body: { sku: 'A' } }, { line: 3, body: { sku: 'B' } }, { line: 4, body: { sku: 'C' } }, { line: 5, body: { sku: 'D' } }];

  it('cuenta lo creado, lo que ya existía y lo que falló, sin detenerse', async () => {
    const seen = [];
    const post = async (body) => {
      seen.push(body.sku);
      if (body.sku === 'B') throw Object.assign(new Error('ya existe un artículo con el código B'), { code: 'DUPLICATE' });
      if (body.sku === 'C') throw Object.assign(new Error('la cuenta 999 no existe'), { code: 'VALIDATION' });
    };
    const progress = [];
    const outcome = await runImport(rows, post, (done, total) => progress.push([done, total]));
    expect(seen).toEqual(['A', 'B', 'C', 'D']);
    expect(outcome.created).toEqual([2, 5]);
    expect(outcome.existed).toEqual([{ line: 3, message: 'ya existe un artículo con el código B' }]);
    expect(outcome.failed).toEqual([{ line: 4, message: 'la cuenta 999 no existe' }]);
    expect(progress.at(-1)).toEqual([4, 4]);
  });

  it('crea en el orden del archivo, de a una', async () => {
    let running = 0;
    let maxRunning = 0;
    await runImport(rows, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    expect(maxRunning).toBe(1);
  });
});
