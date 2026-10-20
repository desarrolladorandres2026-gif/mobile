import { describe, expect, it } from 'vitest';
import { validateJournal } from './Journals.jsx';

const accountsByCode = new Map([
  ['110505', { code: '110505', name: 'Caja' }],
  ['413505', { code: '413505', name: 'Ventas' }],
]);
const line = (accountId, debit = '', credit = '') => ({ accountId, debit, credit, description: '' });
const check = (lines, date = '2026-10-15') => validateJournal({ date, lines, currency: 'COP', accountsByCode });

describe('validación del asiento antes de enviarlo', () => {
  it('acepta un asiento cuadrado y arma las líneas en unidades menores', () => {
    const result = check([line('110505', '1.190,50'), line('413505', '', '1.190,50')]);
    expect(result.ok).toBe(true);
    expect(result.prepared).toEqual([
      { accountId: '110505', debit: 119050 },
      { accountId: '413505', credit: 119050 },
    ]);
    expect(result.debits).toBe(result.credits);
  });

  it('ignora las líneas en blanco', () => {
    const result = check([line('110505', '100'), line('', '', ''), line('413505', '', '100')]);
    expect(result.ok).toBe(true);
    expect(result.prepared).toHaveLength(2);
  });

  it('rechaza un asiento descuadrado y dice por cuánto', () => {
    const result = check([line('110505', '100'), line('413505', '', '99')]);
    expect(result.ok).toBe(false);
    expect(result.errors.form.join(' ')).toMatch(/no cuadra/);
    expect(result.debits - result.credits).toBe(100);
  });

  it('rechaza cuentas desconocidas o de agrupación', () => {
    const result = check([line('110505', '100'), line('999999', '', '100')]);
    expect(result.ok).toBe(false);
    expect(result.errors.lines[1].accountId).toMatch(/admita asientos/);
  });

  it('rechaza una línea con débito y crédito a la vez, o sin ninguno', () => {
    expect(check([line('110505', '100', '100'), line('413505', '', '100')]).errors.lines[0].debit).toMatch(/no ambos/);
    expect(check([line('110505', '', ''), line('413505', '', '100')]).ok).toBe(false);
    expect(check([line('110505', '0', ''), line('413505', '', '100')]).errors.lines[0].debit).toMatch(/no ambos/);
  });

  it('rechaza importes mal escritos sin redondear nada', () => {
    const result = check([line('110505', '10,555'), line('413505', '', '10,555')]);
    expect(result.ok).toBe(false);
    expect(result.errors.lines[0].debit).toMatch(/no válido/);
  });

  it('exige fecha y al menos dos líneas con importe', () => {
    expect(check([line('110505', '100'), line('413505', '', '100')], '').errors.form.join(' ')).toMatch(/fecha/);
    const solo = check([line('110505', '100')]);
    expect(solo.ok).toBe(false);
    expect(solo.errors.form.join(' ')).toMatch(/al menos dos líneas/);
  });

  it('un asiento vacío no es válido', () => {
    expect(check([line(''), line('')]).ok).toBe(false);
  });
});
