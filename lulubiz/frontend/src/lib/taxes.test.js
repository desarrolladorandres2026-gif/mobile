import { describe, expect, it } from 'vitest';
import { currentBimester, formatPerMil, parseAccountList, parsePerMil, validateVatClose, vatVerdict } from './taxes.js';

describe('bimestre del IVA', () => {
  it('toma el bimestre al que pertenece el mes, también en diciembre y en febrero bisiesto', () => {
    expect(currentBimester('2026-10-22')).toEqual({ from: '2026-09-01', to: '2026-10-31' });
    expect(currentBimester('2026-09-03')).toEqual({ from: '2026-09-01', to: '2026-10-31' });
    expect(currentBimester('2026-12-31')).toEqual({ from: '2026-11-01', to: '2026-12-31' });
    expect(currentBimester('2028-02-10')).toEqual({ from: '2028-01-01', to: '2028-02-29' });
  });
});

describe('resultado del IVA', () => {
  it('distingue por pagar, a favor y en cero', () => {
    expect(vatVerdict(100).kind).toBe('payable');
    expect(vatVerdict(-1).kind).toBe('credit');
    expect(vatVerdict(0).kind).toBe('zero');
  });
});

describe('cierre de IVA', () => {
  const base = { from: '2026-09-01', to: '2026-10-31', dueAccount: '', creditAccount: '' };

  it('pide la cuenta que corresponde al resultado', () => {
    expect(validateVatClose(base, 500).errors).toEqual(['Indica la cuenta de IVA por pagar a la DIAN.']);
    expect(validateVatClose(base, -500).errors).toEqual(['Indica la cuenta de saldo a favor de IVA.']);
    expect(validateVatClose({ ...base, dueAccount: '241005' }, 500)).toEqual({ ok: true, body: { from: '2026-09-01', to: '2026-10-31', dueAccount: '241005' } });
    expect(validateVatClose({ ...base, creditAccount: ' 135515 ' }, -500).body).toEqual({ from: '2026-09-01', to: '2026-10-31', creditAccount: '135515' });
    expect(validateVatClose(base, 0)).toEqual({ ok: true, body: { from: '2026-09-01', to: '2026-10-31' } });
  });

  it('valida las fechas', () => {
    expect(validateVatClose({ ...base, from: '' }, 0).errors).toEqual(['Elige las dos fechas.']);
    expect(validateVatClose({ ...base, from: '2026-11-01' }, 0).errors).toEqual(['La fecha inicial no puede ser posterior a la final.']);
  });
});

describe('tarifa del ICA', () => {
  it('pasa por mil a partes por millón con coma o punto y rechaza lo que no es una tarifa', () => {
    expect(parsePerMil('9,66')).toBe(9660);
    expect(parsePerMil('9.66')).toBe(9660);
    expect(parsePerMil(' 11,04 ')).toBe(11_040);
    expect(parsePerMil('7')).toBe(7000);
    expect(parsePerMil('0,001')).toBe(1);
    expect(parsePerMil('100')).toBe(100_000);
    for (const bad of ['', 'abc', '100,1', '101', '1,2345', '-1', '1,', null]) expect(parsePerMil(bad), String(bad)).toBeNull();
  });

  it('formatPerMil es el inverso exacto', () => {
    for (const ppm of [0, 1, 500, 7000, 9660, 11_040, 100_000]) expect(parsePerMil(formatPerMil(ppm))).toBe(ppm);
    expect(formatPerMil(9660)).toBe('9,66');
    expect(formatPerMil(7000)).toBe('7');
  });

  it('lista de cuentas: separa por coma o espacio, quita repetidas y rechaza códigos no numéricos', () => {
    expect(parseAccountList('421005, 421010 421005')).toEqual(['421005', '421010']);
    expect(parseAccountList('')).toEqual([]);
    expect(parseAccountList('4210x5')).toBeNull();
  });
});
