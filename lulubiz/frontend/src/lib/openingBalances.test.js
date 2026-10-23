import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';
import { buildOpeningEntry, documentsIn, mapOpening, normalizeDocument } from './openingBalances.js';

const ctx = {
  currency: 'COP',
  accountsByCode: new Map([['110505', {}], ['130505', {}], ['310505', {}]]),
  partyByDocument: new Map([['800197268', 'p1']]),
  centerCodes: new Set(['VENTAS']),
};
const build = (csv) => {
  const { header, rows } = parseCsv(csv);
  const mapped = mapOpening(header, rows);
  return { mapped, entry: buildOpeningEntry(mapped.objects, ctx) };
};

describe('saldos iniciales', () => {
  it('arma un asiento que cuadra, con tercero y centro, aceptando nombres alternativos de columna', () => {
    const { mapped, entry } = build('Código;NIT;Debe;Haber;Centro de costo\n110505;;1.000.000,00;;\n130505;800.197.268-4;500.000,50;;VENTAS\n310505;;;1.500.000,50;');
    expect(mapped.missing).toEqual([]);
    expect(entry.errors).toEqual([]);
    expect(entry.lines).toEqual([
      { accountId: '110505', debit: 100_000_000 },
      { accountId: '130505', debit: 50_000_050, costCenter: 'VENTAS', partyId: 'p1' },
      { accountId: '310505', credit: 150_000_050 },
    ]);
    expect(entry.difference).toBe(0);
  });

  it('reporta por línea del archivo: cuenta inexistente, importe malo, ambos lados, tercero y centro desconocidos', () => {
    const { entry } = build('cuenta,documento,debito,credito,centro\n999999,,10,,\n110505,,abc,,\n110505,,10,5,\n130505,111,10,,\n130505,,10,,OTRO');
    expect(entry.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(entry.errors[0].error).toMatch(/cuenta/);
    expect(entry.errors[3].error).toMatch(/tercero/);
    expect(entry.errors[4].error).toMatch(/centro/);
  });

  it('informa la diferencia cuando no cuadra y omite filas totalmente vacías', () => {
    const { entry } = build('cuenta,debito,credito\n110505,100,\n,,\n310505,,60');
    expect(entry.errors).toEqual([]);
    expect(entry.lines).toHaveLength(2);
    expect(entry.difference).toBe(4000);
  });

  it('exige la columna cuenta y alguna de débito o crédito', () => {
    expect(build('debito,credito\n1,').mapped.missing).toEqual(['cuenta']);
    expect(build('cuenta,nombre\n110505,x').mapped.missing).toEqual(['debito o credito']);
  });

  it('rechaza más líneas de las que admite un asiento y archivos de una sola línea', () => {
    const many = ['cuenta,debito,credito', ...Array.from({ length: 501 }, (_, i) => (i % 2 ? '310505,,1' : '110505,1,'))].join('\n');
    expect(build(many).entry.errors[0].error).toMatch(/500 líneas/);
    expect(build('cuenta,debito,credito\n110505,1,').entry.errors[0].error).toMatch(/al menos dos/);
  });

  it('normaliza documentos y junta los distintos', () => {
    expect(normalizeDocument(' 890.903.938-8 ')).toBe('890903938');
    expect(normalizeDocument('cc 123')).toBe('CC123');
    const { mapped } = build('cuenta,documento,debito\n130505,800.197.268-4,1\n130505,800197268,2\n110505,,3');
    expect(documentsIn(mapped.objects)).toEqual(['800197268']);
  });
});
